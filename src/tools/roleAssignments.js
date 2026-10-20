// Role assignment hygiene:
// - orphaned: the user, group or service principal no longer exists in Entra
//   (the portal shows "Identity not found"); they still count towards the limit
//   and are safe to delete.
// - limit: Azure allows 4,000 role assignments per subscription (resource group
//   and resource assignments included); new ones fail once it is reached.
const { resourceGraphQuery } = require("../armClient");
const { graphPost } = require("../graphClient");
const settings = require("../settings");
const log = require("../log");

const TOOL_ID = "role-assignments";
const SUBSCRIPTION_LIMIT = 4000;
const CHECKED_TYPES = new Set(["user", "group", "serviceprincipal", "unknown", ""]);

function warnPct() {
  return Number(settings.get("ROLE_ASSIGNMENT_LIMIT_WARN_PCT")) || 80;
}

function scopeText(scope) {
  const s = scope || "";
  const mg = s.match(/managementGroups\/([^/]+)$/i);
  if (mg) return `management group ${mg[1]}`;
  if (s === "/") return "tenant root";
  if (/^\/subscriptions\/[^/]+\/?$/i.test(s)) return "whole subscription";
  return s.replace(/^\/subscriptions\/[^/]+/i, "").replace(/^\/resourceGroups\//i, "rg ").replace(/\/providers\//i, " / ");
}

// Which of these object IDs still exist (users, groups, service principals).
async function existingIds(ids) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += 1000) {
    const page = await graphPost(
      "/directoryObjects/getByIds?$select=id",
      { ids: ids.slice(i, i + 1000), types: ["user", "group", "servicePrincipal"] },
      TOOL_ID
    );
    for (const o of page.value || []) found.add(String(o.id).toLowerCase());
  }
  return found;
}

async function run() {
  const rows = await resourceGraphQuery(
    `AuthorizationResources
     | where type =~ 'microsoft.authorization/roleassignments'
     | extend principalId = tolower(tostring(properties.principalId)),
              principalType = tostring(properties.principalType),
              scope = tostring(properties.scope),
              roleDefinitionId = tostring(properties.roleDefinitionId),
              createdOn = tostring(properties.createdOn)
     | project id, subscriptionId, resourceGroup, principalId, principalType, scope, roleDefinitionId, createdOn`,
    { toolId: TOOL_ID }
  );
  const roleNames = new Map(
    (
      await resourceGraphQuery(
        `AuthorizationResources
         | where type =~ 'microsoft.authorization/roledefinitions'
         | project id = tolower(id), roleName = tostring(properties.roleName)`,
        { toolId: TOOL_ID, subscriptions: [] }
      ).catch(() => [])
    ).map((r) => [r.id.split("/").pop(), r.roleName])
  );
  const roleName = (rid) => roleNames.get(String(rid).toLowerCase().split("/").pop()) || String(rid).split("/").pop();

  const findings = [];

  // --- Limit ---
  const perSub = new Map();
  for (const r of rows) {
    if (!r.subscriptionId || !/^\/subscriptions\//i.test(r.scope)) continue; // management group ones do not count
    perSub.set(r.subscriptionId, (perSub.get(r.subscriptionId) || 0) + 1);
  }
  for (const [sub, n] of perSub) {
    const pct = Math.round((n / SUBSCRIPTION_LIMIT) * 100);
    if (pct < warnPct()) continue;
    findings.push({
      kind: "assignment-limit",
      id: `limit/${sub}`,
      name: `${n} of ${SUBSCRIPTION_LIMIT} role assignments`,
      subscriptionId: sub,
      resourceGroup: null,
      count: n,
      detail: `${pct}% of the per-subscription limit: new assignments fail at ${SUBSCRIPTION_LIMIT}; delete orphaned ones or assign to groups`,
    });
  }

  // --- Orphaned ---
  const candidates = rows.filter((r) => r.principalId && CHECKED_TYPES.has(r.principalType.toLowerCase()));
  const ids = [...new Set(candidates.map((r) => r.principalId))];
  const found = await existingIds(ids);
  const missing = ids.filter((id) => !found.has(id));
  // A Graph permission gap looks like "everyone is gone"; say so instead.
  if (ids.length > 20 && missing.length / ids.length > 0.5) {
    throw new Error(
      `${missing.length} of ${ids.length} principals not found in Entra; that is more likely missing Graph permissions ` +
        `(User.Read.All, GroupMember.Read.All, Application.Read.All) than deleted identities`
    );
  }
  const missingSet = new Set(missing);
  for (const r of candidates) {
    if (!missingSet.has(r.principalId)) continue;
    const role = roleName(r.roleDefinitionId);
    findings.push({
      kind: "orphaned-assignment",
      id: r.id,
      name: `${role} for a deleted ${/^(user|group)$/i.test(r.principalType) ? r.principalType.toLowerCase() : /serviceprincipal/i.test(r.principalType) ? "app" : "identity"}`,
      subscriptionId: r.subscriptionId || null,
      resourceGroup: r.resourceGroup || null,
      principalId: r.principalId,
      role,
      scope: r.scope,
      createdOn: r.createdOn || null,
      detail: `${scopeText(r.scope)}; object ${r.principalId} no longer exists${r.createdOn ? `; assigned ${r.createdOn.slice(0, 10)}` : ""}`,
    });
  }

  log.record({
    tool: TOOL_ID,
    level: "info",
    message: `${rows.length} role assignment(s), ${missingSet.size} deleted principal(s), busiest subscription ${Math.max(0, ...perSub.values())}/${SUBSCRIPTION_LIMIT}`,
  });
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Role assignments",
  schedule: "15 4 * * *", // nightly at 04:15
  run,
};
