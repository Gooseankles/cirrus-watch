const { graphGet, graphGetAll } = require("../graphClient");
const { resourceGraphQuery, subscriptionNames, armGet, subscriptionIdsToScan } = require("../armClient");
const { mapLimit } = require("./util");
const tenants = require("../tenants");
const tenantContext = require("../tenantContext");
const access = require("../access");

const TOOL_ID = "access-lookup";
const ID_BATCH = 200; // principal ids per Resource Graph query
const PIM_API = "api-version=2020-10-01";
const guid = (rid) => String(rid || "").toLowerCase().split("/").pop();

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
const ENTRA_EXPAND = "$expand=roleDefinition($select=displayName,isBuiltIn,templateId)";
const ENTRA_SELECT = `$select=principalId,directoryScopeId,roleDefinitionId&${ENTRA_EXPAND}`;
const ENTRA_SCHEDULE_SELECT = `$select=principalId,directoryScopeId,roleDefinitionId,assignmentType,endDateTime&${ENTRA_EXPAND}`;

async function entraPages(path, principalIds, select = ENTRA_SELECT) {
  const out = [];
  for (let i = 0; i < principalIds.length; i += ENTRA_BATCH) {
    const ids = principalIds.slice(i, i + ENTRA_BATCH).map((id) => `'${id}'`).join(",");
    out.push(...(await graphGetAll(`${path}?$filter=${encodeURIComponent(`principalId in (${ids})`)}&${select}`, TOOL_ID)));
  }
  return out;
}

const entraKey = (r) => `${r.principalId}|${r.roleDefinitionId}|${r.directoryScopeId}`;

// Entra ID (directory) roles held by these principals: active ones, and the
// ones PIM lets them activate. The PIM parts need Entra ID P2; without it they
// are skipped (eligible ones with a note). Only role-assignable groups can hold
// Entra roles. `pim` tells which active ones are PIM ones: activated, or
// assigned with an end date.
async function entraRoles(principalIds) {
  const out = { active: [], eligible: [], pim: new Map(), notes: [] };
  try {
    out.active = await entraPages("/roleManagement/directory/roleAssignments", principalIds);
  } catch (err) {
    out.notes.push(/\(403\)/.test(err.message) ? "Entra roles could not be read: the access lookup needs RoleManagement.Read.Directory" : `Entra roles could not be read: ${err.message.slice(0, 200)}`);
    return out;
  }
  const [eligible, schedules] = await Promise.all([
    entraPages("/roleManagement/directory/roleEligibilityScheduleInstances", principalIds, ENTRA_SCHEDULE_SELECT).catch(() => null),
    entraPages("/roleManagement/directory/roleAssignmentScheduleInstances", principalIds, ENTRA_SCHEDULE_SELECT).catch(() => []),
  ]);
  if (eligible) out.eligible = eligible;
  else out.notes.push("Eligible (PIM) roles could not be read; that needs Entra ID P2");
  for (const r of schedules) {
    if (r.assignmentType === "Activated" || r.endDateTime) out.pim.set(entraKey(r), { state: r.assignmentType === "Activated" ? "activated" : "time-bound", end: r.endDateTime || null });
  }
  return out;
}

async function armAll(url) {
  const rows = [];
  while (url) {
    const page = await armGet(url, TOOL_ID);
    rows.push(...(page.value || []));
    url = page.nextLink;
  }
  return rows;
}

const azureKey = (principalId, role, scope) => `${principalId}|${role}|${String(scope || "").toLowerCase()}`;

