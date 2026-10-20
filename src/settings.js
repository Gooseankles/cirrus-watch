// Everything on the admin-only Settings tab: scan thresholds AND the Azure
// connection itself (shared SPN, per-tool SPNs, subscription and billing scope). An
// override here wins over .env; leaving a plain field blank falls back to
// .env (or that tool's own built-in default). Secret fields (client
// secrets, passwords) work differently — see setMany below.
const fs = require("fs");
const path = require("path");

const { DATA_DIR } = require("./paths");

const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");

const AUTH_TYPES = [
  { value: "secret", label: "Client secret" },
  { value: "managed-identity", label: "Managed identity" },
];

const FIELDS = [
  { key: "AZURE_AUTH_TYPE", label: "Auth type", group: "Azure service principal (shared)", options: AUTH_TYPES, defaultValue: "secret" },
  { key: "AZURE_CLIENT_ID", label: "Client ID", group: "Azure service principal (shared)", hint: "Managed identity: the user-assigned identity's client ID, blank = system-assigned" },
  { key: "AZURE_CLIENT_SECRET", label: "Client secret", group: "Azure service principal (shared)", secret: true, secretAuthOnly: true },
  { key: "AZURE_TENANT_ID", label: "Tenant ID", group: "Azure service principal (shared)", secretAuthOnly: true },
  { key: "AZURE_SUBSCRIPTION_IDS", label: "Subscriptions to scan", group: "Azure service principal (shared)", hint: "Comma-separated subscription IDs; blank = every subscription the SPN can see" },

  { key: "AZURE_BILLING_SCOPE", label: "Billing scope", group: "Subscription creation", hint: "EA enrollment account or MCA invoice section path" },
  { key: "AZURE_MANAGEMENT_GROUP_ID", label: "Management group ID", group: "Subscription creation" },

  { key: "STORAGE_ACCOUNT_URL", label: "Storage account blob URL", group: "History storage", hint: "e.g. https://stdashboard.blob.core.windows.net; blank = keep results on the app's own disk" },
  { key: "STORAGE_CONTAINER", label: "Container", group: "History storage", hint: "Blank = dashboard" },
  { key: "HISTORY_RETENTION_DAYS", label: "Keep run history (days)", group: "History storage", hint: "Blank = 365" },

  { key: "ROLE_ASSIGNMENT_LIMIT_WARN_PCT", label: "Warn at % of the 4,000 limit", group: "Role assignments", hint: "Blank = 80" },
  { key: "POLICY_PROBES", label: "Probe tests to run", group: "Policy check", hint: "Comma-separated: storage-public-blob, storage-http, storage-old-tls, public-ip, keyvault-no-purge-protection, sql-public-network, untagged-resource, denied-region. Blank = all, none = off" },
  { key: "POLICY_PROBE_REGION", label: "Region for probes", group: "Policy check", hint: "An allowed region; blank = norwayeast" },
  { key: "POLICY_PROBE_DENIED_REGION", label: "Region that must be blocked", group: "Policy check", hint: "Enables the denied-region probe, e.g. brazilsouth" },

  { key: "AZURE_REQUIRED_TAGS", label: "Required tags", group: "Tag compliance", hint: "Comma-separated tag names" },
  { key: "AZURE_COST_ANOMALY_THRESHOLD_PCT", label: "Cost jump threshold (%)", group: "Cost anomalies" },
  { key: "COST_HISTORY_MONTHS", label: "Cost history to pull on first run (months)", group: "Cost anomalies", hint: "Blank = 13; after that it keeps growing from storage" },
  { key: "AZURE_ACCESS_REVIEW_STALE_DAYS", label: "Stale direct-assignment age (days)", group: "Access review" },
  { key: "SECRET_EXPIRY_WARN_DAYS", label: "Warn before expiry (days)", group: "Expiring secrets/certs" },
  { key: "ACCESS_PACKAGE_EXPIRY_WARN_DAYS", label: "Assignment expiry warning (days)", group: "Access packages" },
  { key: "ACCESS_PACKAGE_STALE_PENDING_DAYS", label: "Pending request stale age (days)", group: "Access packages" },
  { key: "ACCESS_PACKAGE_UNUSED_AGE_DAYS", label: "Unused package age (days)", group: "Access packages" },
];

// Optional least-privilege SPN per tool. A tool uses its own SPN only when
// its client ID is set; otherwise it uses the shared one above.
const TOOL_SPNS = [
  { id: "subscription-create", label: "Subscription creation" },
  { id: "subscription-decommission", label: "Subscription decommission" },
  { id: "access-lookup", label: "Access lookup" },
  { id: "orphaned-resources", label: "Orphaned resources" },
  { id: "tag-compliance", label: "Tag compliance" },
  { id: "cost-anomaly", label: "Cost anomalies" },
  { id: "access-review", label: "Access review" },
  { id: "secret-expiry", label: "Expiring secrets/certs" },
  { id: "access-packages", label: "Access packages" },
  { id: "role-assignments", label: "Role assignments" },
  { id: "policy-check", label: "Policy check" },
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
    { key: `${p}AZURE_CLIENT_SECRET`, label: "Client secret", ...common, secret: true, secretAuthOnly: true },
    { key: `${p}AZURE_TENANT_ID`, label: "Tenant ID", ...common, secretAuthOnly: true, hint: "Blank = shared tenant" }
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
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(overrides, null, 2));
}

// What a tool calls instead of reading process.env directly, so an admin's
// override (including the SPN itself) takes effect without restarting.
function get(key) {
  const overrides = readOverrides();
  if (overrides[key] !== undefined && overrides[key] !== "") return overrides[key];
  return process.env[key];
}

// Secret fields never round-trip their real value to the browser — only
// whether something is currently set, and where it came from.
function getAll() {
  const overrides = readOverrides();
  return FIELDS.map((f) => {
    const hasOverride = overrides[f.key] !== undefined && overrides[f.key] !== "";
    if (f.secret) {
      return {
        ...f,
        value: "",
        isSet: hasOverride || Boolean(process.env[f.key]),
        source: hasOverride ? "override" : process.env[f.key] ? "env" : "none",
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
function setMany(body) {
  const values = (body && body.values) || {};
  const clear = (body && body.clear) || [];
  const overrides = readOverrides();

  for (const key of KEYS) {
    if (!Object.prototype.hasOwnProperty.call(values, key)) continue;
    const v = typeof values[key] === "string" ? values[key].trim() : values[key];
    if (SECRET_KEYS.has(key)) {
      if (v) overrides[key] = v; // blank = leave whatever is already stored
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

module.exports = { get, getAll, setMany, FIELDS, TOOL_SPNS, spnPrefix };
