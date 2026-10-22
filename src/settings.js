// Everything on the admin-only Settings tab: scan thresholds AND the Azure
// connection itself (shared SPN, per-tool SPNs, subscriptions to scan). An
// override here wins over .env; leaving a plain field blank falls back to
// .env (or that tool's own built-in default). Secret fields (client
// secrets, passwords) work differently — see setMany below.
//
// Fields marked perTenant (the tools' thresholds and options) can also be set
// per customer tenant (DATA_DIR/tenant-settings.json); while a scan runs for
// that tenant, its value wins over the home one. Blank = the home value.
const fs = require("fs");
const path = require("path");

const { DATA_DIR } = require("./paths");
const { writeAtomic } = require("./jsonFile");
const secretStore = require("./secretStore");

const { HOME, current } = require("./tenantContext");

const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const TENANT_SETTINGS_PATH = path.join(DATA_DIR, "tenant-settings.json");

const AUTH_TYPES = [
  { value: "secret", label: "Client secret" },
  { value: "managed-identity", label: "Managed identity" },
  { value: "federated", label: "Federated (app registration trusts a managed identity)" },
];
const SECRET_ONLY = ["secret"];
const NEEDS_TENANT = ["secret", "federated"];
const FEDERATED_ONLY = ["federated"];

const FIELDS = [
  { key: "AZURE_AUTH_TYPE", label: "Auth type", group: "Azure service principal (shared)", options: AUTH_TYPES, defaultValue: "secret" },
  { key: "AZURE_CLIENT_ID", label: "Client ID", group: "Azure service principal (shared)", hint: "Managed identity: the user-assigned identity's client ID, blank = system-assigned. Federated: the app registration's client ID" },
  { key: "AZURE_CLIENT_SECRET", label: "Client secret", group: "Azure service principal (shared)", secret: true, authOnly: SECRET_ONLY },
  { key: "AZURE_TENANT_ID", label: "Tenant ID", group: "Azure service principal (shared)", authOnly: NEEDS_TENANT },
  { key: "AZURE_FEDERATED_MI_CLIENT_ID", label: "Managed identity it trusts", group: "Azure service principal (shared)", authOnly: FEDERATED_ONLY, hint: "Client ID of the user-assigned identity in the app registration's federated credential; blank = DASHBOARD_FEDERATED_MI_CLIENT_ID" },
  { key: "AZURE_SUBSCRIPTION_IDS", label: "Subscriptions to scan", group: "Azure service principal (shared)", hint: "Comma-separated subscription IDs; blank = every subscription the SPN can see" },

  { key: "HOME_TENANT_NAME", label: "Name of this tenant", group: "Home tenant", hint: "Shown next to its findings when customer tenants are added (Customer tenants below); blank = Home. Its role values are Admin-home and User-home" },
  { key: "HOME_TENANT_SCAN", label: "Scan this tenant", group: "Home tenant", options: [{ value: "on", label: "Yes" }, { value: "off", label: "No, only the customer tenants" }], defaultValue: "on" },

  { key: "STORAGE_ACCOUNT_URL", label: "Storage account blob URL", group: "History storage", hint: "e.g. https://stdashboard.blob.core.windows.net; blank = keep results on the app's own disk" },
  { key: "STORAGE_CONTAINER", label: "Container", group: "History storage", hint: "Blank = dashboard" },
  { key: "HISTORY_RETENTION_DAYS", label: "Keep run history (days)", group: "History storage", hint: "Blank = 365" },

  // The dashboard's own server, so not per tenant.
  { key: "MONITOR_CPU_WARN_PCT", label: "Alarm when the instance's CPU stays above (%)", group: "Server load", hint: "For 5 minutes; blank = 90" },
  { key: "MONITOR_MEMORY_WARN_PCT", label: "Alarm when memory is above (%)", group: "Server load", hint: "The instance's memory, the container's limit or the dashboard's heap limit; blank = 85" },
  { key: "MONITOR_LAG_WARN_MS", label: "Alarm when the dashboard stops answering for (ms)", group: "Server load", hint: "Event-loop delay; blank = 2000" },

  // One send time for all; each tenant's link is set in the Notifications card.
  { key: "NOTIFY_TIME", label: "Send the daily message at (HH:MM, server time)", group: "Notifications", hint: "After the nightly scans; blank = 08:30. Each tenant's Teams or webhook link is set in the Notifications card on its tab" },

  { key: "ROLE_ASSIGNMENT_LIMIT_WARN_PCT", label: "Warn at % of the 4,000 limit", group: "Role assignments", hint: "Blank = 80" },
  { key: "POLICY_PROBES", label: "Probe tests to run", group: "Policy check", hint: "Comma-separated: storage-public-blob, storage-http, storage-old-tls, public-ip, keyvault-no-purge-protection, sql-public-network, untagged-resource, denied-region. Blank = all, none = off" },
  { key: "POLICY_PROBE_REGION", label: "Region for probes", group: "Policy check", hint: "An allowed region; blank = norwayeast" },
  { key: "POLICY_PROBE_DENIED_REGION", label: "Region that must be blocked", group: "Policy check", hint: "Enables the denied-region probe, e.g. brazilsouth" },

  { key: "AZURE_REQUIRED_TAGS", label: "Required tags", group: "Tag compliance", hint: "Comma-separated tag names" },
  { key: "AZURE_COST_ANOMALY_THRESHOLD_PCT", label: "Cost jump threshold (%)", group: "Cost anomalies" },
  { key: "COST_HISTORY_MONTHS", label: "Cost history to pull on first run (months)", group: "Cost anomalies", hint: "Blank = 13; after that it keeps growing from storage" },
  { key: "AZURE_ACCESS_REVIEW_STALE_DAYS", label: "Stale direct-assignment age (days)", group: "Access review" },
  { key: "SECRET_EXPIRY_WARN_DAYS", label: "Warn before expiry (days)", group: "Expiring app credentials" },
  { key: "KEYVAULT_EXPIRY_WARN_DAYS", label: "Warn before expiry (days)", group: "Key Vault", hint: "Blank = 30" },
  { key: "KEYVAULT_MAX_READERS", label: "Most identities that may read secrets", group: "Key Vault", hint: "Per vault; blank = 10" },
  { key: "KEYVAULT_UNUSED_DAYS", label: "Unused after (days)", group: "Key Vault", hint: "No reads or writes for this long; blank = 30, at most 90" },
  { key: "KEYVAULT_OWNER_TAG", label: "Owner tag name", group: "Key Vault", hint: "Blank = Owner, none = off" },
  { key: "ACCESS_PACKAGE_EXPIRY_WARN_DAYS", label: "Assignment expiry warning (days)", group: "Access packages" },
  { key: "ACCESS_PACKAGE_STALE_PENDING_DAYS", label: "Pending request stale age (days)", group: "Access packages" },
  { key: "ACCESS_PACKAGE_UNUSED_AGE_DAYS", label: "Unused package age (days)", group: "Access packages" },
  { key: "EOS_WARN_DAYS", label: "Warn before end of support (days)", group: "End of support", hint: "Runtimes and operating systems; blank = 180" },
  { key: "RETIREMENT_WARN_DAYS", label: "Warn before retirement (days)", group: "Service retirements", hint: "Later retirements are listed as planned; blank = 180" },
  { key: "BACKUP_MAX_AGE_HOURS", label: "Newest backup at most (hours) old", group: "Backup coverage", hint: "Blank = 48" },
  { key: "DIAGNOSTICS_RESOURCE_TYPES", label: "Resource types that must keep logs", group: "Diagnostic settings", hint: "Comma-separated, e.g. microsoft.network/azurefirewalls. Blank = AKS, app gateways, firewalls, Front Door/CDN, API Management, backup vaults, Event Hubs, Service Bus, SQL databases, storage" },
  { key: "QUOTA_WARN_PCT", label: "Warn at % of a quota", group: "Quotas", hint: "95% and over is critical; blank = 80" },
  { key: "IPAM_SUBNET_WARN_PCT", label: "Warn when a subnet is this % full", group: "IP addresses", hint: "95% and over is critical; blank = 80" },
  { key: "IPAM_POOLS", label: "Address plan (ranges you hand out)", group: "IP addresses", hint: "Comma-separated, e.g. 10.0.0.0/8, 172.16.0.0/12. VNets outside them are flagged; also offered in Free ranges. Blank = no plan check" },
  { key: "CHANGE_LOG_HOURS", label: "Changes from the last (hours)", group: "Change log", hint: "Match the schedule (daily); blank = 24, at most 336" },
  { key: "STALE_ACCOUNT_DAYS", label: "Member accounts are stale after (days)", group: "Stale accounts", hint: "Days without a sign-in; blank = 90" },
  { key: "STALE_GUEST_DAYS", label: "Guest accounts are stale after (days)", group: "Stale accounts", hint: "Also how long a guest invitation may stay unaccepted; blank = 90" },
  { key: "MFA_NEW_USER_DAYS", label: "Leave new accounts alone for (days)", group: "MFA coverage", hint: "Time to set up MFA before an account is flagged; blank = 14" },
  { key: "CA_MAX_EXCLUSIONS", label: "Flag a policy excluding more than", group: "Conditional Access", hint: "Excluded users, groups and roles together; blank = 5" },
  { key: "DEFENDER_MIN_SCORE", label: "Flag a secure score below (%)", group: "Defender for Cloud", hint: "Per subscription; blank = 70, 0 = off" },
  { key: "DEFENDER_MIN_SEVERITY", label: "Recommendations from severity", group: "Defender for Cloud", hint: "high, medium or low; blank = medium" },
  { key: "LOCK_RESOURCE_TYPES", label: "Resource types that need a delete lock", group: "Safety nets", hint: "Comma-separated, e.g. microsoft.sql/servers. Blank = key vaults, Recovery Services and backup vaults, VNets, DNS and private DNS zones; none = off" },
  { key: "DEFENDER_REQUIRED_PLANS", label: "Plans that must be on", group: "Defender for Cloud", hint: "Comma-separated plan names, e.g. VirtualMachines, StorageAccounts, KeyVaults, SqlServers, Arm, Containers. all = every plan; blank = no plan check" },
];
// Everything from "Role assignments" down is a tool option a customer tenant
// may set differently.
for (const f of FIELDS.slice(FIELDS.findIndex((x) => x.key === "ROLE_ASSIGNMENT_LIMIT_WARN_PCT"))) f.perTenant = true;

