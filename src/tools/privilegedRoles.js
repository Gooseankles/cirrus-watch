// Who holds the powerful Entra roles: too many or too few Global
// Administrators, guests, apps and disabled accounts in privileged roles,
// standing (non-PIM) admin rights where PIM is in use, admins without MFA,
// emergency access (break-glass) accounts, and admin accounts synced from
// on-premises Active Directory. Two smaller parts run beside the role check
// (0.72.0.0; they were the Guest owners and Administrative units scans):
// groups owned by guests, and the risky parts of administrative units. Each
// part fails on its own without losing the role findings.
// Graph: RoleManagement.Read.Directory (roles, AU-scoped admins), User.Read.All
// and Application.Read.All (names), GroupMember.Read.All (role groups, policy
// exclusions, group owners), AuditLog.Read.All (MFA registration, P1),
// Policy.Read.All (Conditional Access, for the emergency access check),
// AdministrativeUnit.Read.All (the administrative units part, an extra Graph
// check).
const settings = require("../settings");
const { graphGet, graphGetAll, graphPost } = require("../graphClient");
const { mapLimit, runChecks, scanError, itemErrors, graphHint } = require("./util");
const { isOn, refused, permissionMissing } = require("./extraChecks");

const TOOL_ID = "privileged-roles";
const MAX_USERS = 500; // privileged users looked up for type and status
const MAX_GROUPS = 100; // privileged groups whose members are read
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";

// Role templates that can take over the tenant or its data, used when Graph
// does not mark the role isPrivileged itself.
const PRIVILEGED_TEMPLATES = new Set([
  GLOBAL_ADMIN,
  "e8611ab8-c189-46e8-94e1-60213ab1f814", // Privileged Role Administrator
  "7be44c8a-adaf-4e2a-84d6-ab2649e08a13", // Privileged Authentication Administrator
  "194ae4cb-b126-40b2-bd5b-6091b380977d", // Security Administrator
  "9b895d92-2cd3-44c7-9d02-a6ac2d5ea5c3", // Application Administrator
  "158c047a-c907-4556-b7ef-446551a6b5f7", // Cloud Application Administrator
  "b1be1c3e-b65d-4f19-8427-f6fa0d97feb9", // Conditional Access Administrator
  "c4e39bd9-1100-46d3-8c65-fb160da0071f", // Authentication Administrator
  "fe930be7-5e62-47db-91af-98c3a49a38b1", // User Administrator
  "729827e3-9c14-49f7-bb1b-9608f156bbb8", // Helpdesk Administrator
  "8ac3fc64-6eca-42ea-9e69-59f4c7b60eb2", // Hybrid Identity Administrator
  "29232cdf-9323-42fd-ade2-1d097af3e4de", // Exchange Administrator
  "f28a1f50-f6e7-4571-818b-6a12f2af6b6c", // SharePoint Administrator
  "3a2c62db-5318-420d-8d74-23affee5d9d5", // Intune Administrator
]);

// isPrivileged (Microsoft's own list of privileged roles) is only on the beta
// endpoint; v1.0 refuses the whole request if it is selected. Beta can change
// or fail, so fall back to v1.0 and the PRIVILEGED_TEMPLATES list.
async function roleDefinitions() {
  try {
    return await graphGetAll("https://graph.microsoft.com/beta/roleManagement/directory/roleDefinitions?$select=id,displayName,templateId,isPrivileged,isBuiltIn", TOOL_ID);
  } catch {
    return graphGetAll("/roleManagement/directory/roleDefinitions?$select=id,displayName,templateId,isBuiltIn", TOOL_ID);
  }
}

async function loadRoles() {
  const [defs, assignments] = await Promise.all([
    roleDefinitions(),
    graphGetAll("/roleManagement/directory/roleAssignments?$expand=principal", TOOL_ID),
  ]);
  const roleById = new Map();
  for (const d of defs) {
    const role = { name: d.displayName, template: d.templateId || d.id, privileged: d.isPrivileged === true || PRIVILEGED_TEMPLATES.has(d.templateId || d.id) };
    roleById.set(d.id, role);
    if (d.templateId) roleById.set(d.templateId, role);
  }
  return { roleById, assignments };
}

