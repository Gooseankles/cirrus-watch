// Scan results per tool: the latest run (what the dashboard shows) plus a
// snapshot of every run and a small index of per-run counts, so trends and
// "what changed" can be seen far back in time.
//
// Where it is kept: an Azure Storage blob container when STORAGE_ACCOUNT_URL is
// set (Settings or .env), reached with an Entra token (managed identity, no
// account keys); otherwise files under DATA_DIR. Same layout in both:
//   findings/<tool>.json            latest run
//   history/<tool>/index.json       [{ ranAt, count, added, resolved, byKind }]
//   history/<tool>/<ranAt>.json     full snapshot of that run
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const { DATA_DIR } = require("./paths");
const settings = require("./settings");
const { getCredential } = require("./credentials");

const STORAGE_TOOL_ID = "history-storage"; // its own identity override in Settings
const BLOB_API_VERSION = "2021-08-06";

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

const fileBackend = {
  name: "file",
  async get(key) {
    const file = path.join(DATA_DIR, checkKey(key));
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  },
  async put(key, obj) {
    const file = path.join(DATA_DIR, checkKey(key));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(obj));
  },
  async del(key) {
    try {
      fs.unlinkSync(path.join(DATA_DIR, checkKey(key)));
    } catch {
      // already gone
    }
  },
};

function blobBackend(accountUrl, container) {
  const base = `${accountUrl.replace(/\/+$/, "")}/${container}`;
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
          validateStatus: () => true,
          maxBodyLength: Infinity,
        });
      let resp = await send();
      if (resp.status === 404 && resp.headers["x-ms-error-code"] === "ContainerNotFound") {
        await ensureContainer();
        resp = await send();
      }
      if (resp.status >= 300) throw fail("write", key, resp);
    },
    async del(key) {
      checkKey(key);
      const resp = await axios.delete(`${base}/${key}`, { headers: await headers(), validateStatus: () => true });
      if (resp.status >= 300 && resp.status !== 404) throw fail("delete", key, resp);
    },
  };
}

// Picked on every call, so changing the setting needs no restart.
function backend() {
  const url = settings.get("STORAGE_ACCOUNT_URL");
  if (!url) return fileBackend;
  return blobBackend(url, settings.get("STORAGE_CONTAINER") || "dashboard");
}

function where() {
  const url = settings.get("STORAGE_ACCOUNT_URL");
  return url
    ? { backend: "blob", location: `${url.replace(/\/+$/, "")}/${settings.get("STORAGE_CONTAINER") || "dashboard"}` }
    : { backend: "file", location: DATA_DIR };
}

// --- Keys and diffs ---

const latestKey = (toolId) => `findings/${toolId}.json`;
const indexKey = (toolId) => `history/${toolId}/index.json`;
const runKey = (toolId, ranAt) => `history/${toolId}/${ranAt.replace(/[:.]/g, "-")}.json`;

function findingKey(f) {
  return f.id ? `${f.kind || ""}|${f.id}` : `${f.kind || ""}|${f.name || ""}|${f.detail || ""}`;
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

// --- Public API ---

async function write(toolId, findings) {
  return withLock(toolId, async () => {
    const store = backend();
    const ranAt = new Date().toISOString();
    const previous = (await store.get(latestKey(toolId))) || { findings: [] };

    // firstSeen carries over from the previous run, so a finding's age is known.
    const seen = new Map((previous.findings || []).map((f) => [findingKey(f), f.firstSeen || previous.ranAt]));
    for (const f of findings) f.firstSeen = seen.get(findingKey(f)) || ranAt;

    const { added, resolved } = diff(previous.findings, findings);
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
    return { ranAt, added: added.length, resolved: resolved.length };
  });
}

async function read(toolId) {
  return (await backend().get(latestKey(toolId))) || { ranAt: null, findings: [] };
}

// Per-run counts, oldest first.
async function history(toolId) {
  return (await backend().get(indexKey(toolId))) || [];
}

// One past run, with what was new and what had gone compared with the run before it.
async function readRun(toolId, ranAt) {
  const store = backend();
  const index = (await store.get(indexKey(toolId))) || [];
  const at = index.findIndex((e) => e.ranAt === ranAt);
  if (at < 0) return null;
  const run = await store.get(runKey(toolId, ranAt));
  if (!run) return null;
  const before = at > 0 ? await store.get(runKey(toolId, index[at - 1].ranAt)) : null;
  const { added, resolved } = diff(before ? before.findings : [], run.findings);
  return { ...run, previousRanAt: before ? before.ranAt : null, added, resolved };
}

// Other data that belongs in the same place (e.g. cost history), by key.
async function getDoc(key) {
  return backend().get(key);
}
async function putDoc(key, obj) {
  return backend().put(key, obj);
}

module.exports = { write, read, history, readRun, where, diff, findingKey, getDoc, putDoc, STORAGE_TOOL_ID };