// Every PIM schedule instance (eligible and active) in every subscription: two
// paged ARM calls per subscription, the slow part of a lookup. Kept per tenant
// for PIM_CACHE_MS and shared by lookups running at the same time; a read where
// some subscriptions failed is not kept.
const PIM_CACHE_MS = 5 * 60 * 1000;
const pimCache = new Map(); // tenant key -> { at, promise }
function pimInstances() {
  const key = (tenantContext.current() || { key: tenantContext.HOME }).key;
  const hit = pimCache.get(key);
  if (hit && Date.now() - hit.at < PIM_CACHE_MS) return hit.promise;
  const promise = (async () => {
    const subs = await subscriptionIdsToScan(TOOL_ID);
    const bySub = [];
    const failures = await mapLimit(subs, 12, async (s) => {
      const base = `https://management.azure.com/subscriptions/${s}/providers/Microsoft.Authorization`;
      const [eligible, active] = await Promise.all([armAll(`${base}/roleEligibilityScheduleInstances?${PIM_API}`), armAll(`${base}/roleAssignmentScheduleInstances?${PIM_API}`)]);
      bySub.push({ s, eligible, active });
    });
    return { subs, bySub, failures };
  })();
  pimCache.set(key, { at: Date.now(), promise });
  promise.then(
    (r) => r.failures.length && pimCache.get(key)?.promise === promise && pimCache.delete(key),
    () => pimCache.get(key)?.promise === promise && pimCache.delete(key)
  );
  return promise;
}

// PIM for Azure roles: what these principals may activate (eligible), and
// which of their active assignments are PIM ones (activated, or assigned with
// an end date). Read per subscription with Reader. An instance on a management
// group shows up in every subscription below it, so it is kept once; one a
// person gets through a group (memberType Group) is listed through that group.
async function azurePim(principalIds, instances = pimInstances()) {
  const want = new Set(principalIds);
  const out = { eligible: [], active: new Map(), names: new Map(), notes: [] };
  const { subs, bySub, failures } = await instances;
  const seen = new Set();
  for (const { s, eligible, active } of bySub) {
    const read = (r) => {
      const p = r.properties || {};
      const x = p.expandedProperties || {};
      const role = guid(p.roleDefinitionId);
      if (x.roleDefinition && x.roleDefinition.displayName) out.names.set(role, x.roleDefinition.displayName);
      const scope = p.scope || (x.scope && x.scope.id) || `/subscriptions/${s}`;
      return want.has(p.principalId) && p.memberType !== "Group" ? { p, role, scope, key: azureKey(p.principalId, role, scope) } : null;
    };
    for (const r of eligible) {
      const e = read(r);
      if (!e || seen.has(e.key)) continue;
      seen.add(e.key);
      const inSub = e.scope.toLowerCase().startsWith(`/subscriptions/${s}`.toLowerCase());
      out.eligible.push({ principalId: e.p.principalId, role: e.role, scope: e.scope, key: e.key, subscriptionId: inSub ? s : null, end: e.p.endDateTime || null });
    }
    for (const r of active) {
      const a = read(r);
      if (!a || (a.p.assignmentType !== "Activated" && !a.p.endDateTime)) continue;
      out.active.set(a.key, { state: a.p.assignmentType === "Activated" ? "activated" : "time-bound", end: a.p.endDateTime || null });
    }
  }
  if (failures.length) out.notes.push(`PIM for Azure roles could not be read in ${failures.length} of ${subs.length} subscription${subs.length === 1 ? "" : "s"}: ${failures[0].message}`);
  return out;
}