// PIM: role assignments that came from activating an eligible role. Without
// Entra ID P2 the call fails and every assignment counts as standing.
async function loadPim() {
  try {
    const [eligible, active] = await Promise.all([
      graphGetAll("/roleManagement/directory/roleEligibilityScheduleInstances?$select=principalId,roleDefinitionId", TOOL_ID),
      graphGetAll("/roleManagement/directory/roleAssignmentScheduleInstances?$select=principalId,roleDefinitionId,assignmentType,endDateTime", TOOL_ID),
    ]);
    const activated = new Set(active.filter((a) => a.assignmentType === "Activated" || a.endDateTime).map((a) => `${a.principalId}|${a.roleDefinitionId}`));
    return { inUse: eligible.length > 0, activated };
  } catch {
    return { inUse: false, activated: new Set() };
  }
}

const kindOf = (p) => {
  const t = String(p["@odata.type"] || "").toLowerCase();
  return t.includes("serviceprincipal") ? "app" : t.includes("group") ? "group" : "user";
};
const labelOf = (p) => p.userPrincipalName || p.displayName || p.id;

// The expanded principal has default fields only: fetch type and status.
async function enrichUsers(assignments) {
  const ids = [...new Set(assignments.filter((a) => a.principal && kindOf(a.principal) === "user").map((a) => a.principal.id))];
  const users = new Map();
  const failures = await mapLimit(ids.slice(0, MAX_USERS), 6, async (id) => {
    users.set(id, await graphGet(`/users/${id}?$select=id,displayName,userPrincipalName,userType,accountEnabled,onPremisesSyncEnabled`, TOOL_ID));
  });
  for (const a of assignments) if (a.principal && users.has(a.principal.id)) a.principal = { ...a.principal, ...users.get(a.principal.id) };
  return itemErrors(TOOL_ID, "users", "privileged users looked up", failures, Math.min(ids.length, MAX_USERS));
}

// Members of groups that hold a privileged role get that role too: they count
// as Global Administrators and get the MFA check. group id -> users.
async function groupMembers(assignments) {
  const ids = [...new Set(assignments.filter((a) => a.principal && kindOf(a.principal) === "group").map((a) => a.principal.id))];
  const members = new Map();
  const failures = await mapLimit(ids.slice(0, MAX_GROUPS), 4, async (id) => {
    members.set(id, await graphGetAll(`/groups/${id}/transitiveMembers/microsoft.graph.user?$select=id,displayName,userPrincipalName,userType,accountEnabled,onPremisesSyncEnabled&$top=999`, TOOL_ID));
  });
  const errors = failures.length ? itemErrors(TOOL_ID, "group-members", "privileged groups expanded", failures, Math.min(ids.length, MAX_GROUPS)) : [];
  for (const e of errors) e.detail = graphHint({ message: e.detail }, "GroupMember.Read.All");
  return { members, errors };
}

