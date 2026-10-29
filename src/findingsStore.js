// Scan results per tool: the latest run (what the dashboard shows) plus a
// snapshot of every run and a small index of per-run counts, so trends and
// "what changed" can be seen far back in time.
//
// Where it is kept: an Azure Storage blob container when STORAGE_ACCOUNT_URL is
// set (Settings or .env), reached with an Entra token (managed identity, no
// account keys); otherwise files under DATA_DIR. Every tenant has its own
// place: the home tenant uses STORAGE_CONTAINER (or DATA_DIR itself), each
// customer tenant the container <STORAGE_CONTAINER>-<key> (or
// DATA_DIR/tenants/<key>), so one customer's data never shares a file with
// another's and removing a customer is deleting its container
// (deleteTenantStore, from Settings). Same layout in each:
//   findings/<tool>.json            latest run (plus `error` when the last scan failed)
//   history/<tool>/index.json       [{ ranAt, count, added, resolved, byKind }]
//   history/<tool>/<ranAt>.json     full snapshot of that run
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { DATA_DIR } = require("./paths");
const settings = require("./settings");
const { getCredential } = require("./credentials");
const tenantContext = require("./tenantContext");

const STORAGE_TOOL_ID = "history-storage"; // its own identity override in Settings
const BLOB_API_VERSION = "2021-08-06";
// A storage call that hangs must not hold a page (or a scan) forever.
const BLOB_TIMEOUT_MS = 30000;

function retentionDays() {
  return Number(settings.get("HISTORY_RETENTION_DAYS")) || 365;
}

// --- Backends: get(key) -> parsed JSON or null, put(key, obj), del(key) ---

// Keys are built from tool IDs, run times and subscription IDs; refuse any
// that could step out of the store (.., backslashes, absolute paths).
function checkKey(key) {
  if (typeof key !== "string" || !/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(key) || key.split("/").some((p) => p === ".." || p === ".")) {
    throw new Error("history storage: invalid key");
  }
  return key;
}

function fileBackend(root) {
  return {
    name: "file",
    async get(key) {
      const file = path.join(root, checkKey(key));
      try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {
        return null;
      }
    },
    async put(key, obj) {
      const file = path.join(root, checkKey(key));
      // Through a temp file and a rename: a crash mid-write keeps the old file.
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(obj));
      try {
        fs.renameSync(tmp, file);
      } catch (err) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
    },
    async del(key) {
      try {
        fs.unlinkSync(path.join(root, checkKey(key)));
      } catch {
        // already gone
      }
    },
  };
}

function blobBackend(accountUrl, container, tenantKey) {
  const base = `${accountUrl.replace(/\/$/, "")}/${container}`;
  let containerChecked = false;

  async function headers(extra) {
    const token = await getCredential(STORAGE_TOOL_ID).getToken("https://storage.azure.com/.default");
    return { Authorization: `Bearer ${token.token}`, "x-ms-version": BLOB_API_VERSION, ...extra };
  }

  function fail(op, key, resp) {
    const code = resp.headers["x-ms-error-code"] || resp.status;
    const hint =
      resp.status === 403
        ? " (give the dashboard's identity Storage Blob Data Contributor on the storage account)"
        : "";
    return new Error(`history storage: ${op} ${key} failed: ${code}${hint}`);
  }

  async function ensureContainer() {
    if (containerChecked) return;
    const resp = await axios.put(`${base}?restype=container`, null, {
      headers: await headers(),
      timeout: BLOB_TIMEOUT_MS,
      validateStatus: () => true,
    });
    if (resp.status >= 300 && resp.status !== 409) throw fail("create container", container, resp);
    containerChecked = true;
  }

  return {
    name: "blob",
    async get(key) {
      checkKey(key);
      const resp = await axios.get(`${base}/${key}`, {
        headers: await headers(),
        timeout: BLOB_TIMEOUT_MS,
        validateStatus: () => true,
        responseType: "text",
        transformResponse: (d) => d,
      });
      if (resp.status === 404) return null;
      if (resp.status >= 300) throw fail("read", key, resp);
      try {
        return JSON.parse(resp.data);
      } catch {
        return null;
      }
    },
    async put(key, obj) {
      checkKey(key);
      const body = JSON.stringify(obj);
      const send = async () =>
        axios.put(`${base}/${key}`, body, {
          headers: await headers({ "x-ms-blob-type": "BlockBlob", "Content-Type": "application/json" }),
          timeout: BLOB_TIMEOUT_MS * 2,
          validateStatus: () => true,
          maxBodyLength: Infinity,
        });
      let resp = await send();
      if (resp.status === 404 && resp.headers["x-ms-error-code"] === "ContainerNotFound") {
        // A customer removed while this ran: its container must not come back.
        if (!exists(tenantKey)) throw new Error(`history storage: tenant "${tenantKey}" no longer exists, nothing written`);
        await ensureContainer();
        resp = await send();
      }
      if (resp.status >= 300) throw fail("write", key, resp);
    },
    async del(key) {
      checkKey(key);
      const resp = await axios.delete(`${base}/${key}`, { headers: await headers(), timeout: BLOB_TIMEOUT_MS, validateStatus: () => true });
      if (resp.status >= 300 && resp.status !== 404) throw fail("delete", key, resp);
    },
  };
}

