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

const MAX_CHAIN_CALLS = 60; // group member lists read per lookup to explain nesting
const groupOnly = (list) => list.filter((g) => !g["@odata.type"] || g["@odata.type"] === "#microsoft.graph.group");

async function roleRows(principalIds) {
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
  return rows;
}

// How a nested group reaches the start: the groups in between, nearest the
// start first, ending with the target. Searches down from each target through
// group members that are in `within`, until it meets one of `starts` (the
// groups the user or group is a direct member of). Member lists are shared
// between targets, and the number read is capped; a chain it could not finish
// is left out.
function chainFinder(starts, within) {
  const members = new Map();
  let calls = 0;
  async function childGroups(id) {
    if (members.has(id)) return members.get(id);
    if (calls >= MAX_CHAIN_CALLS) return null;
    calls++;
    const list = await graphGetAll(`/groups/${id}/members/microsoft.graph.group?$select=id`, TOOL_ID).catch(() => []);
    const ids = list.map((g) => g.id).filter((x) => within.has(x));
    members.set(id, ids);
    return ids;
  }
  return async function chain(target) {
    if (starts.has(target)) return [target];
    const parent = new Map([[target, null]]);
    let level = [target];
    while (level.length) {
      const next = [];
      for (const id of level) {
        const kids = await childGroups(id);
        if (!kids) return null;
        for (const k of kids) {
          if (parent.has(k)) continue;
          parent.set(k, id);
          if (starts.has(k)) {
            const out = [];
            for (let at = k; at; at = parent.get(at)) out.push(at);
            return out;
          }
          next.push(k);
        }
      }
      level = next;
    }
    return null;
  };
}

// How a role reaches the principal: direct, or the chain of groups (the group
// it is a direct member of first, the group holding the role last). nested =
// more than one group in the chain, or a chain that could not be traced.
function viaOf(principalId, selfId, groupNameById, chains) {
  if (principalId === selfId) return { via: "direct", path: [], nested: false };
  return {
    via: `group: ${groupNameById[principalId] || principalId}`,
    path: (chains.get(principalId) || [principalId]).map((id) => groupNameById[id] || id),
    nested: !chains.has(principalId) || chains.get(principalId).length > 1,
  };
}

const ENTRA_BATCH = 15; // principal ids per "in" filter
const ENTRA_SELECT = "$select=principalId,directoryScopeId&$expand=roleDefinition($select=displayName,isBuiltIn,templateId)";

async function entraPages(path, principalIds) {
  const out = [];
  for (let i = 0; i < principalIds.length; i += ENTRA_BATCH) {
    const ids = principalIds.slice(i, i + ENTRA_BATCH).map((id) => `'${id}'`).join(",");
    out.push(...(await graphGetAll(`${path}?$filter=${encodeURIComponent(`principalId in (${ids})`)}&${ENTRA_SELECT}`, TOOL_ID)));
  }
  return out;
}

// Entra ID (directory) roles held by these principals: active ones, and the
// ones PIM lets them activate. Eligible roles need Entra ID P2; without it that
// part is skipped with a note. Only role-assignable groups can hold Entra roles.
async function entraRoles(principalIds) {
  const out = { active: [], eligible: [], notes: [] };
  try {
    out.active = await entraPages("/roleManagement/directory/roleAssignments", principalIds);
  } catch (err) {
    out.notes.push(/\(403\)/.test(err.message) ? "Entra roles could not be read: the access lookup needs RoleManagement.Read.Directory" : `Entra roles could not be read: ${err.message.slice(0, 200)}`);
    return out;
  }
  try {
    out.eligible = await entraPages("/roleManagement/directory/roleEligibilityScheduleInstances", principalIds);
  } catch {
    out.notes.push("Eligible (PIM) roles could not be read; that needs Entra ID P2");
  }
  return out;
}

const entraScope = (s) => (!s || s === "/" ? "Whole directory" : s.startsWith("/administrativeUnits/") ? `Administrative unit ${s.split("/")[2]}` : s);
const entraKey = (r) => `${r.principalId}|${r.roleDefinition && r.roleDefinition.templateId}|${r.directoryScopeId}`;