async function roleFindings() {
  const [{ roleById, assignments: all }, pim] = await Promise.all([loadRoles(), loadPim()]);
  const assignments = all.filter((a) => (roleById.get(a.roleDefinitionId) || {}).privileged);
  const findings = await enrichUsers(assignments);
  const groups = await groupMembers(assignments);
  findings.push(...groups.errors);
  const globalAdmins = new Set();
  const standingGlobalAdmins = new Map(); // user id -> user, Global Administrator assigned to the user permanently
  const privilegedUsers = new Map(); // user id -> { user, roles }
  for (const a of assignments) {
    const role = roleById.get(a.roleDefinitionId);
    const p = a.principal || { id: a.principalId };
    if (!role || !role.privileged) continue;
    if (role.template === GLOBAL_ADMIN && kindOf(p) === "user" && p.accountEnabled !== false) {
      globalAdmins.add(p.id);
      if (!pim.activated.has(`${p.id}|${a.roleDefinitionId}`) && (!a.directoryScopeId || a.directoryScopeId === "/")) standingGlobalAdmins.set(p.id, p);
    }
    const base = { name: labelOf(p), resourceGroup: null, subscriptionId: null, principalId: p.id };
    const scope = a.directoryScopeId && a.directoryScopeId !== "/" ? ` (scope ${a.directoryScopeId})` : "";
    if (kindOf(p) === "user") {
      if (!privilegedUsers.has(p.id)) privilegedUsers.set(p.id, { user: p, roles: [] });
      privilegedUsers.get(p.id).roles.push(role.name);
      if (p.userType === "Guest" || /#EXT#/i.test(p.userPrincipalName || "")) {
        findings.push({ ...base, kind: "privileged-guest", id: `${a.id}#guest`, detail: `Guest account holds ${role.name}${scope}. A guest's own organisation controls its sign-in and MFA` });
      } else if (p.accountEnabled === false) {
        findings.push({ ...base, kind: "privileged-disabled", id: `${a.id}#disabled`, detail: `Disabled account still holds ${role.name}${scope}; remove the role` });
      } else if (pim.inUse && !pim.activated.has(`${p.id}|${a.roleDefinitionId}`)) {
        findings.push({ ...base, kind: "privileged-standing", id: `${a.id}#standing`, detail: `${role.name}${scope} is assigned permanently. PIM is in use here: make it eligible so it is activated only when needed` });
      }
    } else if (kindOf(p) === "app") {
      findings.push({ ...base, kind: "privileged-app", id: `${a.id}#app`, detail: `App (service principal) holds ${role.name}${scope}. Anyone with its secret has that role; check the app needs it` });
    } else {
      const users = groups.members.get(p.id) || [];
      findings.push({ ...base, kind: "privileged-group", id: `${a.id}#group`, detail: `Group holds ${role.name}${scope}: its ${users.length ? `${users.length} user member(s)` : "members"} and owners get the role. Keep the group role-assignable with few owners` });
      for (const u of users) {
        if (role.template === GLOBAL_ADMIN && !scope && u.accountEnabled !== false) globalAdmins.add(u.id);
        if (!privilegedUsers.has(u.id)) privilegedUsers.set(u.id, { user: u, roles: [] });
        privilegedUsers.get(u.id).roles.push(`${role.name} (via ${labelOf(p)})`);
      }
    }
  }
  const n = globalAdmins.size;
  if (n > 4) findings.push({ kind: "too-many-global-admins", id: `${TOOL_ID}/global-admins`, name: "Global Administrators", resourceGroup: null, subscriptionId: null, detail: `${n} enabled users are Global Administrator; Microsoft advises fewer than five. Use narrower roles for day-to-day work` });
  if (n < 2) findings.push({ kind: "too-few-global-admins", id: `${TOOL_ID}/global-admins`, name: "Global Administrators", resourceGroup: null, subscriptionId: null, detail: `${n} enabled user${n === 1 ? " is" : "s are"} Global Administrator. Keep at least two (one an emergency access account) so a lost account does not lock you out` });
  findings.push(...judgeSynced(privilegedUsers, globalAdmins));
  return { findings, privilegedUsers, standingGlobalAdmins };
}

// Accounts synced from on-premises Active Directory that hold a privileged role: whoever takes over the local
// domain (or the sync server) can reset their password and so take the cloud role. privilegedUsers: Map id ->
// { user, roles }; globalAdmins: Set of user ids that are Global Administrator. Pure, for the tests.
function judgeSynced(privilegedUsers, globalAdmins) {
  const out = [];
  for (const [id, { user, roles }] of privilegedUsers) {
    if (user.onPremisesSyncEnabled !== true || user.accountEnabled === false) continue;
    const ga = globalAdmins.has(id);
    out.push({
      kind: ga ? "privileged-synced-global-admin" : "privileged-synced",
      id: `${id}#synced`,
      name: labelOf(user),
      resourceGroup: null,
      subscriptionId: null,
      principalId: id,
      detail: `Synced from on-premises Active Directory and holds ${[...new Set(roles)].join(", ")}. Anyone who takes over the local domain can take this role too; use a cloud-only account for admin work`,
    });
  }
  return out;
}

