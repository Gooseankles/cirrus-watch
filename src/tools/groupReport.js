// Access lookup, group report: everything a group touches beyond its roles. Conditional Access, apps, the nested
// member tree, Key Vault access policies, who controls the group, how people get in (dynamic rule, access packages,
// PIM for Groups, access reviews), licences, Intune assignments, mail and the Microsoft 365 parts.
//
// Every section is read on its own and never fails the report: a missing permission, licence or an error becomes a
// note ("could not get this info") in that section, and the rest still shows. Graph and ARM are reached through
// their modules (graph.graphGet, not a copy taken at load time) so the tests can stub them.
const graph = require("../graphClient");
const arm = require("../armClient");
const log = require("../log");
const tenantContext = require("../tenantContext");
const { mapLimit } = require("./util");

const TOOL_ID = "access-lookup";
const MAX_TRANSITIVE = 20000; // transitive members read for the counts
const MAX_TREE_GROUPS = 300; // nested groups walked for the tree
const DEFAULT_ACCESS = "00000000-0000-0000-0000-000000000000"; // app role id of "default access"

const logTenant = () => (tenantContext.current() || { key: tenantContext.HOME }).key;
const msgOf = (err) => String((err && err.message) || err);
const typeOf = (o) => String((o && o["@odata.type"]) || "").replace("#microsoft.graph.", "") || "unknown";
const noPremium = (err) => /RequestFromNonPremiumTenant|NonPremium|premium license|AadPremiumLicenseRequired|not (?:properly )?licensed|license is required/i.test(msgOf(err));

