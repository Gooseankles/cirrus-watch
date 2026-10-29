// Secrets typed into Settings (the shared and per-tool SPN client secrets, and
// each customer tenant's client secret) are kept in an Azure Key Vault when
// SECRET_VAULT_URL is set (Terraform sets it), instead of the JSON files under
// DATA_DIR. The app reads and writes them with its own system-assigned managed
// identity (or SECRET_VAULT_CLIENT_ID's user-assigned one), which has Key Vault
// Secrets Officer on that vault and nothing else.
//
// Everything is loaded into memory at start-up so the rest of the app can read
// secrets synchronously; a save goes to the vault first and only then into
// memory. While the vault cannot be reached, loading is retried every minute
// and saving a secret fails with the reason. remove() is the vault's soft
// delete (the bin keeps it, and set() brings it back); purge() also empties it
// from the bin, for a customer that is removed for good.
//
// The vault URL comes only from the environment, never from Settings, so a
// Settings change can never send the app's token elsewhere.
const crypto = require("crypto");
const axios = require("axios");
const { ManagedIdentityCredential } = require("@azure/identity");

const API_VERSION = "7.4";
const RETRY_MS = 60 * 1000;
const TIMEOUT_MS = 30 * 1000;

const values = new Map(); // "<kind>|<key>" -> secret value
let state = { ready: false, error: null };
let loading = null;
let retryTimer = null;
let credential = null;
const loadListeners = [];

// Runs after every successful load (start-up, or the first retry that works).
function onLoad(fn) {
  loadListeners.push(fn);
}

function vaultUrl() {
  return String(process.env.SECRET_VAULT_URL || "").trim().replace(/\/+$/, "");
}

const isLocal = (url) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url);

function enabled() {
  return Boolean(vaultUrl());
}

function checkUrl(url) {
  if (!/^https:\/\/[a-z0-9-]+\.vault\.[a-z0-9.-]+$/i.test(url) && !isLocal(url)) {
    throw new Error(`SECRET_VAULT_URL must be the vault's https://<name>.vault.azure.net address, not "${url}"`);
  }
}

// SECRET_VAULT_DEV_TOKEN is only for tests against a local stand-in vault.
async function token() {
  const url = vaultUrl();
  if (isLocal(url) && process.env.SECRET_VAULT_DEV_TOKEN) return process.env.SECRET_VAULT_DEV_TOKEN;
  if (!credential) {
    const clientId = process.env.SECRET_VAULT_CLIENT_ID;
    credential = new ManagedIdentityCredential(clientId ? { clientId } : undefined);
  }
  return (await credential.getToken("https://vault.azure.net/.default")).token;
}

// Kind and key live in tags; the name is only for people looking at the vault.
// Vault names allow letters, digits and dashes, so the key is cleaned and a
// short hash keeps two keys that clean to the same text apart.
function secretName(kind, key) {
  const clean = String(key).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
  const hash = crypto.createHash("sha256").update(`${kind}|${key}`).digest("hex").slice(0, 8);
  return `dashboard-${kind}-${clean}-${hash}`;
}

function fail(op, resp) {
  const err = (resp.data && resp.data.error) || {};
  const hint = resp.status === 403 ? " (give the dashboard's identity Key Vault Secrets Officer on the vault, and let it through the vault's firewall)" : "";
  return new Error(`key vault: ${op} failed: ${resp.status} ${err.code || ""} ${String(err.message || "").slice(0, 200)}${hint}`.replace(/\s+/g, " ").trim());
}

async function call(method, path, body) {
  const url = /^https?:\/\//.test(path) ? path : `${vaultUrl()}${path}${path.includes("?") ? "&" : "?"}api-version=${API_VERSION}`;
  return axios({
    method,
    url,
    data: body,
    headers: { Authorization: `Bearer ${await token()}`, "Content-Type": "application/json" },
    timeout: TIMEOUT_MS,
    validateStatus: () => true,
  });
}

async function readAll() {
  const found = new Map();
  let next = "/secrets?maxresults=25";
  while (next) {
    const resp = await call("GET", next);
    if (resp.status >= 300) throw fail("list secrets", resp);
    for (const item of resp.data.value || []) {
      const tags = item.tags || {};
      if (!tags.dashboardKind || !tags.dashboardKey || (item.attributes && item.attributes.enabled === false)) continue;
      const name = item.id.split("/").pop();
      const one = await call("GET", `/secrets/${name}`);
      if (one.status >= 300) throw fail(`read ${name}`, one);
      found.set(`${tags.dashboardKind}|${tags.dashboardKey}`, one.data.value);
    }
    next = resp.data.nextLink || null;
  }
  return found;
}

// Loads every dashboard secret into memory. Resolves once loaded (or at once
// when no vault is set); on failure keeps retrying in the background.
function load() {
  if (!enabled()) {
    state = { ready: true, error: null };
    return Promise.resolve();
  }
  if (loading) return loading;
  loading = (async () => {
    try {
      checkUrl(vaultUrl());
      const found = await readAll();
      values.clear();
      for (const [k, v] of found) values.set(k, v);
      state = { ready: true, error: null };
      console.log(`Secrets: ${found.size} loaded from ${vaultUrl()}`);
      for (const fn of loadListeners) {
        try {
          await fn();
        } catch (err) {
          console.error(`Secrets: after loading: ${err.message}`);
        }
      }
    } catch (err) {
      state = { ready: false, error: err.message };
      console.error(`Secrets: cannot load from the key vault, retrying in a minute: ${err.message}`);
      if (!retryTimer) {
        retryTimer = setTimeout(() => {
          retryTimer = null;
          load();
        }, RETRY_MS);
        retryTimer.unref();
      }
    } finally {
      loading = null;
    }
  })();
  return loading;
}

