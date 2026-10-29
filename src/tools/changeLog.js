// What changed in the last day (Resource Graph change history): resources
// created, updated or deleted by people and apps, with security-relevant
// changes (network rules, public access, TLS, access policies, role
// assignments) called out. Informational: not counted in scores or totals.
// Reader is enough.
const { resourceGraphQuery } = require("../armClient");
const { numberSetting, nameOf } = require("./util");

const TOOL_ID = "change-log";
const MAX_CHANGES = 1000;

const SECURITY_PROPERTY = /networkAcls|securityRules|publicNetworkAccess|minimumTlsVersion|minTlsVersion|minimalTlsVersion|accessPolicies|firewallRules|ipRules|ipSecurityRestrictions|allowBlobPublicAccess|supportsHttpsTrafficOnly|httpsOnly|enableRbacAuthorization|enableSoftDelete|enablePurgeProtection|publicIPAddress|disableLocalAuth|allowSharedKeyAccess/i;
// Anything under Microsoft.Authorization, or a type that names an NSG or firewall anywhere.
const SECURITY_TYPE = /^(?:microsoft\.authorization\/|.*(?:networksecuritygroups|firewallpolicies|azurefirewalls))/i;
const VERB = { Create: "created", Update: "changed", Delete: "deleted" };

async function run() {
  const hours = numberSetting("CHANGE_LOG_HOURS", 24, { min: 1, max: 14 * 24 });
  const rows = await resourceGraphQuery(
    `resourcechanges
    | extend at = todatetime(properties.changeAttributes.timestamp)
    | where at > ago(${hours}h)
    | extend byType = tostring(properties.changeAttributes.changedByType)
    | where byType !~ 'System'
    | project at, targetId = tostring(properties.targetResourceId), targetType = tolower(tostring(properties.targetResourceType)),
        changeType = tostring(properties.changeType), by = tostring(properties.changeAttributes.changedBy), byType,
        client = tostring(properties.changeAttributes.clientType), changes = properties.changes, subscriptionId, resourceGroup
    | order by at desc
    | take ${MAX_CHANGES}`,
    { toolId: TOOL_ID }
  );

  // One finding per resource and kind, with every change to it listed.
  const groups = new Map();
  for (const r of rows) {
    const props = Object.keys(r.changes || {}).filter((k) => !/^(etag|properties\.provisioningState|systemData)/i.test(k));
    const security = SECURITY_TYPE.test(r.targetType) || props.some((p) => SECURITY_PROPERTY.test(p));
    const kind = security ? "security-change" : r.changeType === "Create" ? "resource-created" : r.changeType === "Delete" ? "resource-deleted" : "resource-updated";
    if (kind === "resource-updated" && !props.length) continue; // only metadata moved
    const key = `${r.targetId.toLowerCase()}|${kind}`;
    if (!groups.has(key)) groups.set(key, { r, kind, changes: [] });
    groups.get(key).changes.push({ at: r.at, type: r.changeType, by: r.by || "unknown", client: r.client || "", props });
  }

  return [...groups.values()].map(({ r, kind, changes }) => {
    const last = changes[0];
    const who = [...new Set(changes.map((c) => c.by))].slice(0, 3).join(", ");
    const props = [...new Set(changes.flatMap((c) => c.props))].slice(0, 6).map((p) => p.replace(/^properties\./, ""));
    return {
      kind,
      id: `${r.targetId}#${kind}`,
      name: nameOf(r.targetId),
      resourceGroup: r.resourceGroup || null,
      subscriptionId: r.subscriptionId || null,
      changedAt: last.at,
      changedBy: who,
      detail:
        `${changes.length > 1 ? `${changes.length} changes, last` : VERB[last.type] || last.type} ${String(last.at).slice(0, 16).replace("T", " ")} UTC by ${who}` +
        `${last.client ? ` (${last.client})` : ""} · ${r.targetType.replace(/^microsoft\./, "")}${props.length ? ` · ${props.join(", ")}` : ""}`,
    };
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Change log",
  schedule: "0 8 * * *", // daily at 08:00, covering the 24 hours before
  info: true,
  run,
};