// PIM for Groups: groups the principal may join or own by activating
// (eligible), and memberships that are activated or end on a date. Needs
// Entra ID P2 and PrivilegedEligibilitySchedule.Read.AzureADGroup and
// PrivilegedAssignmentSchedule.Read.AzureADGroup; without them it is skipped
// with a note.
async function groupPim(principalId) {
  const out = { eligible: [], active: new Map(), notes: [] };
  const filter = `$filter=${encodeURIComponent(`principalId eq '${principalId}'`)}`;
  let eligible, active;
  try {
    [eligible, active] = await Promise.all([
      graphGetAll(`/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances?${filter}`, TOOL_ID),
      graphGetAll(`/identityGovernance/privilegedAccess/group/assignmentScheduleInstances?${filter}`, TOOL_ID),
    ]);
  } catch (err) {
    out.notes.push(
      /\(403\)/.test(err.message)
        ? "Eligible group memberships (PIM for Groups) could not be read: that needs PrivilegedEligibilitySchedule.Read.AzureADGroup and PrivilegedAssignmentSchedule.Read.AzureADGroup"
        : "Eligible group memberships (PIM for Groups) could not be read; that needs Entra ID P2"
    );
    return out;
  }
  for (const a of active) {
    if (a.accessId === "member" && (a.assignmentType === "Activated" || a.endDateTime)) out.active.set(a.groupId, { state: a.assignmentType === "Activated" ? "activated" : "time-bound", end: a.endDateTime || null });
  }
  const names = new Map();
  await mapLimit([...new Set(eligible.map((e) => e.groupId))], 6, async (id) => {
    const g = await graphGet(`/groups/${id}?$select=displayName`, TOOL_ID);
    names.set(id, g.displayName);
  });
  out.eligible = eligible.map((e) => ({ groupId: e.groupId, name: names.get(e.groupId) || e.groupId, access: e.accessId === "owner" ? "owner" : "member", end: e.endDateTime || null }));
  return out;
}

const entraScope = (s) => (!s || s === "/" ? "Whole directory" : s.startsWith("/administrativeUnits/") ? `Administrative unit ${s.split("/")[2]}` : s);