// Optional least-privilege SPN per tool. A tool uses its own SPN only when
// its client ID is set; otherwise it uses the shared one above. These apply to
// the home tenant; a customer tenant uses its own identity for every tool.
const TOOL_SPNS = [
  { id: "access-lookup", label: "Access lookup" },
  { id: "orphaned-resources", label: "Orphaned resources" },
  { id: "tag-compliance", label: "Tag compliance" },
  { id: "cost-anomaly", label: "Cost anomalies" },
  { id: "access-review", label: "Access review" },
  { id: "secret-expiry", label: "Expiring app credentials" },
  { id: "key-vault", label: "Key Vault" },
  { id: "access-packages", label: "Access packages" },
  { id: "role-assignments", label: "Role assignments" },
  { id: "policy-check", label: "Policy check" },
  { id: "internet-exposure", label: "Internet exposure" },
  { id: "end-of-support", label: "End of support" },
  { id: "service-retirements", label: "Service retirements" },
  { id: "backup-coverage", label: "Backup coverage" },
  { id: "diagnostic-settings", label: "Diagnostic settings" },
  { id: "quotas", label: "Quotas" },
  { id: "ipam", label: "IP addresses" },
  { id: "change-log", label: "Change log" },
  { id: "privileged-roles", label: "Privileged roles" },
  { id: "stale-accounts", label: "Stale accounts" },
  { id: "mfa-coverage", label: "MFA coverage" },
  { id: "conditional-access", label: "Conditional Access" },
  { id: "app-permissions", label: "App permissions" },
  { id: "licence-coverage", label: "Licence coverage" },
  { id: "defender", label: "Defender for Cloud" },
  { id: "safety-nets", label: "Safety nets" },
  { id: "history-storage", label: "History storage" },
];