function ready() {
  return !enabled() || state.ready;
}

function get(kind, key) {
  return values.get(`${kind}|${key}`) || "";
}

function has(kind, key) {
  return Boolean(get(kind, key));
}

function requireReady() {
  if (!state.ready) throw new Error(`the key vault is not reachable, so the secret was not saved: ${state.error || "still loading"}`);
}

async function set(kind, key, value) {
  requireReady();
  const name = secretName(kind, key);
  const body = { value, contentType: "text/plain", tags: { dashboardKind: kind, dashboardKey: key } };
  let resp = await call("PUT", `/secrets/${name}`, body);
  // Removed earlier and still in the vault's soft-delete bin: bring it back,
  // then write the new value over it.
  if (resp.status === 409) {
    const rec = await call("POST", `/deletedsecrets/${name}/recover`);
    if (rec.status >= 300 && rec.status !== 404) throw fail(`recover ${name}`, rec);
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      resp = await call("PUT", `/secrets/${name}`, body);
      if (resp.status !== 409) break;
    }
  }
  if (resp.status >= 300) throw fail(`write ${name}`, resp);
  values.set(`${kind}|${key}`, value);
}

async function remove(kind, key) {
  requireReady();
  const name = secretName(kind, key);
  const resp = await call("DELETE", `/secrets/${name}`);
  if (resp.status >= 300 && resp.status !== 404) throw fail(`delete ${name}`, resp);
  values.delete(`${kind}|${key}`);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const DAY_S = 86400;

// What a delete-and-purge came to, from the vault's answers. deleted: the
// vault had it and it is gone from use. purged: gone from the vault's bin too.
// Otherwise keptDays says how long the bin keeps it (scheduledPurgeDate, unix
// seconds) and reason why the purge was refused: the vault's purge protection,
// or an identity without the purge right (Key Vault Secrets Officer has it).
function purgeOutcome(deleteResp, purgeResp, now = Date.now()) {
  if (deleteResp.status === 404) return { deleted: false, purged: false, keptDays: null, reason: "no secret was stored" };
  if (!purgeResp || purgeResp.status === 204 || purgeResp.status === 404) return { deleted: true, purged: true, keptDays: null, reason: null };
  const when = Number(deleteResp.data && deleteResp.data.scheduledPurgeDate);
  const keptDays = when ? Math.max(1, Math.ceil((when - now / 1000) / DAY_S)) : null;
  const err = (purgeResp.data && purgeResp.data.error) || {};
  const text = `${err.code || ""} ${err.message || ""} ${(err.innererror && err.innererror.code) || ""}`;
  const protection = purgeResp.status === 403 && /purge protection|ForbiddenByPolicy/i.test(text);
  const reason = protection
    ? "the vault's purge protection keeps it"
    : purgeResp.status === 403
      ? "the dashboard's identity may not purge (it needs Key Vault Secrets Officer on the vault); the vault keeps it"
      : `the purge failed (${purgeResp.status} ${err.code || ""}`.trim() + "); the vault keeps it";
  return { deleted: true, purged: false, keptDays, reason };
}

// Deletes a secret for good: the soft delete, then the purge from the vault's
// bin, so nothing of it is kept. Returns purgeOutcome(); it never throws for a
// refused purge (the caller says what was kept), only when the vault cannot be
// reached or the delete itself fails.
async function purge(kind, key) {
  requireReady();
  const name = secretName(kind, key);
  const del = await call("DELETE", `/secrets/${name}`);
  if (del.status >= 300 && del.status !== 404) throw fail(`delete ${name}`, del);
  values.delete(`${kind}|${key}`);
  if (del.status === 404) return purgeOutcome(del, null);
  // The deleted entry shows up in the bin a moment after the delete; a purge
  // before that answers 404 or 409 ("being deleted"), so wait for it.
  let purged = null;
  for (let i = 0; i < 30; i++) {
    const gone = await call("GET", `/deletedsecrets/${name}`);
    if (gone.status === 200) {
      purged = await call("DELETE", `/deletedsecrets/${name}`);
      if (purged.status !== 409) break;
    } else if (gone.status !== 404) {
      purged = gone;
      break;
    }
    await wait(1000);
  }
  return purgeOutcome(del, purged || { status: 409, data: { error: { code: "Timeout", message: "the deleted secret did not appear in the vault's bin" } } });
}

// For the Settings page: where secrets are kept. Never a value.
function describe() {
  if (!enabled()) return { backend: "file", location: "DATA_DIR (settings.json, tenants.json)" };
  return { backend: "key-vault", location: vaultUrl(), ready: state.ready, error: state.error };
}

module.exports = { enabled, ready, load, onLoad, get, has, set, remove, purge, describe, secretName, _test: { purgeOutcome } };
