// Customer tenants the dashboard scans besides its own (the "home" tenant,
// which uses the shared identity and per-tool overrides as before).
//
// A tenant comes from DASHBOARD_TENANTS (a JSON list, set by Terraform) and/or
// the Settings page (DATA_DIR/tenants.json). A Settings entry with the same key
// overrides the Terraform one field by field. Each customer tenant has its own
// app registration (clientId), made there by hand, and the dashboard signs in
// as it with a client secret entered in Settings (never in Terraform), kept in
// the key vault when SECRET_VAULT_URL is set (secretStore), else here. Entra
// does not let an app trust a managed identity of another tenant (AADSTS700236),
// so a secretless sign-in into a customer's own app is not possible.
// The key is what the per-customer app roles use: Admin-<key> and User-<key>.
//
// Removing a customer (Settings, Remove) deletes everything the dashboard has
// for it (tenantRemoval.js). A tenant Terraform sets cannot be taken out of
// DASHBOARD_TENANTS from here, so its key goes on the removed list
// (DATA_DIR/removed-tenants.json) and the tenant is ignored until the key is
// gone from Terraform too; then the entry clears itself at start-up.
const fs = require("fs");
const path = require("path");

const { DATA_DIR } = require("./paths");
const settings = require("./settings");
const secretStore = require("./secretStore");
const { writeAtomic } = require("./jsonFile");
const { HOME } = require("./tenantContext");

const FILE = path.join(DATA_DIR, "tenants.json");
const REMOVED_FILE = path.join(DATA_DIR, "removed-tenants.json");
const KEY_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIELDS = ["name", "tenantId", "clientId", "clientSecret", "subscriptionIds", "enabled"];
// Fields of 0.11.0.x (federated sign-in); dropped from tenants.json on the next
// save of that tenant.
const OLD_FIELDS = ["authType", "miClientId"];