function spnPrefix(toolId) {
  return toolId ? `${toolId.toUpperCase().replace(/-/g, "_")}_` : "";
}

for (const tool of TOOL_SPNS) {
  const p = spnPrefix(tool.id);
  const group = `SPN override: ${tool.label}`;
  const common = { group, collapsible: true, spnTool: tool.id };
  FIELDS.push(
    { key: `${p}AZURE_AUTH_TYPE`, label: "Auth type", ...common, options: AUTH_TYPES, defaultValue: "secret" },
    { key: `${p}AZURE_CLIENT_ID`, label: "Client ID", ...common, hint: "Blank = use the shared SPN. Managed identity: the user-assigned identity's client ID" },
    { key: `${p}AZURE_CLIENT_SECRET`, label: "Client secret", ...common, secret: true, authOnly: SECRET_ONLY },
    { key: `${p}AZURE_TENANT_ID`, label: "Tenant ID", ...common, authOnly: NEEDS_TENANT, hint: "Blank = shared tenant" },
    { key: `${p}AZURE_FEDERATED_MI_CLIENT_ID`, label: "Managed identity it trusts", ...common, authOnly: FEDERATED_ONLY, hint: "Blank = DASHBOARD_FEDERATED_MI_CLIENT_ID" }
  );
}
const KEYS = FIELDS.map((f) => f.key);
const SECRET_KEYS = new Set(FIELDS.filter((f) => f.secret).map((f) => f.key));