// The access of one principal (a user or a group): its own Azure and Entra
// role assignments and those of every group it sits in, with the chain of
// groups for each.
async function accessOf(selfId, kind) {
  const base = kind === "user" ? `/users/${selfId}` : `/groups/${selfId}`;
  const [direct, all] = await Promise.all([
    graphGetAll(`${base}/memberOf?$select=id,displayName`, TOOL_ID).then(groupOnly),
    graphGetAll(`${base}/transitiveMemberOf?$select=id,displayName`, TOOL_ID).then(groupOnly),
  ]);
  const principalIds = [selfId, ...all.map((g) => g.id)];
  const [rows, entra] = await Promise.all([roleRows(principalIds), entraRoles(principalIds)]);
  const groupNameById = Object.fromEntries(all.map((g) => [g.id, g.displayName]));
  const starts = new Set(direct.map((g) => g.id));
  const chain = chainFinder(starts, new Set(all.map((g) => g.id)));
  const chains = new Map();
  const holders = [...rows, ...entra.active, ...entra.eligible].map((r) => r.principalId).filter((id) => id !== selfId);
  for (const id of new Set(holders)) {
    const c = await chain(id);
    if (c) chains.set(id, c);
  }
  const subNames = await subscriptionNames(TOOL_ID).catch(() => new Map());
  const entraRow = (r, state) => ({
    ...viaOf(r.principalId, selfId, groupNameById, chains),
    role: (r.roleDefinition && r.roleDefinition.displayName) || "Unknown role",
    builtIn: !!(r.roleDefinition && r.roleDefinition.isBuiltIn),
    state,
    scope: entraScope(r.directoryScopeId),
  });
  // An activated PIM role also shows as an assignment; keep it once, as active.
  const activeKeys = new Set(entra.active.map(entraKey));
  return {
    groups: all.map((g) => ({
      name: g.displayName,
      direct: starts.has(g.id),
      ...(chains.has(g.id) && chains.get(g.id).length > 1 && { through: chains.get(g.id).slice(0, -1).map((id) => groupNameById[id] || id) }),
    })),
    assignments: rows.map((r) => {
      const roleGuid = (r.roleDefinitionId || "").split("/").pop();
      return {
        ...viaOf(r.principalId, selfId, groupNameById, chains),
        role: KNOWN_ROLES[roleGuid] || roleGuid,
        scope: r.scope,
        subscriptionId: r.subscriptionId,
        subscriptionName: subNames.get(r.subscriptionId) || null,
      };
    }),
    entraRoles: [...entra.active.map((r) => entraRow(r, "active")), ...entra.eligible.filter((r) => !activeKeys.has(entraKey(r))).map((r) => entraRow(r, "eligible"))],
    entraNotes: entra.notes,
  };
}

async function lookup(upn) {
  const user = await findUser(upn);
  if (!user) return null;
  return { user: { displayName: user.displayName, upn: user.userPrincipalName }, ...(await accessOf(user.id, "user")) };
}

