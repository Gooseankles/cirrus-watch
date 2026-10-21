const { graphGet, graphGetAll } = require("../graphClient");
const { resourceGraphQuery, subscriptionNames } = require("../armClient");
const tenants = require("../tenants");
const tenantContext = require("../tenantContext");
const access = require("../access");

const TOOL_ID = "access-lookup";
const ID_BATCH = 200; // principal ids per Resource Graph query

const KNOWN_ROLES = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "Owner",
  "b24988ac-6180-42a0-ab88-20f7382dd24c": "Contributor",
  "acdd72a7-3385-48ef-bd42-f606fba81ae7": "Reader",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
};

// In another tenant the person is often a guest with a different UPN; fall
// back to their mail address there.
async function findUser(upn) {
  const select = "$select=id,displayName,userPrincipalName";
  try {
    return await graphGet(`/users/${encodeURIComponent(upn)}?${select}`, TOOL_ID);
  } catch (err) {
    if (!/\(404\)/.test(err.message) || !upn.includes("@")) throw err;
    const q = upn.replace(/'/g, "''");
    const found = await graphGet(`/users?$filter=${encodeURIComponent(`mail eq '${q}' or otherMails/any(m:m eq '${q}')`)}&${select}`, TOOL_ID);
    if (!found.value || !found.value.length) return null;
    return found.value[0];
  }
}

async function lookup(upn) {
  const user = await findUser(upn);
  if (!user) return null;
  const groups = await graphGetAll(`/users/${user.id}/transitiveMemberOf?$select=id,displayName`, TOOL_ID);
  const principalIds = [user.id, ...groups.map((g) => g.id)];

  // Someone in hundreds of groups made one huge IN list (slow, and near the
  // query size limit): ask in batches instead.
  const rows = [];
  for (let i = 0; i < principalIds.length; i += ID_BATCH) {
    const batch = principalIds.slice(i, i + ID_BATCH);
    rows.push(
      ...(await resourceGraphQuery(
        `
    AuthorizationResources
    | where type == 'microsoft.authorization/roleassignments'
    | where properties.principalId in (${batch.map((id) => `'${id}'`).join(",")})
    | project principalId = properties.principalId, roleDefinitionId = tostring(properties.roleDefinitionId),
        scope = properties.scope, subscriptionId
  `,
        { toolId: TOOL_ID }
      ))
    );
  }

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

// Every tenant the person asking may see; one result per tenant.
async function lookupAll(upn, keys) {
  const targets = tenants.scanTargets().filter((t) => access.inScope(keys, t.key));
  const multi = tenants.isMultiTenant();
  const out = { user: null, groups: [], assignments: [], tenants: [] };
  for (const t of targets) {
    try {
      const r = await tenantContext.runIn(t, () => lookup(upn));
      if (!r) {
        out.tenants.push({ key: t.key, name: t.name, status: "not found" });
        continue;
      }
      out.user ||= r.user;
      out.groups.push(...r.groups.map((g) => (multi ? `${g} (${t.name})` : g)));
      out.assignments.push(...r.assignments.map((a) => ({ ...a, ...(multi && { tenant: t.key, tenantName: t.name }) })));
      out.tenants.push({ key: t.key, name: t.name, status: "found" });
    } catch (err) {
      const notFound = /\(404\)/.test(err.message);
      out.tenants.push({ key: t.key, name: t.name, status: notFound ? "not found" : "error", ...(!notFound && { error: err.message.slice(0, 300) }) });
    }
  }
  return out;
}

function registerRoutes(app) {
  app.get("/api/tools/access-lookup/run", async (req, res) => {
    const upn = req.query.upn;
    if (!upn || typeof upn !== "string") return res.status(400).json({ error: "upn query param is required" });
    try {
      const result = await lookupAll(upn.trim(), access.readScope(req));
      if (!result.user) {
        const errors = result.tenants.filter((t) => t.status === "error");
        if (errors.length) return res.status(500).json({ error: errors.map((t) => (result.tenants.length > 1 ? `${t.name}: ${t.error}` : t.error)).join("; ") });
        return res.status(404).json({ error: `${upn} was not found${result.tenants.length > 1 ? " in any tenant" : ""}` });
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { id: "access-lookup", label: "Access lookup", registerRoutes };
