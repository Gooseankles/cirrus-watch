const { graphGet, graphGetAll } = require("../graphClient");
const { resourceGraphQuery, subscriptionNames } = require("../armClient");

const TOOL_ID = "access-lookup";

const KNOWN_ROLES = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "Owner",
  "b24988ac-6180-42a0-ab88-20f7382dd24c": "Contributor",
  "acdd72a7-3385-48ef-bd42-f606fba81ae7": "Reader",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
};

async function lookup(upn) {
  const user = await graphGet(`/users/${encodeURIComponent(upn)}?$select=id,displayName,userPrincipalName`, TOOL_ID);
  const groups = await graphGetAll(`/users/${user.id}/transitiveMemberOf?$select=id,displayName`, TOOL_ID);
  const principalIds = [user.id, ...groups.map((g) => g.id)];

  const rows = await resourceGraphQuery(
    `
    AuthorizationResources
    | where type == 'microsoft.authorization/roleassignments'
    | where properties.principalId in (${principalIds.map((id) => `'${id}'`).join(",")})
    | project principalId = properties.principalId, roleDefinitionId = tostring(properties.roleDefinitionId),
        scope = properties.scope, subscriptionId
  `,
    { toolId: TOOL_ID }
  );

  const groupNameById = Object.fromEntries(groups.map((g) => [g.id, g.displayName]));
  const subNames = await subscriptionNames(TOOL_ID).catch(() => new Map());

  return {
    user: { displayName: user.displayName, upn: user.userPrincipalName },
    groups: groups.map((g) => g.displayName),
    assignments: rows.map((r) => {
      const roleGuid = (r.roleDefinitionId || "").split("/").pop();
      return {
        via: r.principalId === user.id ? "direct" : `group: ${groupNameById[r.principalId] || r.principalId}`,
        role: KNOWN_ROLES[roleGuid] || roleGuid,
        scope: r.scope,
        subscriptionId: r.subscriptionId,
        subscriptionName: subNames.get(r.subscriptionId) || null,
      };
    }),
  };
}

function registerRoutes(app) {
  app.get("/api/tools/access-lookup/run", async (req, res) => {
    const upn = req.query.upn;
    if (!upn) return res.status(400).json({ error: "upn query param is required" });
    try {
      const result = await lookup(upn);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { id: "access-lookup", label: "Access lookup", registerRoutes };
