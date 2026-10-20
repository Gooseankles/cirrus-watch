const { resourceGraphQuery } = require("../armClient");
const { graphPost } = require("../graphClient");
const settings = require("../settings");
const log = require("../log");

const TOOL_ID = "access-review";

// Well-known built-in role definition GUIDs (the last segment of
// roleDefinitionId) — covers the common ones worth flagging without an
// extra ARM call per assignment to resolve the role's display name.
const KNOWN_ROLES = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "Owner",
  "b24988ac-6180-42a0-ab88-20f7382dd24c": "Contributor",
  "acdd72a7-3385-48ef-bd42-f606fba81ae7": "Reader",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
};

function staleDays() {
  return Number(settings.get("AZURE_ACCESS_REVIEW_STALE_DAYS")) || 365;
}

// Object ID -> "Display Name (upn)". Needs Graph User.Read.All (or
// Directory.Read.All) as an Application permission; without it the scan
// still runs and shows object IDs.
async function resolveUserNames(ids) {
  const names = new Map();
  const unique = [...new Set(ids)];
  for (let i = 0; i < unique.length; i += 1000) {
    const page = await graphPost(
      "/directoryObjects/getByIds?$select=id,displayName,userPrincipalName",
      { ids: unique.slice(i, i + 1000), types: ["user"] },
      TOOL_ID
    );
    for (const u of page.value || []) {
      const upn = u.userPrincipalName ? ` (${u.userPrincipalName})` : "";
      names.set(u.id, `${u.displayName || u.id}${upn}`);
    }
  }
  return names;
}

async function run() {
  const rows = await resourceGraphQuery(
    `
    AuthorizationResources
    | where type == 'microsoft.authorization/roleassignments'
    | project id, principalId = properties.principalId, principalType = properties.principalType,
        roleDefinitionId = tostring(properties.roleDefinitionId), scope = properties.scope,
        createdOn = properties.createdOn, subscriptionId
  `,
    { toolId: TOOL_ID }
  );

  const cutoff = Date.now() - staleDays() * 24 * 60 * 60 * 1000;
  const findings = [];

  for (const r of rows) {
    if (r.principalType !== "User") continue; // group-managed access is out of scope for this flag
    const roleGuid = (r.roleDefinitionId || "").split("/").pop();
    const roleName = KNOWN_ROLES[roleGuid] || roleGuid;
    if (!["Owner", "Contributor", "User Access Administrator"].includes(roleName)) continue;

    const createdOn = r.createdOn ? new Date(r.createdOn) : null;
    const isStale = createdOn && createdOn.getTime() < cutoff;
    if (!isStale) continue;

    findings.push({
      kind: "stale-direct-assignment",
      id: r.id,
      name: r.principalId,
      principalId: r.principalId,
      resourceGroup: null,
      subscriptionId: r.subscriptionId,
      detail: `${roleName} directly on a user since ${createdOn.toISOString().slice(0, 10)} (scope: ${r.scope})`,
    });
  }

  if (findings.length) {
    try {
      const names = await resolveUserNames(findings.map((f) => f.principalId));
      for (const f of findings) {
        const name = names.get(f.principalId);
        if (name) f.name = name;
        else f.detail += ` (user ${f.principalId} not found in Entra; deleted?)`;
      }
    } catch (err) {
      log.record({
        tool: TOOL_ID,
        level: "error",
        message: `showing object IDs, could not look up user names (needs Graph User.Read.All): ${err.message}`,
      });
    }
  }
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Access review",
  schedule: "0 5 * * 1", // weekly, Monday 05:00
  run,
};