// Emergency access (break-glass) accounts, as Microsoft advises: at least two cloud-only accounts that hold Global
// Administrator permanently and that no enabled Conditional Access policy for all users applies to (so a broken
// policy or a lost MFA provider cannot lock everyone out). named = UPNs from BREAK_GLASS_ACCOUNTS (lower case; empty
// = find them). admins: Map id -> user (standing Global Admins); policies: CA policies; groupsOf: Map user id -> Set of
// group ids. Pure, for the tests.
const BREAK_GLASS_MIN = 2;
function judgeEmergencyAccess({ admins, policies, groupsOf, named }) {
  const allUsers = policies.filter((p) => p.state === "enabled" && ((p.conditions || {}).users || {}).includeUsers?.includes("All"));
  const excludedFrom = (u, p) => {
    const c = (p.conditions || {}).users || {};
    const groups = groupsOf.get(u.id) || new Set();
    return (c.excludeUsers || []).includes(u.id) || (c.excludeGroups || []).some((g) => groups.has(g)) || (c.excludeRoles || []).includes(GLOBAL_ADMIN);
  };
  // Why one account would not work in an emergency; empty = fine.
  const problems = (u) => {
    const out = [];
    if (u.onPremisesSyncEnabled === true) out.push("it is synced from on-premises (it fails when the sync or the domain does)");
    const caught = allUsers.filter((p) => !excludedFrom(u, p));
    if (caught.length) out.push(`Conditional Access for all users applies to it (${caught.slice(0, 3).map((p) => p.displayName).join(", ")}${caught.length > 3 ? ", ..." : ""})`);
    return out;
  };
  const base = { resourceGroup: null, subscriptionId: null };
  const findings = [];
  if (named.length) {
    const byUpn = new Map([...admins.values()].map((u) => [String(u.userPrincipalName || "").toLowerCase(), u]));
    for (const upn of named) {
      const u = byUpn.get(upn);
      if (!u) {
        findings.push({ ...base, kind: "break-glass-not-admin", id: `${TOOL_ID}/break-glass/${upn}`, name: upn, detail: "Listed as an emergency access account, but it is not an enabled user with Global Administrator assigned permanently (missing, disabled, PIM-eligible only or role via a group)" });
        continue;
      }
      const why = problems(u);
      if (why.length) findings.push({ ...base, kind: "break-glass-weak", id: `${u.id}#break-glass`, name: upn, principalId: u.id, detail: `Emergency access account may not work when needed: ${why.join("; ")}` });
    }
    const good = named.filter((upn) => byUpn.has(upn) && !problems(byUpn.get(upn)).length).length;
    if (good < BREAK_GLASS_MIN && good === named.length) {
      findings.push({ ...base, kind: "break-glass-too-few", id: `${TOOL_ID}/break-glass`, name: "Emergency access accounts", detail: `${good} emergency access account${good === 1 ? "" : "s"}; keep at least ${BREAK_GLASS_MIN} so one lost or locked account is not the end` });
    }
    return findings;
  }
  const ready = [...admins.values()].filter((u) => !problems(u).length);
  if (ready.length < BREAK_GLASS_MIN) {
    const near = [...admins.values()].filter((u) => u.onPremisesSyncEnabled !== true && !ready.includes(u));
    findings.push({
      ...base,
      kind: "break-glass-too-few",
      id: `${TOOL_ID}/break-glass`,
      name: "Emergency access accounts",
      detail:
        `${ready.length ? `Only ${ready.length} account (${ready.map(labelOf).join(", ")}) looks like` : "No account looks like"} an emergency access account: cloud-only, Global Administrator permanently ` +
        `and outside every Conditional Access policy for all users. Keep ${BREAK_GLASS_MIN}, excluded through a group, with a passkey or FIDO2 key, and name them in Settings` +
        (near.length ? `. Closest: ${near.slice(0, 3).map(labelOf).join(", ")}` : ""),
    });
  }
  return findings;
}

