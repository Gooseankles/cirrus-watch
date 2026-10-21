// Customer tenants the dashboard scans besides its own (the "home" tenant,
// which uses the shared identity and per-tool overrides as before).
//
// A tenant comes from DASHBOARD_TENANTS (a JSON list, set by Terraform) and/or
// the Settings page (DATA_DIR/tenants.json). A Settings entry with the same key
// overrides the Terraform one field by field. Each customer tenant has its own
// app registration (clientId), made there by hand, and the dashboard signs in
// as it with a client secret entered in Settings (never in Terraform). Entra
// does not let an app trust a managed identity of another tenant (AADSTS700236),
// so a secretless sign-in into a customer's own app is not possible.
// The key is what the per-customer app roles use: Admin-<key> and User-<key>.
const fs = require("fs");
const path = require("path");

const { DATA_DIR } = require("./paths");
const settings = require("./settings");
const { HOME } = require("./tenantContext");

const FILE = path.join(DATA_DIR, "tenants.json");
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
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2));
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
// with a warning instead of breaking every scan.
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
  const out = [];
  for (const [key, t] of byKey) {
    const tenant = {
      key,
      name: String(t.name || key),
      tenantId: String(t.tenantId || "").trim(),
      clientId: String(t.clientId || "").trim(),
      clientSecret: String(t.clientSecret || "").trim(),
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

// Never returns a secret, only whether one is set.
function listForSettings() {
  return customers().map(({ clientSecret, ...t }) => ({ ...t, hasSecret: Boolean(clientSecret) }));
}

function upsert(body) {
  const key = String((body && body.key) || "").trim().toLowerCase();
  if (!KEY_RE.test(key) || key === HOME) throw new Error(`key must be 1-40 lowercase letters, digits, - or _ (not "${HOME}")`);
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
    if (f === "clientSecret") {
      if (typeof v === "string" && v.trim()) entry.clientSecret = v.trim(); // blank = keep
      continue;
    }
    if (f === "subscriptionIds") v = toList(v);
    if (typeof v === "string") v = v.trim();
    if (v === "" || (Array.isArray(v) && !v.length)) delete entry[f];
    else entry[f] = v;
  }

  if (body.clearSecret && !(typeof body.clientSecret === "string" && body.clientSecret.trim())) delete entry.clientSecret;

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

  if (at >= 0) list[at] = entry;
  else list.push(entry);
  writeFile(list);
  return listForSettings();
}

// Removes a tenant added in Settings, or Settings' changes to a Terraform
// tenant (it goes back to what Terraform set). A Terraform tenant itself stays.
function remove(key) {
  const k = String(key).toLowerCase();
  const inFile = readFile().some((t) => t && String(t.key).toLowerCase() === k);
  if (!inFile) {
    const fromEnv = readEnv().some((t) => t && String(t.key).toLowerCase() === k);
    throw new Error(fromEnv ? "this tenant is set by Terraform; remove it there" : "no such tenant");
  }
  writeFile(readFile().filter((t) => String(t.key).toLowerCase() !== k));
  if (!readEnv().some((t) => t && String(t.key).toLowerCase() === k)) settings.dropTenant(k);
  return listForSettings();
}

module.exports = { HOME, customers, home, scanTargets, all, nameOf, byKey, isMultiTenant, listForSettings, upsert, remove, GUID_RE };