function readFile() {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeFile(list) {
  writeAtomic(FILE, list);
}

// { "<key>": { at, by, name } }: removed in Settings while Terraform still
// sets the tenant.
function readRemoved() {
  try {
    const v = JSON.parse(fs.readFileSync(REMOVED_FILE, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function writeRemoved(map) {
  if (Object.keys(map).length) writeAtomic(REMOVED_FILE, map);
  else fs.rmSync(REMOVED_FILE, { force: true });
}

function isRemoved(key) {
  return Boolean(readRemoved()[key]);
}

// The vault's copy first; one still in the file is used until it is moved.
function secretOf(key, fallback) {
  return (secretStore.enabled() && secretStore.get("tenant", key)) || String(fallback || "").trim();
}

function readEnv() {
  const raw = process.env.DASHBOARD_TENANTS;
  if (!raw) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn(`DASHBOARD_TENANTS is not valid JSON, ignored: ${err.message}`);
    return [];
  }
}

function toList(v) {
  if (Array.isArray(v)) return v.map((s) => String(s).trim()).filter(Boolean);
  return String(v || "").split(",").map((s) => s.trim()).filter(Boolean);
}

// Merged, with defaults filled in. Entries that do not validate are dropped
// with a warning instead of breaking every scan; removed tenants are left out
// without one.
function customers() {
  const byKey = new Map();
  for (const t of readEnv()) {
    if (t && t.key) byKey.set(String(t.key).toLowerCase(), { ...t, source: "terraform" });
  }
  for (const t of readFile()) {
    if (!t || !t.key) continue;
    const key = String(t.key).toLowerCase();
    const base = byKey.get(key);
    const merged = { ...(base || {}) };
    for (const f of FIELDS) if (t[f] !== undefined && t[f] !== "") merged[f] = t[f];
    merged.source = base ? "terraform + settings" : "settings";
    byKey.set(key, merged);
  }
  const removed = readRemoved();
  const out = [];
  for (const [key, t] of byKey) {
    if (removed[key]) continue;
    const tenant = {
      key,
      name: String(t.name || key),
      tenantId: String(t.tenantId || "").trim(),
      clientId: String(t.clientId || "").trim(),
      clientSecret: secretOf(key, t.clientSecret),
      subscriptionIds: toList(t.subscriptionIds),
      enabled: t.enabled !== false && t.enabled !== "false",
      source: t.source,
    };
    const problem = validate(tenant);
    if (problem) {
      console.warn(`tenant "${key}" ignored: ${problem}`);
      continue;
    }
    out.push(tenant);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function validate(t) {
  if (!KEY_RE.test(t.key) || t.key === HOME) return `key must be 1-40 lowercase letters, digits, - or _ (not "${HOME}")`;
  if (!GUID_RE.test(t.tenantId)) return "tenantId must be a GUID";
  if (t.clientId && !GUID_RE.test(t.clientId)) return "clientId must be a GUID";
  if (t.subscriptionIds.some((s) => !GUID_RE.test(s))) return "subscriptionIds must be GUIDs";
  return null;
}

function home() {
  return {
    key: HOME,
    name: settings.get("HOME_TENANT_NAME") || "Home",
    home: true,
    enabled: (settings.get("HOME_TENANT_SCAN") || "on") !== "off",
  };
}

// Every tenant a scan runs in, home first.
function scanTargets() {
  return [home(), ...customers()].filter((t) => t.enabled);
}

// All known tenants (enabled or not), for names and filters.
function all() {
  return [home(), ...customers()];
}

function nameOf(key) {
  const t = all().find((x) => x.key === (key || HOME));
  return t ? t.name : key;
}

function byKey(key) {
  return all().find((t) => t.key === key) || null;
}

// Several tenants in use: findings and pages show which one each row is from.
function isMultiTenant() {
  return scanTargets().length > 1 || customers().length > 0;
}

// --- Settings page ---

// Never returns a secret, only whether one is set and where.
function listForSettings() {
  return customers().map(({ clientSecret, ...t }) => ({
    ...t,
    hasSecret: Boolean(clientSecret),
    secretIn: !clientSecret ? null : secretStore.enabled() && secretStore.has("tenant", t.key) ? "key vault" : "file",
  }));
}

async function upsert(body) {
  const key = String((body && body.key) || "").trim().toLowerCase();
  if (!KEY_RE.test(key) || key === HOME) throw new Error(`key must be 1-40 lowercase letters, digits, - or _ (not "${HOME}")`);
  if (isRemoved(key)) throw new Error(`"${key}" was removed and waits for Terraform; use Undo to bring it back`);
  const list = readFile();
  const at = list.findIndex((t) => String(t.key).toLowerCase() === key);
  const entry = at >= 0 ? { ...list[at] } : { key };
  for (const f of OLD_FIELDS) delete entry[f];
  for (const f of FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(body, f)) continue;
    let v = body[f];
    if (f === "enabled") {
      entry.enabled = v !== false && v !== "false";
      continue;
    }
    if (f === "clientSecret") continue; // below, after the checks
    if (f === "subscriptionIds") v = toList(v);
    if (typeof v === "string") v = v.trim();
    if (v === "" || (Array.isArray(v) && !v.length)) delete entry[f];
    else entry[f] = v;
  }

  // Check the result as it will be used (Terraform values included).
  const envBase = readEnv().find((t) => String(t.key).toLowerCase() === key) || {};
  const check = {
    key,
    tenantId: String(entry.tenantId || envBase.tenantId || ""),
    clientId: String(entry.clientId || envBase.clientId || ""),
    subscriptionIds: toList(entry.subscriptionIds || envBase.subscriptionIds),
  };
  const problem = validate(check);
  if (problem) throw new Error(problem);

  // Blank = keep the stored secret; clearSecret removes it unless a new one
  // was typed. With a key vault it goes there, and the file never holds it.
  const newSecret = typeof body.clientSecret === "string" ? body.clientSecret.trim() : "";
  if (secretStore.enabled()) {
    if (newSecret) await secretStore.set("tenant", key, newSecret);
    else if (body.clearSecret) await secretStore.remove("tenant", key);
    if (newSecret || body.clearSecret) delete entry.clientSecret;
  } else if (newSecret) {
    entry.clientSecret = newSecret;
  } else if (body.clearSecret) {
    delete entry.clientSecret;
  }

  if (at >= 0) list[at] = entry;
  else list.push(entry);
  writeFile(list);
  return listForSettings();
}

const inEnv = (k) => readEnv().some((t) => t && String(t.key).toLowerCase() === k);

// Drops Settings' changes to a Terraform tenant: it goes back to what
// Terraform set (and has no client secret, since Terraform never sets one).
// Removing a tenant itself is forget() below, through tenantRemoval.js.
async function reset(key) {
  const k = String(key).toLowerCase();
  const inFile = readFile().some((t) => t && String(t.key).toLowerCase() === k);
  if (!inFile || !inEnv(k)) {
    throw new Error(inFile ? "this tenant was added in Settings; Remove deletes it" : inEnv(k) ? "this tenant has no Settings changes to reset" : "no such tenant");
  }
  if (secretStore.enabled()) await secretStore.remove("tenant", k);
  writeFile(readFile().filter((t) => String(t.key).toLowerCase() !== k));
  return listForSettings();
}

// Takes a customer out of the list for good: its tenants.json entry goes
// (with the client secret, when the file held it), and when Terraform still
// sets it the key goes on the removed list, so the tenant is ignored until
// Terraform drops it too. From here on byKey() no longer finds it, so nothing
// is scanned, written or shown for it. The vault's copies of its secrets are
// the caller's to purge. Returns what was done; { terraform } says whether the
// Terraform step is still needed.
function forget(key, by) {
  const k = String(key || "").toLowerCase();
  if (k === HOME) throw new Error("the home tenant cannot be removed");
  const t = byKey(k);
  if (!t || !KEY_RE.test(k)) throw new Error("no such tenant");
  const list = readFile();
  const entry = list.find((e) => e && String(e.key).toLowerCase() === k);
  if (entry) writeFile(list.filter((e) => e !== entry));
  const terraform = inEnv(k);
  if (terraform) writeRemoved({ ...readRemoved(), [k]: { at: new Date().toISOString(), by: by || null, name: t.name } });
  return { key: k, name: t.name, source: t.source, terraform, fileSecret: Boolean(entry && entry.clientSecret) };
}

// Undo for a removed Terraform tenant: it is listed and scanned again. What
// was deleted stays deleted.
function restore(key) {
  const k = String(key || "").toLowerCase();
  const removed = readRemoved();
  if (!removed[k]) throw new Error("no such removed tenant");
  delete removed[k];
  writeRemoved(removed);
  return listForSettings();
}

// Removed tenants Terraform still sets, for Settings ("waiting for Terraform").
function removedForSettings() {
  return Object.entries(readRemoved())
    .filter(([k]) => inEnv(k))
    .map(([key, r]) => ({ key, name: r.name || key, at: r.at || null, by: r.by || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// At start-up: a removed key that Terraform no longer sets is done with, the
// entry clears itself. Returns the keys cleared.
function pruneRemoved() {
  const removed = readRemoved();
  const gone = Object.keys(removed).filter((k) => !inEnv(k));
  if (gone.length) {
    for (const k of gone) delete removed[k];
    writeRemoved(removed);
  }
  return gone;
}

// Moves client secrets still in tenants.json into the key vault (once one is
// set and loaded). Each leaves the file only after the vault has it.
async function moveSecretsToVault() {
  if (!secretStore.enabled() || !secretStore.ready()) return 0;
  let moved = 0;
  for (const t of readFile()) {
    if (!t || !t.key || !t.clientSecret) continue;
    const key = String(t.key).toLowerCase();
    if (!secretStore.has("tenant", key)) await secretStore.set("tenant", key, String(t.clientSecret).trim());
    const list = readFile();
    for (const e of list) if (e && String(e.key).toLowerCase() === key) delete e.clientSecret;
    writeFile(list);
    moved++;
  }
  return moved;
}

module.exports = {
  moveSecretsToVault,
  HOME,
  customers,
  home,
  scanTargets,
  all,
  nameOf,
  byKey,
  isMultiTenant,
  listForSettings,
  upsert,
  reset,
  forget,
  restore,
  removedForSettings,
  pruneRemoved,
  isRemoved,
  GUID_RE,
  KEY_RE,
  _test: { FILE, REMOVED_FILE },
};