async function emergencyFindings(admins) {
  const named = String(settings.get("BREAK_GLASS_ACCOUNTS") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  let policies;
  try {
    policies = await graphGetAll("/identity/conditionalAccess/policies?$select=id,displayName,state,conditions", TOOL_ID);
  } catch (err) {
    return [scanError(TOOL_ID, "break-glass", "Emergency access accounts not checked", graphHint(err, "Policy.Read.All"))];
  }
  const groupsOf = new Map();
  const failures = await mapLimit([...admins.keys()].slice(0, MAX_USERS), 6, async (id) => {
    const groups = await graphGetAll(`/users/${id}/transitiveMemberOf/microsoft.graph.group?$select=id`, TOOL_ID);
    groupsOf.set(id, new Set(groups.map((g) => g.id)));
  });
  const errors = itemErrors(TOOL_ID, "break-glass-groups", "Global Administrators' groups read", failures, Math.min(admins.size, MAX_USERS));
  for (const e of errors) e.detail = graphHint({ message: e.detail }, "GroupMember.Read.All");
  return [...judgeEmergencyAccess({ admins, policies, groupsOf, named }), ...errors];
}

// Admins with no MFA method registered (needs AuditLog.Read.All and P1).
async function mfaFindings(privilegedUsers) {
  if (!privilegedUsers.size) return [];
  let rows;
  try {
    rows = await graphGetAll("/reports/authenticationMethods/userRegistrationDetails?$select=id,userPrincipalName,isMfaRegistered,methodsRegistered", TOOL_ID);
  } catch (err) {
    return [scanError(TOOL_ID, "mfa", "MFA registration not checked", graphHint(err, "AuditLog.Read.All"))];
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const findings = [];
  for (const [id, { user, roles }] of privilegedUsers) {
    const r = byId.get(id);
    if (!r || r.isMfaRegistered || user.accountEnabled === false) continue;
    findings.push({
      kind: "privileged-no-mfa",
      id: `${id}#no-mfa`,
      name: labelOf(user),
      resourceGroup: null,
      subscriptionId: null,
      principalId: id,
      detail: `Holds ${[...new Set(roles)].join(", ")} but has no MFA method registered${(r.methodsRegistered || []).length ? ` (only ${r.methodsRegistered.join(", ")})` : ""}`,
    });
  }
  return findings;
}

// ---- Guest owners (was its own scan until 0.72.0.0) ----
// Groups owned by guests. An owner can add anyone to the group and change it,
// so a guest owner lets someone outside the organisation decide who gets what
// the group grants (Teams, SharePoint, app access, Azure roles). Critical for
// role-assignable groups (they can hold Entra admin roles), else a warning.
// One pass over /groups with $expand=owners (GroupMember.Read.All lists groups
// and owners, User.Read.All gives the owner's userType; both in the default
// set). $expand returns at most 20 owners and no next link; a group showing 20
// is read again in full. Owners of groups synced from on-premises, distribution
// groups and mail-enabled security groups made in Exchange are not in Graph, so
// those are not seen. Finding ids keep the guest-owners/ prefix of the old scan,
// so accepted findings carry over.
// A check for privileged groups and roles with no access review
// (AccessReview.Read.All) is not built: review scopes are free-form queries in
// several shapes (one group, all Microsoft 365 groups with guests, role
// assignment instances, PIM groups), so "no review covers this" cannot be told
// reliably without many false findings.
const GUEST_OWNERS_ID = "guest-owners";
const OWNER_FIELDS = "id,displayName,userPrincipalName,userType,accountEnabled";
const EXPAND_LIMIT = 20;

// userType only: a guest converted to Member keeps #EXT# in the UPN but is no longer a guest.
const isGuest = (o) => o && o.userType === "Guest";
const isUser = (o) => !o["@odata.type"] || o["@odata.type"] === "#microsoft.graph.user";

// groups: [{ id, displayName, isAssignableToRole, owners: [...] }] -> findings. Pure.
function guestOwnerFindings(groups) {
  const out = [];
  for (const g of groups || []) {
    const owners = (g.owners || []).filter(isUser);
    const guests = owners.filter(isGuest);
    if (!guests.length) continue;
    const onlyGuests = guests.length === owners.length;
    for (const o of guests) {
      out.push({
        kind: g.isAssignableToRole ? "guest-owner-role-group" : "guest-owner",
        id: `${GUEST_OWNERS_ID}/${g.id}/${o.id}`,
        name: `${g.displayName || g.id}: ${o.userPrincipalName || o.displayName || o.id}`,
        detail: `Guest ${o.displayName || o.userPrincipalName || o.id} owns the group ${g.displayName || g.id}${g.isAssignableToRole ? " (role-assignable: it can hold Entra admin roles)" : ""}${onlyGuests ? "; there is no member owner" : ""}. An owner can add anyone to the group; make a member of the organisation the owner and remove the guest`,
        resourceGroup: null,
        subscriptionId: null,
        principalId: o.id,
      });
    }
  }
  return out;
}

// Every owner of a group with 20 or more in the expand: ids, then user details.
async function allOwners(groupId) {
  const owners = await graphGetAll(`/groups/${groupId}/owners`, TOOL_ID);
  const ids = owners.filter(isUser).map((o) => o.id);
  const users = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const page = await graphPost(`/directoryObjects/getByIds?$select=${OWNER_FIELDS}`, { ids: ids.slice(i, i + 1000), types: ["user"] }, TOOL_ID);
    users.push(...(page.value || []));
  }
  return users;
}

async function guestOwnerRun() {
  let groups;
  try {
    groups = await graphGetAll(`/groups?$select=id,displayName,isAssignableToRole&$expand=owners($select=${OWNER_FIELDS})`, TOOL_ID);
  } catch (err) {
    throw new Error(graphHint(err, "GroupMember.Read.All"));
  }
  const full = groups.filter((g) => (g.owners || []).length >= EXPAND_LIMIT);
  const failures = await mapLimit(full, 4, async (g) => {
    g.owners = await allOwners(g.id);
  });
  return [...guestOwnerFindings(groups), ...itemErrors(TOOL_ID, "owners", "large groups' owner lists", failures, full.length)];
}

// ---- Administrative units (was its own scan until 0.72.0.0) ----
// Only what shows risk in administrative units (AUs), not an inventory:
//   - a guest holds an admin role scoped to an AU (an outsider who can reset
//     passwords or change the users and groups in it)
//   - a disabled account still holds an AU-scoped admin role (left behind; it
//     works again the moment someone enables the account)
//   - a restricted management AU has no members (it was made to shield
//     sensitive accounts from tenant-wide admins, and shields nothing)
// Plain AUs with no scoped admins, dynamic rules and AU sizes are not findings:
// they carry no risk on their own and would be noise. Scoped admins that are
// groups or apps are left to the role check above.
// The extra Graph check admin-units (extraChecks.js): AdministrativeUnit.Read.All
// for the AU list and members. scopedRoleMembers and directoryRoles use
// RoleManagement.Read.Directory, user details User.Read.All (both in the
// default set). Listing AUs works on Entra ID Free; each AU-scoped admin needs
// Entra ID P1. Finding ids keep the admin-units/ prefix of the old scan.
const ADMIN_UNITS_ID = "admin-units";
const ADMIN_UNITS_LABEL = "Administrative units";
const AU_CONCURRENCY = 4;

// input: { aus, scoped: Map(auId -> scopedRoleMembership[]), memberCount:
// Map(auId -> number, restricted AUs only), roleNames: Map(roleId -> name),
// users: Map(userId -> { userType, accountEnabled, userPrincipalName }) }. Pure.
function auFindings({ aus, scoped, memberCount, roleNames, users }) {
  const out = [];
  for (const au of aus || []) {
    const auName = au.displayName || au.id;
    if (au.isMemberManagementRestricted && memberCount.has(au.id) && memberCount.get(au.id) === 0) {
      out.push({
        kind: "au-restricted-empty",
        id: `${ADMIN_UNITS_ID}/${au.id}/empty`,
        name: auName,
        detail: "Restricted management administrative unit with no members: it protects nothing. Add the accounts it is meant to shield, or delete it",
        resourceGroup: null,
        subscriptionId: null,
      });
    }
    for (const m of scoped.get(au.id) || []) {
      const info = m.roleMemberInfo || {};
      const u = users.get(info.id);
      if (!u) continue; // a group or an app, or gone
      const role = roleNames.get(m.roleId) || "an admin role";
      const who = u.userPrincipalName || info.userPrincipalName || info.displayName || info.id;
      const base = { resourceGroup: null, subscriptionId: null, principalId: info.id };
      if (u.userType === "Guest" || /#EXT#/i.test(u.userPrincipalName || "")) {
        out.push({ ...base, kind: "au-scoped-admin-guest", id: `${ADMIN_UNITS_ID}/${au.id}/${info.id}/${m.roleId}/guest`, name: who, detail: `Guest account holds ${role} over the administrative unit ${auName}: someone outside the organisation can manage the users and groups in it. Remove the assignment or give it to a member account` });
      } else if (u.accountEnabled === false) {
        out.push({ ...base, kind: "au-scoped-admin-disabled", id: `${ADMIN_UNITS_ID}/${au.id}/${info.id}/${m.roleId}/disabled`, name: who, detail: `Disabled account still holds ${role} over the administrative unit ${auName}. Remove the assignment; it works again as soon as the account is enabled` });
      }
    }
  }
  return out;
}

async function lookupUsers(ids) {
  const users = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 1000) {
    const page = await graphPost("/directoryObjects/getByIds?$select=id,userPrincipalName,userType,accountEnabled", { ids: unique.slice(i, i + 1000), types: ["user"] }, TOOL_ID);
    for (const o of page.value || []) users.set(o.id, o);
  }
  return users;
}

