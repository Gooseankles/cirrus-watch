// Resources that keep no logs: no diagnostic setting sends their logs
// anywhere, settings that send to a workspace, storage account or event hub
// that was deleted, settings that send metrics but no log category, and
// subscriptions whose activity log is not exported (Azure keeps it 90 days
// only). Key Vaults are left to the Key Vault scan. Reader is enough.
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

// Where settings may send logs, as lower-case resource IDs, and the subscriptions scanned. A destination in a
// subscription that is not scanned cannot be judged and counts as present.
async function destinations() {
  const [rows, subs] = await Promise.all([
    resourceGraphQuery(
      `Resources
      | where type in~ ('microsoft.operationalinsights/workspaces', 'microsoft.storage/storageaccounts', 'microsoft.eventhub/namespaces')
      | project id = tolower(id)`,
      { toolId: TOOL_ID }
    ),
    subscriptionIdsToScan(TOOL_ID),
  ]);
  return { ids: new Set(rows.map((r) => r.id)), subs: new Set(subs.map((s) => String(s).toLowerCase())) };
}

const DEST_FIELDS = [
  ["workspaceId", "workspace"],
  ["storageAccountId", "storage account"],
  ["eventHubAuthorizationRuleId", "event hub namespace"],
];

// The destinations of one setting that no longer exist: [{ what, id }].
function missingDestinations(setting, dest) {
  const p = setting.properties || {};
  const out = [];
  for (const [field, what] of DEST_FIELDS) {
    let id = String(p[field] || "").toLowerCase();
    if (!id) continue;
    if (field === "eventHubAuthorizationRuleId") id = id.replace(/\/authorizationrules\/[^/]+$/, "");
    const sub = (id.match(/^\/subscriptions\/([^/]+)/) || [])[1];
    if (sub && dest.subs.has(sub) && !dest.ids.has(id)) out.push({ what, id: p[field] });
  }
  return out;
}

const hasDestination = (setting) => DEST_FIELDS.some(([f]) => (setting.properties || {})[f]) || Boolean((setting.properties || {}).marketplacePartnerId);
const enabledLogs = (setting) => ((setting.properties || {}).logs || []).filter((l) => l.enabled);
const enabledMetrics = (setting) => ((setting.properties || {}).metrics || []).filter((m) => m.enabled);

// What is wrong with a resource's settings: null when fine, else { kind, detail }.
function judgeSettings(list, dest) {
  const broken = [];
  for (const s of list) for (const m of missingDestinations(s, dest)) broken.push(`${s.name}: ${m.what} ${m.id.split("/").pop()} was deleted`);
  // A setting only counts as keeping logs when it has an enabled log category and a destination that still exists.
  const working = list.filter((s) => hasDestination(s) && !missingDestinations(s, dest).length);
  if (broken.length && !working.some((s) => enabledLogs(s).length)) {
    return { kind: "diagnostic-destination-missing", detail: `Logs go nowhere: ${broken.join("; ")}` };
  }
  if (!working.some((s) => enabledLogs(s).length)) {
    const metrics = list.some((s) => enabledMetrics(s).length);
    return { kind: "diagnostic-no-logs", detail: `${list.length} diagnostic setting${list.length === 1 ? "" : "s"} (${list.map((s) => s.name).join(", ")}) ${metrics ? "send metrics only" : "send nothing"}: no log category is enabled` };
  }
  if (broken.length) return { kind: "diagnostic-destination-missing", detail: `A destination was deleted (other settings still keep logs): ${broken.join("; ")}` };
  return null;
}

async function resourceFindings(dest) {
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
    const list = data.value || [];
    if (list.length) {
      const bad = judgeSettings(list, dest);
      if (bad) findings.push({ kind: bad.kind, id: `${r.id}#diagnostics`, name: r.name, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId, detail: `${r.type.split("/").slice(1).join("/")}: ${bad.detail}` });
      return;
    }
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

async function activityLogFindings(dest) {
  const subs = await subscriptionIdsToScan(TOOL_ID);
  const findings = [];
  const failures = await mapLimit(subs, CONCURRENCY, async (sub) => {
    const data = await armGet(`https://management.azure.com/subscriptions/${sub}/providers/Microsoft.Insights/diagnosticSettings?${API}`, TOOL_ID);
    const list = data.value || [];
    if (list.length) {
      const bad = judgeSettings(list, dest);
      if (bad) findings.push({ kind: bad.kind === "diagnostic-no-logs" ? "activity-log-not-exported" : bad.kind, id: `/subscriptions/${sub}#activity-log`, name: "Activity log", subscriptionId: sub, detail: `Activity log: ${bad.detail}` });
      return;
    }
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

async function run() {
  let destError = null;
  const dest = await destinations().catch((err) => {
    destError = err;
    return { ids: new Set(), subs: new Set() }; // nothing judged as deleted
  });
  const findings = await runChecks(TOOL_ID, { Resources: () => resourceFindings(dest), "Activity log": () => activityLogFindings(dest) });
  if (destError) findings.push(scanError(TOOL_ID, "destinations", "Deleted destinations not checked", String(destError.message || destError).slice(0, 300)));
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Diagnostic settings",
  schedule: "30 4 * * *", // daily at 04:30
  run,
  DEFAULT_TYPES,
  _test: { judgeSettings, missingDestinations },
};
