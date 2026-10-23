// Role assignment hygiene:
// - orphaned: the user, group or service principal no longer exists in Entra
//   (the portal shows "Identity not found"); they still count towards the limit
//   and are safe to delete.
// - risky access: Owner, Contributor and the roles that grant access given to a
//   person directly (not through a group) on a whole subscription or more, any
//   Azure role held by a guest, and custom roles that allow everything or let
//   the holder hand out access.
// - limit: Azure allows 4,000 role assignments per subscription (resource group
//   and resource assignments included); new ones fail once it is reached.
const { resourceGraphQuery } = require("../armClient");
const { graphPost } = require("../graphClient");
const settings = require("../settings");
const log = require("../log");

const TOOL_ID = "role-assignments";
const SUBSCRIPTION_LIMIT = 4000;
const CHECKED_TYPES = new Set(["user", "group", "serviceprincipal", "unknown", ""]);
// Built-in roles that control everything or who gets access (role definition GUIDs).
const PRIVILEGED = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "Owner",
  "b24988ac-6180-42a0-ab88-20f7382dd24c": "Contributor",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
  "f58310d9-a9f6-439a-9e8d-f62e7b41a168": "Role Based Access Control Administrator",
};
const roleGuid = (rid) => String(rid || "").toLowerCase().split("/").pop();
const wideScope = (scope) => /^\/subscriptions\/[^/]+\/?$/i.test(scope || "") || /managementGroups\/[^/]+$/i.test(scope || "") || scope === "/";
const isGuest = (o) => Boolean(o) && (/^guest$/i.test(o.userType || "") || /#EXT#/i.test(o.userPrincipalName || ""));
const personText = (o, id) => (o ? `${o.displayName || "?"}${o.userPrincipalName ? ` (${o.userPrincipalName})` : ""}` : id);

// notActions that stop "*" from granting access.
const NO_GRANT = new Set(["microsoft.authorization/*", "microsoft.authorization/*/write", "microsoft.authorization/roleassignments/*", "microsoft.authorization/roleassignments/write"]);
// Actions in a custom role that make it as strong as Owner, or let it grant access: [reason].
function broadActions(permissions) {
  const reasons = new Set();
  for (const p of permissions || []) {
    const not = (p.notActions || []).map((a) => String(a).toLowerCase());
    for (const raw of p.actions || []) {
      const a = String(raw).toLowerCase();
      if (a === "*") reasons.add(not.some((n) => NO_GRANT.has(n)) ? "every action (like Contributor)" : "every action (like Owner)");
      else if (a === "microsoft.authorization/*" || a === "microsoft.authorization/roleassignments/*" || a === "microsoft.authorization/roleassignments/write") reasons.add("can give anyone any role");
      else if (a === "microsoft.authorization/roledefinitions/write" || a === "microsoft.authorization/roledefinitions/*") reasons.add("can change role definitions");
    }
  }
  return [...reasons];
}

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

// The users, groups and service principals among these object IDs that still exist: id -> object
// (displayName, userPrincipalName for users).
async function existingObjects(ids) {
  const found = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const page = await graphPost(
      "/directoryObjects/getByIds",
      { ids: ids.slice(i, i + 1000), types: ["user", "group", "servicePrincipal"] },
      TOOL_ID
    );
    for (const o of page.value || []) found.set(String(o.id).toLowerCase(), o);
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
         | project id = tolower(id), roleName = tostring(properties.roleName), roleType = tostring(properties.type),
             permissions = properties.permissions, scopes = properties.assignableScopes, description = tostring(properties.description)`,
        { toolId: TOOL_ID, subscriptions: [] }
      ).catch(() => [])
    ).map((r) => [r.id.split("/").pop(), r])
  );
  const roleName = (rid) => (roleNames.get(roleGuid(rid)) || {}).roleName || PRIVILEGED[roleGuid(rid)] || String(rid).split("/").pop();

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
  const found = await existingObjects(ids);
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

  // --- Risky access ---
  for (const r of rows) {
    if (!/^user$/i.test(r.principalType) || missingSet.has(r.principalId)) continue;
    const who = found.get(r.principalId);
    const guid = roleGuid(r.roleDefinitionId);
    const role = roleName(r.roleDefinitionId);
    const priv = Boolean(PRIVILEGED[guid]);
    const base = { id: `risky/${r.id}`, subscriptionId: r.subscriptionId || null, resourceGroup: r.resourceGroup || null, principalId: r.principalId, role, scope: r.scope, createdOn: r.createdOn || null };
    const when = r.createdOn ? `; assigned ${r.createdOn.slice(0, 10)}` : "";
    if (isGuest(who)) {
      findings.push({
        ...base,
        kind: priv ? "guest-azure-admin" : "guest-azure-role",
        name: `${role} for guest ${who.displayName || r.principalId}`,
        detail: `${scopeText(r.scope)}; ${personText(who, r.principalId)} is a guest from another organisation${priv ? " and can change or delete everything here" : ""}${when}`,
      });
    } else if (priv && wideScope(r.scope)) {
      findings.push({
        ...base,
        kind: "privileged-direct-user",
        name: `${role} for ${(who && who.displayName) || r.principalId}`,
        detail: `${scopeText(r.scope)}; given to ${personText(who, r.principalId)} directly, not through a group or PIM${when}`,
      });
    }
  }
  const useCount = new Map();
  for (const r of rows) useCount.set(roleGuid(r.roleDefinitionId), (useCount.get(roleGuid(r.roleDefinitionId)) || 0) + 1);
  for (const [guid, def] of roleNames) {
    if (!/customrole/i.test(def.roleType)) continue;
    const reasons = broadActions(def.permissions);
    if (!reasons.length) continue;
    const n = useCount.get(guid) || 0;
    const scopes = Array.isArray(def.scopes) ? def.scopes : [];
    const sub = scopes.map((sc) => (String(sc).match(/^\/subscriptions\/([^/]+)/i) || [])[1]).find(Boolean);
    findings.push({
      kind: "custom-role-broad",
      id: def.id,
      name: def.roleName,
      subscriptionId: sub || null,
      resourceGroup: null,
      count: n,
      detail: `Custom role: ${reasons.join(", ")}; ${n ? `held by ${n} assignment${n === 1 ? "" : "s"}` : "not assigned to anyone"}; can be assigned at ${scopes.map(scopeText).join(", ") || "?"}`,
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
  _test: { broadActions, wideScope, isGuest },
};
