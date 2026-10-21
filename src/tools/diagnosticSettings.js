// Resources that keep no logs: no diagnostic setting sends their logs
// anywhere, and subscriptions whose activity log is not exported (Azure keeps
// it 90 days only). Key Vaults are left to the Key Vault scan. Reader is enough.
const settings = require("../settings");
const { resourceGraphQuery, armGet, subscriptionIdsToScan } = require("../armClient");
const { mapLimit, runChecks, itemErrors, scanError } = require("./util");

const TOOL_ID = "diagnostic-settings";
const CONCURRENCY = 8;
const MAX_RESOURCES = 1500;
const API = "api-version=2021-05-01-preview";

const DEFAULT_TYPES = [
  "microsoft.containerservice/managedclusters",
  "microsoft.network/applicationgateways",
  "microsoft.network/azurefirewalls",
  "microsoft.network/frontdoors",
  "microsoft.cdn/profiles",
  "microsoft.apimanagement/service",
  "microsoft.recoveryservices/vaults",
  "microsoft.eventhub/namespaces",
  "microsoft.servicebus/namespaces",
  "microsoft.sql/servers/databases",
  "microsoft.storage/storageaccounts",
];

function resourceTypes() {
  const raw = String(settings.get("DIAGNOSTICS_RESOURCE_TYPES") || "").trim();
  if (!raw) return DEFAULT_TYPES;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((t) => /^[a-z0-9.]+\/[a-z0-9/]+$/.test(t) && t !== "microsoft.keyvault/vaults");
}

// Storage logs are set on each service, not the account: blob is the one
// that matters most.
const settingsTarget = (r) => (r.type === "microsoft.storage/storageaccounts" ? `${r.id}/blobServices/default` : r.id);

async function resourceFindings() {
  const types = resourceTypes();
  if (!types.length) return [];
  const rows = await resourceGraphQuery(
    `Resources
    | where type in~ (${types.map((t) => `'${t}'`).join(", ")})
    | where not(type =~ 'microsoft.sql/servers/databases' and name =~ 'master')
    | project id, name, type = tolower(type), resourceGroup, subscriptionId`,
    { toolId: TOOL_ID }
  );
  const findings = [];
  const checked = rows.slice(0, MAX_RESOURCES);
  const failures = await mapLimit(checked, CONCURRENCY, async (r) => {
    const data = await armGet(`https://management.azure.com${settingsTarget(r)}/providers/Microsoft.Insights/diagnosticSettings?${API}`, TOOL_ID);
    if ((data.value || []).length) return;
    findings.push({
      kind: "no-diagnostic-setting",
      id: `${r.id}#diagnostics`,
      name: r.name,
      resourceGroup: r.resourceGroup,
      subscriptionId: r.subscriptionId,
      detail: `${r.type.split("/").slice(1).join("/")}: no diagnostic setting, so its logs go nowhere${r.type === "microsoft.storage/storageaccounts" ? " (checked the blob service)" : ""}`,
    });
  });
  if (rows.length > MAX_RESOURCES) findings.push(scanError(TOOL_ID, "resources-cap", `Checked ${MAX_RESOURCES} of ${rows.length} resources`, "Narrow DIAGNOSTICS_RESOURCE_TYPES to check the rest"));
  return [...findings, ...itemErrors(TOOL_ID, "resources", "resources", failures, checked.length)];
}

async function activityLogFindings() {
  const subs = await subscriptionIdsToScan(TOOL_ID);
  const findings = [];
  const failures = await mapLimit(subs, CONCURRENCY, async (sub) => {
    const data = await armGet(`https://management.azure.com/subscriptions/${sub}/providers/Microsoft.Insights/diagnosticSettings?${API}`, TOOL_ID);
    if ((data.value || []).length) return;
    findings.push({
      kind: "activity-log-not-exported",
      id: `/subscriptions/${sub}#activity-log`,
      name: "Activity log",
      subscriptionId: sub,
      detail: "The subscription's activity log (who changed what) is not sent to a workspace or storage; Azure keeps it 90 days",
    });
  });
  return [...findings, ...itemErrors(TOOL_ID, "subscriptions", "subscriptions", failures.map((f) => ({ ...f, item: { subscriptionId: f.item } })), subs.length)];
}

function run() {
  return runChecks(TOOL_ID, { Resources: resourceFindings, "Activity log": activityLogFindings });
}

module.exports = {
  id: TOOL_ID,
  label: "Diagnostic settings",
  schedule: "30 4 * * *", // daily at 04:30
  run,
  DEFAULT_TYPES,
};
