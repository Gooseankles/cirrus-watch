// Who holds the powerful Entra roles: too many or too few Global
// Administrators, guests, apps and disabled accounts in privileged roles,
// standing (non-PIM) admin rights where PIM is in use, and admins without MFA.
// Graph: RoleManagement.Read.Directory (roles), User.Read.All and
// Application.Read.All (names), AuditLog.Read.All (MFA registration, P1).
const { graphGet, graphGetAll } = require("../graphClient");
const { mapLimit, runChecks, scanError, itemErrors, graphHint } = require("./util");

const TOOL_ID = "privileged-roles";
const MAX_USERS = 500; // privileged users looked up for type and status
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

async function loadRoles() {
  const [defs, assignments] = await Promise.all([
    graphGetAll("/roleManagement/directory/roleDefinitions?$select=id,displayName,templateId,isPrivileged,isBuiltIn", TOOL_ID),
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
    users.set(id, await graphGet(`/users/${id}?$select=id,displayName,userPrincipalName,userType,accountEnabled`, TOOL_ID));
  });
  for (const a of assignments) if (a.principal && users.has(a.principal.id)) a.principal = { ...a.principal, ...users.get(a.principal.id) };
  return itemErrors(TOOL_ID, "users", "privileged users looked up", failures, Math.min(ids.length, MAX_USERS));
}

async function roleFindings() {
  const [{ roleById, assignments: all }, pim] = await Promise.all([loadRoles(), loadPim()]);
  const assignments = all.filter((a) => (roleById.get(a.roleDefinitionId) || {}).privileged);
  const findings = await enrichUsers(assignments);
  const globalAdmins = new Set();
  const privilegedUsers = new Map(); // user id -> { user, roles }
  for (const a of assignments) {
    const role = roleById.get(a.roleDefinitionId);
    const p = a.principal || { id: a.principalId };
    if (!role || !role.privileged) continue;
    if (role.template === GLOBAL_ADMIN && kindOf(p) === "user" && p.accountEnabled !== false) globalAdmins.add(p.id);
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
      findings.push({ ...base, kind: "privileged-group", id: `${a.id}#group`, detail: `Group holds ${role.name}${scope}: its owners and members get the role. Keep the group role-assignable with few owners` });
    }
  }
  const n = globalAdmins.size;
  if (n > 4) findings.push({ kind: "too-many-global-admins", id: `${TOOL_ID}/global-admins`, name: "Global Administrators", resourceGroup: null, subscriptionId: null, detail: `${n} enabled users are Global Administrator; Microsoft advises fewer than five. Use narrower roles for day-to-day work` });
  if (n < 2) findings.push({ kind: "too-few-global-admins", id: `${TOOL_ID}/global-admins`, name: "Global Administrators", resourceGroup: null, subscriptionId: null, detail: `${n} enabled user${n === 1 ? " is" : "s are"} Global Administrator. Keep at least two (one an emergency access account) so a lost account does not lock you out` });
  return { findings, privilegedUsers };
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
  const extra = await runChecks(TOOL_ID, { MFA: () => mfaFindings(state.privilegedUsers) });
  return [...state.findings, ...extra];
}

module.exports = {
  id: TOOL_ID,
  label: "Privileged roles",
  schedule: "0 5 * * *", // daily at 05:00
  run,
};