// Graph's own message from the error text, without the JSON and request ids.
function shortReason(err) {
  const msg = msgOf(err);
  const m = msg.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const status = (msg.match(/\((\d{3})\)/) || [])[1];
  const text = m ? m[1].replace(/\\"/g, '"') : msg;
  return `${status ? `${status}: ` : ""}${text}`.slice(0, 200);
}

// The note a section shows when it could not be read.
function unavailable(err, need = {}) {
  const msg = msgOf(err);
  if (need.licence && noPremium(err)) return `Could not get this info: it needs ${need.licence} in this tenant.`;
  if (/\(403\)|Authorization_RequestDenied|Forbidden|AuthorizationFailed/i.test(msg)) {
    return `Could not get this info: the dashboard's identity is missing ${need.permission || "a permission"}${need.permission && !/Reader/.test(need.permission) ? " (Graph application permission with admin consent)" : ""}.`;
  }
  if (need.licence && /\(400\)|\(404\)/.test(msg) && /licen|subscription|tenant/i.test(msg)) return `Could not get this info: it needs ${need.licence} in this tenant.`;
  return `Could not get this info (${shortReason(err)}).`;
}

// Runs one section. { ok: true, ...data } or { ok: false, note }; never throws.
async function section(name, need, read) {
  try {
    return { ok: true, ...(await read()) };
  } catch (err) {
    log.record({ tool: TOOL_ID, tenant: logTenant(), level: "info", message: `Group report, ${name}: ${msgOf(err).slice(0, 400)}` });
    return { ok: false, note: err.note || unavailable(err, need) };
  }
}

// A read inside a section that may fail on its own (one Intune list of several): a note instead of the whole section.
async function part(label, need, read, notes) {
  try {
    return await read();
  } catch (err) {
    log.record({ tool: TOOL_ID, tenant: logTenant(), level: "info", message: `Group report, ${label}: ${msgOf(err).slice(0, 400)}` });
    notes.push(`${label}: ${unavailable(err, need).replace(/^Could not get this info/, "could not get this info")}`);
    return null;
  }
}

// Reads pages until `max` items; says whether it stopped early.
async function readCapped(path, max) {
  const items = [];
  let next = path;
  while (next && items.length < max) {
    const page = await graph.graphGet(next, TOOL_ID);
    items.push(...(page.value || []));
    next = page["@odata.nextLink"] || null;
  }
  return { items: items.slice(0, max), truncated: Boolean(next) || items.length > max };
}

const GROUP_SELECT = [
  "id", "displayName", "description", "createdDateTime", "groupTypes", "securityEnabled", "mailEnabled", "mail", "mailNickname",
  "proxyAddresses", "isAssignableToRole", "membershipRule", "membershipRuleProcessingState", "onPremisesSyncEnabled",
  "onPremisesLastSyncDateTime", "onPremisesSamAccountName", "visibility", "expirationDateTime", "renewedDateTime",
  "resourceProvisioningOptions", "assignedLicenses", "classification",
].join(",");

/* ---------- sections ---------- */

async function details(id) {
  const g = await graph.graphGet(`/groups/${id}?$select=${GROUP_SELECT}`, TOOL_ID);
  const unified = (g.groupTypes || []).includes("Unified");
  return {
    created: g.createdDateTime || null,
    kind: unified ? "Microsoft 365" : g.securityEnabled ? (g.mailEnabled ? "Mail-enabled security" : "Security") : g.mailEnabled ? "Distribution" : "Other",
    unified,
    dynamic: (g.groupTypes || []).includes("DynamicMembership"),
    membershipRule: g.membershipRule || "",
    ruleState: g.membershipRuleProcessingState || "",
    roleAssignable: !!g.isAssignableToRole,
    synced: !!g.onPremisesSyncEnabled,
    lastSync: g.onPremisesLastSyncDateTime || null,
    samAccountName: g.onPremisesSamAccountName || "",
    visibility: g.visibility || "",
    expires: g.expirationDateTime || null,
    renewed: g.renewedDateTime || null,
    classification: g.classification || "",
    team: (g.resourceProvisioningOptions || []).includes("Team"),
    mail: {
      enabled: !!g.mailEnabled,
      address: g.mail || "",
      nickname: g.mailNickname || "",
      aliases: (g.proxyAddresses || []).filter((a) => /^smtp:/i.test(a) && a.slice(5).toLowerCase() !== String(g.mail || "").toLowerCase()).map((a) => a.slice(5)),
    },
    assignedLicenses: (g.assignedLicenses || []).map((l) => ({ skuId: l.skuId, disabledPlans: (l.disabledPlans || []).length })),
  };
}

async function owners(id) {
  const list = await graph.graphGetAll(`/groups/${id}/owners?$select=id,displayName,userPrincipalName,userType,accountEnabled&$top=999`, TOOL_ID);
  const rows = list.map((o) => ({
    name: o.displayName || o.id,
    upn: o.userPrincipalName || "",
    type: typeOf(o),
    guest: o.userType === "Guest",
    disabled: o.accountEnabled === false,
  }));
  return { owners: rows, noOwner: !rows.length, guestOwners: rows.filter((o) => o.guest).length };
}

// Who can change the group besides its owners: Entra roles given on the group itself or on an administrative unit it
// is in. Tenant-wide admins (Groups Administrator and the like) are not listed: they can change every group.
async function control(id) {
  const notes = [];
  const scoped = async (scope) =>
    graph.graphGetAll(
      `/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent(`directoryScopeId eq '${scope}'`)}&$expand=principal($select=id,displayName,userPrincipalName)`,
      TOOL_ID
    );
  const roleNames = new Map();
  const roleName = async (defId) => {
    if (!roleNames.has(defId)) {
      roleNames.set(defId, await graph.graphGet(`/roleManagement/directory/roleDefinitions/${defId}?$select=displayName`, TOOL_ID).then((d) => d.displayName).catch(() => defId));
    }
    return roleNames.get(defId);
  };
  const rows = [];
  const onGroup = await scoped(`/${id}`);
  for (const a of onGroup) rows.push({ who: (a.principal && (a.principal.displayName || a.principal.userPrincipalName)) || a.principalId, role: await roleName(a.roleDefinitionId), scope: "This group" });
  const units =
    (await part(
      "Administrative units",
      { permission: "AdministrativeUnit.Read.All (the admin-units extra Graph check)" },
      () => graph.graphGetAll(`/groups/${id}/memberOf/microsoft.graph.administrativeUnit?$select=id,displayName,isMemberManagementRestricted`, TOOL_ID),
      notes
    )) || [];
  await mapLimit(units, 4, async (u) => {
    const list = await scoped(`/administrativeUnits/${u.id}`);
    for (const a of list) rows.push({ who: (a.principal && (a.principal.displayName || a.principal.userPrincipalName)) || a.principalId, role: await roleName(a.roleDefinitionId), scope: `Administrative unit ${u.displayName}` });
  });
  return {
    admins: rows,
    units: units.map((u) => ({ name: u.displayName, restricted: !!u.isMemberManagementRestricted })),
    notes,
  };
}

// Transitive member counts and the tree of nested groups below this one.
async function members(id) {
  const { items, truncated } = await readCapped(`/groups/${id}/transitiveMembers?$select=id,displayName,userPrincipalName,userType,accountEnabled&$top=999`, MAX_TRANSITIVE);
  const counts = { users: 0, members: 0, guests: 0, disabled: 0, groups: 0, servicePrincipals: 0, devices: 0, contacts: 0, other: 0 };
  for (const m of items) {
    const t = typeOf(m);
    if (t === "user") {
      counts.users++;
      if (m.userType === "Guest") counts.guests++;
      else counts.members++;
      if (m.accountEnabled === false) counts.disabled++;
    } else if (t === "group") counts.groups++;
    else if (t === "servicePrincipal") counts.servicePrincipals++;
    else if (t === "device") counts.devices++;
    else if (t === "orgContact") counts.contacts++;
    else counts.other++;
  }
  const tree = await groupTree(id);
  return { counts, truncated, max: MAX_TRANSITIVE, ...tree };
}

// Depth-first walk of the groups inside the group. A group met again on its own path is a loop and is not walked
// again; a group met again elsewhere is shown but its children only once.
async function groupTree(rootId, readChildren) {
  const childrenOf =
    readChildren ||
    (async (gid) => (await graph.graphGetAll(`/groups/${gid}/members/microsoft.graph.group?$select=id,displayName&$top=999`, TOOL_ID)).map((g) => ({ id: g.id, name: g.displayName || g.id })));
  const nodes = [];
  const expanded = new Set();
  let capped = false;
  let maxDepth = 0;
  async function walk(gid, depth, path) {
    if (expanded.size >= MAX_TREE_GROUPS) {
      capped = true;
      return;
    }
    expanded.add(gid);
    const kids = await childrenOf(gid);
    for (const k of kids) {
      const loop = path.has(k.id);
      const seen = !loop && expanded.has(k.id);
      nodes.push({ name: k.name, depth, ...(loop && { loop: true }), ...(seen && { repeated: true }) });
      maxDepth = Math.max(maxDepth, depth);
      if (!loop && !seen) await walk(k.id, depth + 1, new Set([...path, k.id]));
    }
  }
  await walk(rootId, 1, new Set([rootId]));
  return { tree: nodes, depth: maxDepth, loops: nodes.filter((n) => n.loop).length, treeCapped: capped };
}

// Conditional Access policies that name the group or a group it sits in (Entra ID counts nested membership).
function caFindings(policies, ids, names) {
  const rows = [];
  let allUsers = 0;
  for (const p of policies) {
    const users = (p.conditions && p.conditions.users) || {};
    const inc = (users.includeGroups || []).map((g) => String(g).toLowerCase()).filter((g) => ids.has(g));
    const exc = (users.excludeGroups || []).map((g) => String(g).toLowerCase()).filter((g) => ids.has(g));
    const grant = p.grantControls || {};
    const controls = [
      ...(grant.builtInControls || []),
      ...(grant.authenticationStrength ? [`strength: ${grant.authenticationStrength.displayName}`] : []),
      ...((grant.termsOfUse || []).length ? ["terms of use"] : []),
    ];
    const session = Object.entries(p.sessionControls || {}).filter(([, v]) => v && v.isEnabled !== false).map(([k]) => k);
    const apps = (p.conditions && p.conditions.applications) || {};
    const appText = (apps.includeApplications || []).includes("All")
      ? "All cloud apps"
      : (apps.includeUserActions || []).length
        ? `User action: ${apps.includeUserActions.join(", ")}`
        : `${(apps.includeApplications || []).length} app(s)`;
    const base = {
      policy: p.displayName,
      state: p.state,
      grant: controls.length ? controls.join(` ${String(grant.operator || "OR").toLowerCase()} `) : session.length ? "session controls only" : "none",
      session,
      apps: appText,
    };
    for (const g of exc) rows.push({ ...base, effect: "excluded", via: names.get(g) || g });
    for (const g of inc) if (!exc.includes(g)) rows.push({ ...base, effect: "included", via: names.get(g) || g });
    if ((users.includeUsers || []).includes("All") && !exc.length && p.state !== "disabled") allUsers++;
  }
  // Exclusions first: they are where the gaps are.
  rows.sort((a, b) => (a.effect === b.effect ? String(a.policy).localeCompare(String(b.policy)) : a.effect === "excluded" ? -1 : 1));
  return { policies: rows, allUsers };
}

async function conditionalAccess(ids, names) {
  const policies = await graph.graphGetAll("/identity/conditionalAccess/policies", TOOL_ID);
  return caFindings(policies, ids, names);
}

// Enterprise apps the group is assigned to. App assignment does not follow nested groups, so only the group's own.
async function apps(id) {
  const list = await graph.graphGetAll(`/groups/${id}/appRoleAssignments?$top=999`, TOOL_ID);
  const sps = new Map();
  await mapLimit([...new Set(list.map((a) => a.resourceId))], 4, async (rid) => {
    sps.set(rid, await graph.graphGet(`/servicePrincipals/${rid}?$select=id,displayName,appRoles,appRoleAssignmentRequired,accountEnabled`, TOOL_ID).catch(() => null));
  });
  return {
    apps: list.map((a) => {
      const sp = sps.get(a.resourceId);
      const role = a.appRoleId === DEFAULT_ACCESS ? "Default access" : ((sp && (sp.appRoles || []).find((r) => r.id === a.appRoleId)) || {}).displayName || a.appRoleId;
      return {
        app: a.resourceDisplayName || (sp && sp.displayName) || a.resourceId,
        role,
        assignmentRequired: sp ? !!sp.appRoleAssignmentRequired : null,
        disabled: sp ? sp.accountEnabled === false : false,
        since: a.createdDateTime || null,
      };
    }),
  };
}

// Key Vaults on access policies that name the group or a group it sits in (not visible as Azure roles).
async function keyVaults(ids, names) {
  const list = [...ids].map((x) => `'${x}'`).join(",");
  const rows = await arm.resourceGraphQuery(
    `
    Resources
    | where type =~ 'microsoft.keyvault/vaults'
    | where tobool(properties.enableRbacAuthorization) != true
    | mv-expand p = properties.accessPolicies
    | where tostring(p.objectId) in (${list})
    | project name, resourceGroup, subscriptionId, objectId = tostring(p.objectId),
        secrets = p.permissions.secrets, keys = p.permissions.keys, certificates = p.permissions.certificates
  `,
    { toolId: TOOL_ID }
  );
  const subNames = await arm.subscriptionNames(TOOL_ID).catch(() => new Map());
  const perms = (x) => (Array.isArray(x) ? x : []).map(String);
  return {
    vaults: rows.map((r) => ({
      vault: r.name,
      resourceGroup: r.resourceGroup,
      subscriptionId: r.subscriptionId,
      subscriptionName: subNames.get(r.subscriptionId) || null,
      via: names.get(String(r.objectId).toLowerCase()) || r.objectId,
      secrets: perms(r.secrets),
      keys: perms(r.keys),
      certificates: perms(r.certificates),
    })),
  };
}

async function accessPackages(id) {
  const list = await graph.graphGetAll("/identityGovernance/entitlementManagement/accessPackages?$expand=resourceRoleScopes($expand=role,scope)&$top=999", TOOL_ID);
  const rows = [];
  for (const p of list) {
    for (const s of p.resourceRoleScopes || []) {
      if (s.scope && String(s.scope.originId).toLowerCase() === String(id).toLowerCase()) rows.push({ package: p.displayName, role: (s.role && s.role.displayName) || "Member" });
    }
  }
  return { packages: rows };
}

async function pim(id) {
  const filter = `$filter=${encodeURIComponent(`groupId eq '${id}'`)}`;
  const eligible = await graph.graphGetAll(`/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances?${filter}`, TOOL_ID);
  const ids = [...new Set(eligible.map((e) => e.principalId))];
  const names = new Map();
  for (let i = 0; i < ids.length; i += 1000) {
    const page = await graph.graphPost("/directoryObjects/getByIds?$select=id,displayName,userPrincipalName", { ids: ids.slice(i, i + 1000) }, TOOL_ID).catch(() => ({ value: [] }));
    for (const o of page.value || []) names.set(o.id, o.displayName || o.userPrincipalName || o.id);
  }
  return { eligible: eligible.map((e) => ({ name: names.get(e.principalId) || e.principalId, access: e.accessId === "owner" ? "owner" : "member", end: e.endDateTime || null })) };
}

async function accessReviews(id) {
  const filter = encodeURIComponent(`contains(scope/microsoft.graph.accessReviewQueryScope/query, '${id}')`);
  const list = await graph.graphGetAll(`/identityGovernance/accessReviews/definitions?$filter=${filter}&$top=100`, TOOL_ID);
  return {
    reviews: list.map((r) => ({
      name: r.displayName,
      status: r.status || "",
      recurrence: (r.settings && r.settings.recurrence && r.settings.recurrence.pattern && r.settings.recurrence.pattern.type) || "once",
    })),
  };
}

async function licences(id, assigned) {
  const notes = [];
  let names = new Map();
  if (assigned.length) {
    const skus = await part("Licence names", { permission: "LicenseAssignment.Read.All" }, () => graph.graphGetAll("/subscribedSkus", TOOL_ID), notes);
    names = new Map((skus || []).map((s) => [s.skuId, s.skuPartNumber]));
  }
  const errors = await graph.graphGetAll(`/groups/${id}/membersWithLicenseErrors?$select=id,displayName,userPrincipalName&$top=999`, TOOL_ID);
  return {
    licences: assigned.map((l) => ({ sku: names.get(l.skuId) || l.skuId, disabledPlans: l.disabledPlans })),
    errors: errors.map((u) => ({ name: u.displayName || u.id, upn: u.userPrincipalName || "" })),
    notes,
  };
}

// Intune assignments that target the group or a group it sits in (Intune follows nested groups).
const INTUNE_LISTS = [
  { label: "Device configuration", path: "/deviceManagement/deviceConfigurations?$select=id,displayName&$expand=assignments", permission: "DeviceManagementConfiguration.Read.All" },
  { label: "Settings catalog", path: `${graph.GRAPH_BETA_ROOT}/deviceManagement/configurationPolicies?$select=id,name&$expand=assignments`, permission: "DeviceManagementConfiguration.Read.All" },
  { label: "Compliance", path: "/deviceManagement/deviceCompliancePolicies?$select=id,displayName&$expand=assignments", permission: "DeviceManagementConfiguration.Read.All" },
  { label: "App", path: `/deviceAppManagement/mobileApps?$filter=${encodeURIComponent("isAssigned eq true")}&$select=id,displayName&$expand=assignments`, permission: "DeviceManagementApps.Read.All" },
];

function intuneRows(kind, items, ids, names) {
  const rows = [];
  for (const it of items || []) {
    for (const a of it.assignments || []) {
      const t = a.target || {};
      const gid = String(t.groupId || "").toLowerCase();
      if (!gid || !ids.has(gid)) continue;
      rows.push({
        kind,
        name: it.displayName || it.name || it.id,
        effect: /exclusion/i.test(t["@odata.type"] || "") ? "excluded" : "included",
        ...(a.intent && { intent: a.intent }),
        via: names.get(gid) || gid,
      });
    }
  }
  return rows;
}

async function intune(ids, names) {
  const notes = [];
  const rows = [];
  let read = 0;
  for (const l of INTUNE_LISTS) {
    const items = await part(l.label, { permission: l.permission, licence: "Microsoft Intune" }, () => graph.graphGetAll(l.path, TOOL_ID), notes);
    if (items) {
      read++;
      rows.push(...intuneRows(l.label, items, ids, names));
    }
  }
  if (!read) throw Object.assign(new Error(`none of the Intune lists could be read: ${notes.join("; ")}`), { note: `Could not get this info. ${notes.join(" ")}` });
  return { assignments: rows, notes };
}

async function site(id, unified) {
  if (!unified) return { site: null, skipped: "Only Microsoft 365 groups have their own SharePoint site." };
  const s = await graph.graphGet(`/groups/${id}/sites/root?$select=displayName,webUrl,lastModifiedDateTime`, TOOL_ID);
  return { site: { name: s.displayName, url: s.webUrl, modified: s.lastModifiedDateTime || null } };
}

/* ---------- the report ---------- */

async function groupReport(id) {
  // The groups it sits in: CA, Key Vault and Intune also apply through them.
  let parents = [];
  let parentsNote = null;
  try {
    parents = (await graph.graphGetAll(`/groups/${id}/transitiveMemberOf?$select=id,displayName`, TOOL_ID)).filter((g) => typeOf(g) === "group");
  } catch (err) {
    parentsNote = `The groups it sits in could not be read, so only the group itself is matched (${shortReason(err)}).`;
  }
  const lid = String(id).toLowerCase();
  const ids = new Set([lid, ...parents.map((p) => String(p.id).toLowerCase())]);
  const names = new Map([[lid, "This group"], ...parents.map((p) => [String(p.id).toLowerCase(), p.displayName || p.id])]);

  const det = await section("details", { permission: "GroupMember.Read.All" }, () => details(id));
  const [own, ctl, mem, ca, app, kv, pkg, pimRes, rev, lic, intn, sp] = await Promise.all([
    section("owners", { permission: "GroupMember.Read.All" }, () => owners(id)),
    section("control", { permission: "RoleManagement.Read.Directory" }, () => control(id)),
    section("members", { permission: "GroupMember.Read.All" }, () => members(id)),
    section("conditional access", { permission: "Policy.Read.All", licence: "Microsoft Entra ID P1" }, () => conditionalAccess(ids, names)),
    section("apps", { permission: "Application.Read.All" }, () => apps(id)),
    section("key vaults", { permission: "Reader on the subscriptions" }, () => keyVaults(ids, names)),
    section("access packages", { permission: "EntitlementManagement.Read.All", licence: "Microsoft Entra ID Governance or P2" }, () => accessPackages(id)),
    section("pim", { permission: "PrivilegedEligibilitySchedule.Read.AzureADGroup", licence: "Microsoft Entra ID P2" }, () => pim(id)),
    section("access reviews", { permission: "AccessReview.Read.All", licence: "Microsoft Entra ID Governance or P2" }, () => accessReviews(id)),
    section("licences", { permission: "GroupMember.Read.All and LicenseAssignment.Read.All" }, () => licences(id, det.ok ? det.assignedLicenses : [])),
    section("intune", { permission: "DeviceManagementConfiguration.Read.All and DeviceManagementApps.Read.All", licence: "Microsoft Intune" }, () => intune(ids, names)),
    section("sharepoint site", { permission: "Sites.Read.All" }, () => site(id, det.ok && det.unified)),
  ]);
  return {
    parents: parents.length,
    parentsNote,
    details: det,
    owners: own,
    control: ctl,
    members: mem,
    conditionalAccess: ca,
    apps: app,
    keyVaults: kv,
    accessPackages: pkg,
    pim: pimRes,
    accessReviews: rev,
    licences: lic,
    intune: intn,
    site: sp,
  };
}

module.exports = { groupReport, _test: { section, unavailable, caFindings, groupTree, intuneRows, shortReason } };