// The access of one principal (a user or a group): its own Azure and Entra
// role assignments and those of every group it sits in, with the chain of
// groups for each. PIM is included: eligible Azure and Entra roles, which
// active ones were activated or end on a date, and the roles of groups the
// principal may join through PIM for Groups (and of the groups those sit in).
async function accessOf(selfId, kind) {
  const base = kind === "user" ? `/users/${selfId}` : `/groups/${selfId}`;
  // The PIM list does not depend on who is asked about: start it now, beside the group reads.
  const pim = pimInstances();
  pim.catch(() => {}); // awaited below; this only stops an early throw from leaving it unhandled
  const [direct, all, gpim] = await Promise.all([
    graphGetAll(`${base}/memberOf?$select=id,displayName`, TOOL_ID).then(groupOnly),
    graphGetAll(`${base}/transitiveMemberOf?$select=id,displayName`, TOOL_ID).then(groupOnly),
    groupPim(selfId),
  ]);
  const memberIds = new Set(all.map((g) => g.id));
  // An activation makes the principal a real member; only groups it is not in
  // yet add access. An eligible owner can add themselves, so that counts too.
  const pimGroups = gpim.eligible.filter((e) => !memberIds.has(e.groupId));
  const pimVia = new Map(); // principal id -> { path, access, end }
  await mapLimit(pimGroups, 4, async (e) => {
    if (!pimVia.has(e.groupId)) pimVia.set(e.groupId, { path: [e.name], access: e.access, end: e.end });
    const parents = await graphGetAll(`/groups/${e.groupId}/transitiveMemberOf?$select=id,displayName`, TOOL_ID).then(groupOnly);
    for (const p of parents) if (!memberIds.has(p.id) && p.id !== selfId && !pimVia.has(p.id)) pimVia.set(p.id, { path: [e.name, p.displayName], access: e.access, end: e.end });
  });
  const principalIds = [selfId, ...memberIds, ...pimVia.keys()];
  const [rows, entra, azure] = await Promise.all([roleRows(principalIds), entraRoles(principalIds), azurePim(principalIds, pim)]);
  const groupNameById = Object.fromEntries(all.map((g) => [g.id, g.displayName]));
  const starts = new Set(direct.map((g) => g.id));
  const chain = chainFinder(starts, memberIds);
  const chains = new Map();
  const holders = [...rows, ...entra.active, ...entra.eligible, ...azure.eligible].map((r) => r.principalId).filter((id) => id !== selfId && !pimVia.has(id));
  for (const id of new Set(holders)) {
    const c = await chain(id);
    if (c) chains.set(id, c);
  }
  // A role held by a group the principal may activate into is eligible, until
  // that group eligibility ends.
  const via = (principalId) => {
    const p = pimVia.get(principalId);
    if (!p) return viaOf(principalId, selfId, groupNameById, chains);
    return { via: `PIM group: ${p.path[0]}`, path: p.path, nested: p.path.length > 1, pimGroup: p.access };
  };
  // Eligible twice over (a role eligible to a group the principal may join): the earlier end counts.
  const earliest = (x, y) => (!x ? y || null : !y ? x : x < y ? x : y);
  const stateOf = (principalId, pim, end = null) => {
    const p = pimVia.get(principalId);
    if (p) return { state: "eligible", end: earliest(p.end, end) };
    return pim ? { state: pim.state, end: pim.end } : { state: "active", end: null };
  };
  const subNames = await subscriptionNames(TOOL_ID).catch(() => new Map());
  const roleName = (g) => KNOWN_ROLES[g] || azure.names.get(g) || g;
  const subRow = (subscriptionId) => ({ subscriptionId, subscriptionName: subNames.get(subscriptionId) || null });
  const entraRow = (r, s) => ({
    ...via(r.principalId),
    role: (r.roleDefinition && r.roleDefinition.displayName) || "Unknown role",
    builtIn: !!(r.roleDefinition && r.roleDefinition.isBuiltIn),
    ...s,
    scope: entraScope(r.directoryScopeId),
  });
  // An activated PIM role also shows as an assignment; keep it once, as activated.
  const activeEntra = new Set(entra.active.map(entraKey));
  const activeAzure = new Set(rows.map((r) => azureKey(r.principalId, guid(r.roleDefinitionId), r.scope)));
  return {
    groups: [
      ...all.map((g) => ({
        name: g.displayName,
        direct: starts.has(g.id),
        ...(chains.has(g.id) && chains.get(g.id).length > 1 && { through: chains.get(g.id).slice(0, -1).map((id) => groupNameById[id] || id) }),
        ...(gpim.active.has(g.id) && { pim: gpim.active.get(g.id).state, end: gpim.active.get(g.id).end }),
      })),
      ...pimGroups.map((e) => ({ name: e.name, direct: true, pim: "eligible", access: e.access, end: e.end })),
    ],
    assignments: [
      ...rows.map((r) => {
        const role = guid(r.roleDefinitionId);
        return { ...via(r.principalId), role: roleName(role), scope: r.scope, ...subRow(r.subscriptionId), ...stateOf(r.principalId, azure.active.get(azureKey(r.principalId, role, r.scope))) };
      }),
      ...azure.eligible
        .filter((e) => !activeAzure.has(e.key))
        .map((e) => ({ ...via(e.principalId), role: roleName(e.role), scope: e.scope, ...subRow(e.subscriptionId), state: "eligible", end: pimVia.has(e.principalId) ? stateOf(e.principalId, null, e.end).end : e.end })),
    ],
    entraRoles: [
      ...entra.active.map((r) => entraRow(r, stateOf(r.principalId, entra.pim.get(entraKey(r))))),
      ...entra.eligible.filter((r) => !activeEntra.has(entraKey(r))).map((r) => entraRow(r, { state: "eligible", end: pimVia.has(r.principalId) ? stateOf(r.principalId, null, r.endDateTime).end : r.endDateTime || null })),
    ],
    entraNotes: entra.notes,
    azureNotes: azure.notes,
    groupNotes: gpim.notes,
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
  const out = { user: null, groups: [], assignments: [], entraRoles: [], entraNotes: [], azureNotes: [], groupNotes: [], tenants: [] };
  // Tenants are read side by side; the results are added in tenant order.
  const results = await Promise.allSettled(targets.map((t) => tenantContext.runIn(t, () => lookup(upn))));
  for (const [i, t] of targets.entries()) {
    try {
      if (results[i].status === "rejected") throw results[i].reason;
      const r = results[i].value;
      if (!r) {
        out.tenants.push({ key: t.key, name: t.name, status: "not found" });
        continue;
      }
      out.user ||= r.user;
      out.groups.push(...r.groups.map((g) => ({ ...g, ...(multi && { tenantName: t.name }) })));
      out.assignments.push(...r.assignments.map((a) => ({ ...a, ...(multi && { tenant: t.key, tenantName: t.name }) })));
      out.entraRoles.push(...r.entraRoles.map((a) => ({ ...a, ...(multi && { tenantName: t.name }) })));
      for (const k of ["entraNotes", "azureNotes", "groupNotes"]) out[k].push(...r[k].map((n) => (multi ? `${t.name}: ${n}` : n)));
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

const USER_FIELDS = "$select=id,displayName,userPrincipalName,mail,jobTitle,department,userType";
const SEARCH_TOP = 15; // matches per tenant

// What a search looks for: the start of the name, first name, last name,
// sign-in name or mail (plain $filter, no advanced query headers), or an ID.
const SEARCH = {
  groups: {
    path: "/groups",
    fields: GROUP_FIELDS,
    props: ["displayName", "mail"],
    row: (g) => ({ id: g.id, name: g.displayName, description: g.description || "", mail: g.mail || "" }),
  },
  users: {
    path: "/users",
    fields: USER_FIELDS,
    props: ["displayName", "givenName", "surname", "userPrincipalName", "mail"],
    row: (u) => ({ id: u.id, name: u.displayName || u.userPrincipalName, upn: u.userPrincipalName || "", mail: u.mail || "", jobTitle: u.jobTitle || "", department: u.department || "", guest: u.userType === "Guest" }),
  },
};

// Users or groups matching the text in every tenant the person may see.
async function search(kind, text, keys) {
  const s = SEARCH[kind];
  const targets = tenants.scanTargets().filter((t) => access.inScope(keys, t.key));
  const out = { [kind]: [], tenants: [] };
  const results = await Promise.allSettled(
    targets.map((t) =>
      tenantContext.runIn(t, async () => {
        if (GUID.test(text)) {
          const one = await graphGet(`${s.path}/${text}?${s.fields}`, TOOL_ID).catch((err) => (/\(404\)/.test(err.message) ? null : Promise.reject(err)));
          return one ? [one] : [];
        }
        const q = text.replace(/'/g, "''");
        const filter = s.props.map((p) => `startswith(${p},'${q}')`).join(" or ");
        const page = await graphGet(`${s.path}?$filter=${encodeURIComponent(filter)}&${s.fields}&$top=${SEARCH_TOP}`, TOOL_ID);
        return page.value || [];
      })
    )
  );
  for (const [i, t] of targets.entries()) {
    try {
      if (results[i].status === "rejected") throw results[i].reason;
      const found = results[i].value;
      out[kind].push(...found.map((x) => ({ ...s.row(x), tenant: t.key, tenantName: t.name })));
      out.tenants.push({ key: t.key, name: t.name, status: "searched" });
    } catch (err) {
      out.tenants.push({ key: t.key, name: t.name, status: "error", error: err.message.slice(0, 300) });
    }
  }
  out[kind].sort((a, b) => String(a.name).localeCompare(String(b.name)));
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
  for (const kind of ["groups", "users"]) {
    app.get(`/api/tools/access-lookup/${kind}`, async (req, res) => {
      const text = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (text.length < 2 || text.length > 120) return res.status(400).json({ error: "type at least 2 characters of the name" });
      try {
        const result = await search(kind, text, access.readScope(req));
        const errors = result.tenants.filter((t) => t.status === "error");
        if (!result[kind].length && errors.length === result.tenants.length && errors.length) return res.status(500).json({ error: errors.map((t) => t.error).join("; ") });
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: err.message });
      }
    });
  }
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
