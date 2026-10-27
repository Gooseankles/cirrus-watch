// Who holds the powerful Entra roles: too many or too few Global
// Administrators, guests, apps and disabled accounts in privileged roles,
// standing (non-PIM) admin rights where PIM is in use, admins without MFA, and
// emergency access (break-glass) accounts. Graph: RoleManagement.Read.Directory
// (roles), User.Read.All and Application.Read.All (names), GroupMember.Read.All
// (role groups, policy exclusions), AuditLog.Read.All (MFA registration, P1),
// Policy.Read.All (Conditional Access, for the emergency access check).
const settings = require("../settings");
const { graphGet, graphGetAll } = require("../graphClient");
const { mapLimit, runChecks, scanError, itemErrors, graphHint } = require("./util");

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
    members.set(id, await graphGetAll(`/groups/${id}/transitiveMembers/microsoft.graph.user?$select=id,displayName,userPrincipalName,userType,accountEnabled&$top=999`, TOOL_ID));
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
  return { findings, privilegedUsers, standingGlobalAdmins };
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

async function run() {
  let state;
  try {
    state = await roleFindings();
  } catch (err) {
    throw new Error(graphHint(err, "RoleManagement.Read.Directory"));
  }
  const extra = await runChecks(TOOL_ID, { MFA: () => mfaFindings(state.privilegedUsers), "Emergency access": () => emergencyFindings(state.standingGlobalAdmins) });
  return [...state.findings, ...extra];
}

module.exports = {
  id: TOOL_ID,
  label: "Privileged roles",
  schedule: "0 5 * * *", // daily at 05:00
  run,
  _test: { judgeEmergencyAccess },
};