async function adminUnitRun() {
  if (!isOn(ADMIN_UNITS_ID)) return [];
  let aus;
  try {
    aus = await graphGetAll("/directory/administrativeUnits?$select=id,displayName,isMemberManagementRestricted", TOOL_ID);
  } catch (err) {
    if (refused(err)) return permissionMissing(ADMIN_UNITS_ID, ADMIN_UNITS_LABEL, err, TOOL_ID);
    throw err;
  }
  if (!aus.length) return [];
  const scoped = new Map();
  const memberCount = new Map();
  const failures = await mapLimit(aus, AU_CONCURRENCY, async (au) => {
    scoped.set(au.id, await graphGetAll(`/directory/administrativeUnits/${au.id}/scopedRoleMembers`, TOOL_ID));
    if (au.isMemberManagementRestricted) {
      const page = await graphGet(`/directory/administrativeUnits/${au.id}/members/$ref?$top=1`, TOOL_ID);
      memberCount.set(au.id, (page.value || []).length);
    }
  });
  const ids = [...scoped.values()].flat().map((m) => m.roleMemberInfo && m.roleMemberInfo.id);
  const roleNames = new Map();
  let users = new Map();
  if (ids.length) {
    const roles = await graphGetAll("/directoryRoles?$select=id,displayName", TOOL_ID);
    for (const r of roles) roleNames.set(r.id, r.displayName);
    users = await lookupUsers(ids);
  }
  return [...auFindings({ aus, scoped, memberCount, roleNames, users }), ...itemErrors(TOOL_ID, "units", "administrative units", failures, aus.length)];
}

// The role check is the scan: when it fails the run fails and the last results
// stay. The parts around it each fail on their own (one scan-error finding).
async function run() {
  let state;
  try {
    state = await roleFindings();
  } catch (err) {
    throw new Error(graphHint(err, "RoleManagement.Read.Directory"));
  }
  const parts = await runChecks(TOOL_ID, {
    MFA: () => mfaFindings(state.privilegedUsers),
    "Emergency access": () => emergencyFindings(state.standingGlobalAdmins),
    "Guest owners": guestOwnerRun,
    [ADMIN_UNITS_LABEL]: adminUnitRun,
  });
  return [...state.findings, ...parts];
}

module.exports = {
  id: TOOL_ID,
  label: "Privileged roles",
  schedule: "0 5 * * *", // daily at 05:00
  replaces: [GUEST_OWNERS_ID, ADMIN_UNITS_ID],
  run,
  _test: {
    judgeEmergencyAccess,
    judgeSynced,
    guestOwners: { guestOwnerFindings, isGuest, run: guestOwnerRun },
    adminUnits: { auFindings, run: adminUnitRun },
  },
  PRIVILEGED_TEMPLATES,
};