const HOME = tenantContext.HOME;
const baseContainer = () => settings.get("STORAGE_CONTAINER") || "dashboard";

// A customer's container: <base>-<key>, within the blob naming rules
// (lowercase letters, digits and single hyphens, 3-63 characters). Terraform
// builds the same name.
function containerName(tenantKey) {
  const base = baseContainer();
  if (!tenantKey || tenantKey === HOME) return base;
  return `${base}-${tenantKey}`.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 63).replace(/-+$/, "");
}

// Blob backends are kept so each container is only checked once.
const blobBackends = new Map();

// Picked on every call, so changing the setting needs no restart. tenantKey
// defaults to the tenant of the work in progress (tenantContext).
function backend(tenantKey) {
  const key = tenantKey || (tenantContext.current() && tenantContext.current().key) || HOME;
  const url = settings.get("STORAGE_ACCOUNT_URL");
  if (!url) return fileBackend(key === HOME ? DATA_DIR : path.join(DATA_DIR, "tenants", key));
  // Also for a value from .env or saved before the check existed: the storage token goes nowhere else.
  if (!settings.STORAGE_URL_RE.test(url)) throw new Error("history storage: STORAGE_ACCOUNT_URL must look like https://<account>.blob.core.windows.net");
  const id = `${url}|${containerName(key)}`;
  if (!blobBackends.has(id)) blobBackends.set(id, blobBackend(url, containerName(key), key));
  return blobBackends.get(id);
}

function where() {
  const url = settings.get("STORAGE_ACCOUNT_URL");
  return url
    ? { backend: "blob", location: `${url.replace(/\/$/, "")}/${baseContainer()}`, customers: `${baseContainer()}-<tenant key>` }
    : { backend: "file", location: DATA_DIR, customers: path.join(DATA_DIR, "tenants", "<tenant key>") };
}

// Whether a tenant still exists. Writes for one that does not (removed while
// a scan was running) are dropped, so its store is never made again. Looked up
// late: tenants.js is loaded after this module.
function exists(tenantKey) {
  return tenantKey === HOME || Boolean(require("./tenants").byKey(tenantKey));
}