function readOverrides() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

function writeOverrides(overrides) {
  writeAtomic(SETTINGS_PATH, overrides);
}

// { "<tenant key>": { KEY: value } }
function readTenantOverrides() {
  try {
    const all = JSON.parse(fs.readFileSync(TENANT_SETTINGS_PATH, "utf8"));
    return all && typeof all === "object" && !Array.isArray(all) ? all : {};
  } catch {
    return {};
  }
}

function writeTenantOverrides(all) {
  writeAtomic(TENANT_SETTINGS_PATH, all);
}

const PER_TENANT_KEYS = new Set(FIELDS.filter((f) => f.perTenant).map((f) => f.key));
const isCustomer = (tenantKey) => Boolean(tenantKey) && tenantKey !== HOME;

// A secret typed into Settings: from the key vault when one is set (a value
// still in settings.json is used until it has been moved there), else the file.
function storedSecret(key, overrides) {
  const inVault = secretStore.enabled() ? secretStore.get("setting", key) : "";
  if (inVault) return { value: inVault, where: "key vault" };
  if (overrides[key] !== undefined && overrides[key] !== "") return { value: overrides[key], where: "override" };
  return null;
}

function homeValue(key) {
  const overrides = readOverrides();
  if (SECRET_KEYS.has(key)) {
    const s = storedSecret(key, overrides);
    return s ? s.value : process.env[key];
  }
  if (overrides[key] !== undefined && overrides[key] !== "") return overrides[key];
  return process.env[key];
}

// What a tool calls instead of reading process.env directly, so an admin's
// override (including the SPN itself) takes effect without restarting. In a
// customer tenant's scan, that tenant's own value comes first.
function get(key) {
  const tenant = current();
  if (tenant && isCustomer(tenant.key) && PER_TENANT_KEYS.has(key)) {
    const own = (readTenantOverrides()[tenant.key] || {})[key];
    if (own !== undefined && own !== "") return own;
  }
  return homeValue(key);
}