// Every tenant the person asking may see; one result per tenant.
async function lookupAll(upn, keys) {
  const targets = tenants.scanTargets().filter((t) => access.inScope(keys, t.key));
  const multi = tenants.isMultiTenant();
  const out = { user: null, groups: [], assignments: [], entraRoles: [], entraNotes: [], tenants: [] };
  for (const t of targets) {
    try {
      const r = await tenantContext.runIn(t, () => lookup(upn));
      if (!r) {
        out.tenants.push({ key: t.key, name: t.name, status: "not found" });
        continue;
      }
      out.user ||= r.user;
      out.groups.push(...r.groups.map((g) => ({ ...g, ...(multi && { tenantName: t.name }) })));
      out.assignments.push(...r.assignments.map((a) => ({ ...a, ...(multi && { tenant: t.key, tenantName: t.name }) })));
      out.entraRoles.push(...r.entraRoles.map((a) => ({ ...a, ...(multi && { tenantName: t.name }) })));
      out.entraNotes.push(...r.entraNotes.map((n) => (multi ? `${t.name}: ${n}` : n)));
      out.tenants.push({ key: t.key, name: t.name, status: "found" });
    } catch (err) {
      const notFound = /\(404\)/.test(err.message);
      out.tenants.push({ key: t.key, name: t.name, status: notFound ? "not found" : "error", ...(!notFound && { error: err.message.slice(0, 300) }) });
    }
  }
  return out;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GROUP_FIELDS = "$select=id,displayName,description,mail,securityEnabled,groupTypes";
const MAX_MEMBERS = 500;

// Groups whose name starts with the text (or with this ID), in every tenant
// the person may see; at most 15 per tenant.
async function searchGroups(text, keys) {
  const targets = tenants.scanTargets().filter((t) => access.inScope(keys, t.key));
  const out = { groups: [], tenants: [] };
  for (const t of targets) {
    try {
      const found = await tenantContext.runIn(t, async () => {
        if (GUID.test(text)) {
          const g = await graphGet(`/groups/${text}?${GROUP_FIELDS}`, TOOL_ID).catch((err) => (/\(404\)/.test(err.message) ? null : Promise.reject(err)));
          return g ? [g] : [];
        }
        const q = text.replace(/'/g, "''");
        const page = await graphGet(`/groups?$filter=${encodeURIComponent(`startswith(displayName,'${q}')`)}&${GROUP_FIELDS}&$top=15`, TOOL_ID);
        return page.value || [];
      });
      out.groups.push(...found.map((g) => ({ id: g.id, name: g.displayName, description: g.description || "", mail: g.mail || "", tenant: t.key, tenantName: t.name })));
      out.tenants.push({ key: t.key, name: t.name, status: "searched" });
    } catch (err) {
      out.tenants.push({ key: t.key, name: t.name, status: "error", error: err.message.slice(0, 300) });
    }
  }
  return out;
}

// One group: what it gives (its own roles and those of groups it sits in) and
// who is in it (direct members, at most MAX_MEMBERS).
async function groupDetail(id) {
  const g = await graphGet(`/groups/${id}?${GROUP_FIELDS}`, TOOL_ID);
  const [acc, members] = await Promise.all([
    accessOf(id, "group"),
    graphGet(`/groups/${id}/members?$select=id,displayName,userPrincipalName&$top=${MAX_MEMBERS}`, TOOL_ID),
  ]);
  const list = (members.value || []).map((m) => ({
    name: m.displayName || m.id,
    upn: m.userPrincipalName || "",
    type: String(m["@odata.type"] || "").replace("#microsoft.graph.", "") || "unknown",
  }));
  return {
    group: { id: g.id, name: g.displayName, description: g.description || "", mail: g.mail || "", security: !!g.securityEnabled, m365: (g.groupTypes || []).includes("Unified") },
    ...acc,
    members: list,
    moreMembers: !!members["@odata.nextLink"],
  };
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
  app.get("/api/tools/access-lookup/groups", async (req, res) => {
    const text = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (text.length < 2 || text.length > 120) return res.status(400).json({ error: "type at least 2 characters of the group name" });
    try {
      const result = await searchGroups(text, access.readScope(req));
      const errors = result.tenants.filter((t) => t.status === "error");
      if (!result.groups.length && errors.length === result.tenants.length && errors.length) return res.status(500).json({ error: errors.map((t) => t.error).join("; ") });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/api/tools/access-lookup/group/:id", async (req, res) => {
    if (!GUID.test(req.params.id)) return res.status(400).json({ error: "not a group ID" });
    // ?in= names the group's tenant (the page adds ?tenant= for the open tab
    // to every request, so that name is taken).
    const keys = access.readScope(req);
    const wanted = typeof req.query.in === "string" && req.query.in ? req.query.in.toLowerCase() : null;
    const target = tenants.scanTargets().find((t) => (wanted ? t.key === wanted : true) && access.inScope(keys, t.key));
    if (!target) return res.status(404).json({ error: "tenant not found" });
    try {
      const r = await tenantContext.runIn(target, () => groupDetail(req.params.id));
      res.json({ ...r, tenant: target.key, tenantName: target.name });
    } catch (err) {
      res.status(/\(404\)/.test(err.message) ? 404 : 500).json({ error: /\(404\)/.test(err.message) ? "group not found" : err.message });
    }
  });
}

module.exports = { id: "access-lookup", label: "Access lookup", registerRoutes };