// Deletes a customer tenant's whole store, with no copy kept: the blob
// container (results, history, accepted findings, cost history, savings) or
// the folder under DATA_DIR/tenants. Never the home tenant's. Returns where it
// was and whether there was anything.
async function deleteTenantStore(tenantKey) {
  const key = String(tenantKey || "").toLowerCase();
  if (!key || key === HOME) throw new Error("history storage: the home tenant's store is never deleted");
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(key)) throw new Error("history storage: invalid tenant key");
  const url = settings.get("STORAGE_ACCOUNT_URL");
  if (!url) {
    const dir = path.join(DATA_DIR, "tenants", key);
    const existed = fs.existsSync(dir);
    fs.rmSync(dir, { recursive: true, force: true });
    return { backend: "file", where: dir, existed };
  }
  if (!settings.STORAGE_URL_RE.test(url)) throw new Error("history storage: STORAGE_ACCOUNT_URL must look like https://<account>.blob.core.windows.net");
  const container = containerName(key);
  blobBackends.delete(`${url}|${container}`);
  const token = await getCredential(STORAGE_TOOL_ID).getToken("https://storage.azure.com/.default");
  const resp = await axios.delete(`${url.replace(/\/$/, "")}/${container}?restype=container`, {
    headers: { Authorization: `Bearer ${token.token}`, "x-ms-version": BLOB_API_VERSION },
    timeout: BLOB_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (resp.status === 404) return { backend: "blob", where: container, existed: false };
  if (resp.status >= 300) {
    const code = resp.headers["x-ms-error-code"] || resp.status;
    const hint = resp.status === 403 ? " (give the dashboard's identity Storage Blob Data Contributor on the storage account)" : "";
    throw new Error(`history storage: delete container ${container} failed: ${code}${hint}`);
  }
  return { backend: "blob", where: container, existed: true };
}

// --- Keys and diffs ---

const latestKey = (toolId) => `findings/${toolId}.json`;
const indexKey = (toolId) => `history/${toolId}/index.json`;
const runKey = (toolId, ranAt) => `history/${toolId}/${ranAt.replace(/[:.]/g, "-")}.json`;

// Customer-tenant findings carry `tenant`; home ones do not, so their keys
// stay what they were before tenants existed.
const tenantOf = (f) => (f && f.tenant) || HOME;

function findingKey(f) {
  const key = f.id ? `${f.kind || ""}|${f.id}` : `${f.kind || ""}|${f.name || ""}|${f.detail || ""}`;
  return f.tenant ? `${f.tenant}|${key}` : key;
}

function countByKind(findings) {
  const out = {};
  for (const f of findings) out[f.kind || "other"] = (out[f.kind || "other"] || 0) + 1;
  return out;
}

function diff(previous, current) {
  const before = new Map((previous || []).map((f) => [findingKey(f), f]));
  const after = new Map((current || []).map((f) => [findingKey(f), f]));
  return {
    added: [...after].filter(([k]) => !before.has(k)).map(([, f]) => f),
    resolved: [...before].filter(([k]) => !after.has(k)).map(([, f]) => f),
  };
}

// One write at a time per tool, so two runs cannot lose each other's index entry.
const locks = new Map();
function withLock(toolId, fn) {
  const prev = locks.get(toolId) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(toolId, next);
  return next;
}

// A finding belongs to the tenant whose store holds it, whatever it says itself.
function stamp(k, findings) {
  for (const f of findings || []) {
    if (k === HOME) delete f.tenant;
    else f.tenant = k;
  }
  return findings || [];
}

// --- Public API ---

async function writeTenant(toolId, tenantKey, findings, ranAt) {
  return withLock(`${toolId}|${tenantKey}`, async () => {
    const store = backend(tenantKey);
    const previous = (await store.get(latestKey(toolId))) || { findings: [] };
    const prevFindings = previous.findings || [];

    // firstSeen carries over from the previous run, so a finding's age is known.
    const seen = new Map(prevFindings.map((f) => [findingKey(f), f.firstSeen || previous.ranAt]));
    for (const f of findings) f.firstSeen = seen.get(findingKey(f)) || ranAt;

    const { added, resolved } = diff(prevFindings, findings);
    const payload = { ranAt, findings };
    await store.put(runKey(toolId, ranAt), payload);
    await store.put(latestKey(toolId), payload);

    const cutoff = Date.now() - retentionDays() * 24 * 60 * 60 * 1000;
    const index = (await store.get(indexKey(toolId))) || [];
    index.push({ ranAt, count: findings.length, added: added.length, resolved: resolved.length, byKind: countByKind(findings) });
    const keep = index.filter((e) => new Date(e.ranAt).getTime() >= cutoff);
    for (const old of index.filter((e) => new Date(e.ranAt).getTime() < cutoff)) {
      await store.del(runKey(toolId, old.ranAt)).catch(() => {});
    }
    await store.put(indexKey(toolId), keep);
    // newFindings: what turned up since the last run (none on a tool's first
    // run in this tenant, where everything would count as new).
    return { added: added.length, resolved: resolved.length, newFindings: previous.ranAt ? added : [] };
  });
}

// A failed scan keeps the tenant's last results and notes the error on them
// until the next scan of that tenant succeeds.
async function writeTenantError(toolId, tenantKey, at, message) {
  if (!exists(tenantKey)) return;
  return withLock(`${toolId}|${tenantKey}`, async () => {
    const store = backend(tenantKey);
    const latest = (await store.get(latestKey(toolId))) || { ranAt: null, findings: [] };
    latest.error = { at, error: message };
    await store.put(latestKey(toolId), latest);
  });
}

// findings: this run's findings of every tenant it covered (customer ones
// carry `tenant`). opts.tenants: the tenants the run covered (default: the
// home tenant plus any tenant a finding names). opts.errors: { tenantKey:
// message } for tenants that failed. Each tenant is written to its own store,
// all with the same ranAt. A tenant removed while the scan ran gets nothing.
async function write(toolId, findings, opts = {}) {
  const ranAt = new Date().toISOString();
  const groups = new Map();
  for (const f of findings) {
    const k = tenantOf(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const keys = (opts.tenants || [...new Set([HOME, ...groups.keys()])]).filter(exists);
  let added = 0;
  let resolved = 0;
  const newByTenant = {};
  for (const k of keys) {
    const r = await writeTenant(toolId, k, groups.get(k) || [], ranAt);
    added += r.added;
    resolved += r.resolved;
    if (r.newFindings.length) newByTenant[k] = r.newFindings;
  }
  for (const [k, message] of Object.entries(opts.errors || {})) await writeTenantError(toolId, k, ranAt, message);
  return { ranAt, added, resolved, newByTenant };
}

// The latest results of these tenants together. ranAt is the newest of them;
// tenantErrors holds each tenant whose last scan (or whose store) failed.
async function read(toolId, keys = [HOME]) {
  const out = { ranAt: null, findings: [], tenantErrors: {} };
  const parts = await Promise.all(
    keys.map(async (k) => {
      try {
        return [k, await backend(k).get(latestKey(toolId)), null];
      } catch (err) {
        return [k, null, err];
      }
    })
  );
  for (const [k, latest, err] of parts) {
    if (err) out.tenantErrors[k] = { at: null, error: err.message };
    if (!latest) continue;
    if (latest.ranAt && (!out.ranAt || latest.ranAt > out.ranAt)) out.ranAt = latest.ranAt;
    out.findings.push(...stamp(k, latest.findings));
    if (latest.error) out.tenantErrors[k] = latest.error;
  }
  return out;
}

async function readIndex(toolId, k) {
  try {
    return (await backend(k).get(indexKey(toolId))) || [];
  } catch {
    return [];
  }
}

// Per-run counts over these tenants, oldest first. A tenant that was not part
// of a run (it failed, or a run for one customer only) counts with its last
// results before that run, so totals do not dip.
async function history(toolId, keys = [HOME]) {
  const indexes = await Promise.all(keys.map((k) => readIndex(toolId, k)));
  if (indexes.length === 1) return indexes[0];
  const times = [...new Set(indexes.flat().map((e) => e.ranAt))].sort();
  return times.map((ranAt) => {
    const out = { ranAt, count: 0, added: 0, resolved: 0, byKind: {} };
    for (const index of indexes) {
      let e = null;
      for (const x of index) if (x.ranAt <= ranAt && (!e || x.ranAt > e.ranAt)) e = x;
      if (!e) continue;
      out.count += e.count || 0;
      for (const [kind, n] of Object.entries(e.byKind || {})) out.byKind[kind] = (out.byKind[kind] || 0) + n;
      if (e.ranAt === ranAt) {
        out.added += e.added || 0;
        out.resolved += e.resolved || 0;
      }
    }
    return out;
  });
}

// One past run over these tenants, with what was new and what had gone
// compared with each tenant's run before it. Tenants not in that run show
// their results as they were then, with nothing new or resolved.
async function readRun(toolId, ranAt, keys = [HOME]) {
  const parts = await Promise.all(
    keys.map(async (k) => {
      const store = backend(k);
      const index = await readIndex(toolId, k);
      const at = index.findIndex((e) => e.ranAt === ranAt);
      if (at >= 0) {
        const run = await store.get(runKey(toolId, ranAt)).catch(() => null);
        if (!run) return null;
        const before = at > 0 ? await store.get(runKey(toolId, index[at - 1].ranAt)).catch(() => null) : null;
        stamp(k, run.findings);
        if (before) stamp(k, before.findings);
        const { added, resolved } = diff(before ? before.findings : [], run.findings);
        return { exact: true, findings: run.findings || [], added, resolved, previousRanAt: before ? before.ranAt : null };
      }
      const older = index.filter((e) => e.ranAt < ranAt).pop();
      if (!older) return null;
      const run = await store.get(runKey(toolId, older.ranAt)).catch(() => null);
      return run ? { exact: false, findings: stamp(k, run.findings), added: [], resolved: [], previousRanAt: null } : null;
    })
  );
  const found = parts.filter(Boolean);
  if (!found.some((p) => p.exact)) return null;
  const prev = found.map((p) => p.previousRanAt).filter(Boolean).sort();
  return {
    ranAt,
    previousRanAt: prev.length ? prev[prev.length - 1] : null,
    findings: found.flatMap((p) => p.findings),
    added: found.flatMap((p) => p.added),
    resolved: found.flatMap((p) => p.resolved),
  };
}

// The results as they stood at a moment: each tenant's last run at or before
// `iso` (for reports). ranAt is the newest of those runs; null = no run yet.
async function stateAt(toolId, iso, keys = [HOME]) {
  const parts = await Promise.all(
    keys.map(async (k) => {
      const index = await readIndex(toolId, k);
      const e = index.filter((x) => x.ranAt <= iso).pop();
      if (!e) return null;
      const run = await backend(k).get(runKey(toolId, e.ranAt)).catch(() => null);
      return run ? { ranAt: e.ranAt, findings: stamp(k, run.findings) } : null;
    })
  );
  const found = parts.filter(Boolean);
  if (!found.length) return { ranAt: null, findings: [] };
  return { ranAt: found.map((p) => p.ranAt).sort().pop(), findings: found.flatMap((p) => p.findings) };
}

// Other data that belongs in the same place (e.g. cost history), by key, in
// the given tenant's store (default: the tenant of the work in progress).
async function getDoc(key, tenantKey) {
  return backend(tenantKey).get(key);
}
async function putDoc(key, obj, tenantKey) {
  const k = tenantKey || (tenantContext.current() && tenantContext.current().key) || HOME;
  if (!exists(k)) throw new Error(`history storage: tenant "${k}" no longer exists, nothing written`);
  return backend(k).put(key, obj);
}

module.exports = {
  write,
  writeTenantError,
  read,
  history,
  readRun,
  stateAt,
  where,
  diff,
  findingKey,
  tenantOf,
  containerName,
  deleteTenantStore,
  HOME,
  getDoc,
  putDoc,
  STORAGE_TOOL_ID,
};