// Secret fields never round-trip their real value to the browser — only
// whether something is currently set, and where it came from. For a customer
// tenant: only the perTenant fields, with homeValue as what blank means.
function getAll(tenantKey) {
  if (isCustomer(tenantKey)) {
    const own = readTenantOverrides()[tenantKey] || {};
    return FIELDS.filter((f) => f.perTenant).map((f) => ({
      ...f,
      value: own[f.key] !== undefined && own[f.key] !== "" ? own[f.key] : "",
      homeValue: homeValue(f.key) || "",
    }));
  }
  const overrides = readOverrides();
  return FIELDS.map((f) => {
    const hasOverride = overrides[f.key] !== undefined && overrides[f.key] !== "";
    if (f.secret) {
      const s = storedSecret(f.key, overrides);
      return {
        ...f,
        value: "",
        isSet: Boolean(s) || Boolean(process.env[f.key]),
        source: s ? s.where : process.env[f.key] ? "env" : "none",
      };
    }
    return {
      ...f,
      value: hasOverride ? overrides[f.key] : "",
      envDefault: process.env[f.key] || "",
    };
  });
}

// body: { values: { KEY: "new value", ... }, clear: ["KEY", ...] }
// Plain fields: an empty string in `values` clears the override (falls back
// to .env). Secret fields ignore an empty string (nothing typed = leave the
// stored secret alone) — clearing one requires listing its key in `clear`.
// With a key vault, secrets go there (before anything else is saved) and never
// into settings.json.
async function setMany(body, tenantKey) {
  const values = (body && body.values) || {};
  const clear = (body && body.clear) || [];
  if (isCustomer(tenantKey)) return setTenant(tenantKey, values);
  const overrides = readOverrides();
  const vault = secretStore.enabled();

  for (const key of clear) {
    if (vault && SECRET_KEYS.has(key)) await secretStore.remove("setting", key);
  }
  for (const key of KEYS) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const v = typeof values[key] === "string" ? values[key].trim() : values[key];
    if (SECRET_KEYS.has(key)) {
      if (!v || clear.includes(key)) continue; // blank = leave whatever is already stored
      if (vault) {
        await secretStore.set("setting", key, v);
        delete overrides[key];
      } else {
        overrides[key] = v;
      }
      continue;
    }
    const field = FIELDS.find((f) => f.key === key);
    if (field.options && v && !field.options.some((o) => o.value === v)) continue;
    if (v === "" || v === null || v === undefined) delete overrides[key];
    else overrides[key] = v;
  }
  for (const key of clear) {
    if (KEYS.includes(key)) delete overrides[key];
  }

  writeOverrides(overrides);
  return getAll();
}

function setTenant(tenantKey, values) {
  const all = readTenantOverrides();
  const own = { ...(all[tenantKey] || {}) };
  for (const key of PER_TENANT_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const v = typeof values[key] === "string" ? values[key].trim() : values[key];
    if (v === "" || v === null || v === undefined) delete own[key];
    else own[key] = v;
  }
  if (Object.keys(own).length) all[tenantKey] = own;
  else delete all[tenantKey];
  writeTenantOverrides(all);
  return getAll(tenantKey);
}

// A removed tenant's own settings go with it.
function dropTenant(tenantKey) {
  const all = readTenantOverrides();
  if (!all[tenantKey]) return;
  delete all[tenantKey];
  writeTenantOverrides(all);
}

// Moves secrets still in settings.json into the key vault (once one is set and
// loaded). Each leaves the file only after the vault has it.
async function moveSecretsToVault() {
  if (!secretStore.enabled() || !secretStore.ready()) return 0;
  let moved = 0;
  for (const key of SECRET_KEYS) {
    const overrides = readOverrides();
    if (overrides[key] === undefined || overrides[key] === "") continue;
    if (!secretStore.has("setting", key)) await secretStore.set("setting", key, String(overrides[key]));
    delete overrides[key];
    writeOverrides(overrides);
    moved++;
  }
  return moved;
}

module.exports = { get, getAll, setMany, dropTenant, moveSecretsToVault, FIELDS, TOOL_SPNS, spnPrefix };
