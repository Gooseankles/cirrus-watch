// Gaps in Conditional Access: no MFA for everyone or for admins, legacy
// authentication not blocked, device code flow not blocked, no authentication
// strength (phishing-resistant MFA) for admins, admins excluded from MFA or
// block policies, policies left in report-only, policies with long exclusion
// lists. Report-only policies never count as enforcing. Tenants on security
// defaults get one note instead.
// Graph: Policy.Read.All (Conditional Access needs Entra ID P1 or P2);
// RoleManagement.Read.Directory, User.Read.All and GroupMember.Read.All for the
// admins excluded from policies.
const settings = require("../settings");
const { graphGet, graphGetAll } = require("../graphClient");
const { numberSetting, mapLimit, scanError, graphHint } = require("./util");
const { PRIVILEGED_TEMPLATES } = require("./privilegedRoles");

const TOOL_ID = "conditional-access";
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
const TENANT = { resourceGroup: null, subscriptionId: null };
const MAX_ADMINS = 300; // privileged users looked up
const MAX_GROUPS = 50; // role groups and excluded groups expanded
const MAX_NAMED = 3; // policies named in one finding

const arr = (x) => (Array.isArray(x) ? x : []);
const users = (p) => (p.conditions && p.conditions.users) || {};
const grant = (p) => p.grantControls || {};
const allUsers = (p) => arr(users(p).includeUsers).includes("All");
const allApps = (p) => arr(((p.conditions || {}).applications || {}).includeApplications).includes("All");
const exclusions = (p) => arr(users(p).excludeUsers).length + arr(users(p).excludeGroups).length + arr(users(p).excludeRoles).length;

// MFA counts when it is required, not one choice among weaker ones.
function requiresMfa(p) {
  const g = grant(p);
  if (g.authenticationStrength) return true;
  const ctl = arr(g.builtInControls);
  return ctl.includes("mfa") && (String(g.operator).toUpperCase() !== "OR" || ctl.length === 1);
}
const coversAdmins = (p) => allUsers(p) || arr(users(p).includeRoles).includes(GLOBAL_ADMIN);
function blocksLegacy(p) {
  const types = arr((p.conditions || {}).clientAppTypes);
  return arr(grant(p).builtInControls).includes("block") && types.includes("exchangeActiveSync") && types.includes("other") && allUsers(p) && allApps(p);
}

// Blocks sign-in through the device code flow for all users (a phishing route: the victim enters a code and so
// signs in the attacker's session).
function blocksDeviceCode(p) {
  const methods = String((((p.conditions || {}).authenticationFlows) || {}).transferMethods || "").split(",").map((m) => m.trim());
  return methods.includes("deviceCodeFlow") && arr(grant(p).builtInControls).includes("block") && allUsers(p);
}
const strengthForAdmins = (p) => Boolean(grant(p).authenticationStrength) && coversAdmins(p);

function analyse(policies, securityDefaults, maxExclusions) {
  const on = policies.filter((p) => p.state === "enabled");
  const findings = [];
  if (!on.length) {
    if (securityDefaults) {
      return [{ ...TENANT, kind: "security-defaults-only", id: `${TOOL_ID}/security-defaults`, name: "Security defaults", detail: "Security defaults are on (MFA for everyone, legacy sign-in blocked) and no Conditional Access policy is enabled. Fine for small tenants; Conditional Access gives finer control" }];
    }
    findings.push({ ...TENANT, kind: "ca-none", id: `${TOOL_ID}/none`, name: "Conditional Access", detail: "No Conditional Access policy is enabled and security defaults are off: nothing requires MFA at sign-in" });
  } else {
    const mfaAll = on.filter((p) => allUsers(p) && allApps(p) && requiresMfa(p));
    if (!mfaAll.length) findings.push({ ...TENANT, kind: "ca-no-mfa-all-users", id: `${TOOL_ID}/mfa-all`, name: "MFA for all users", detail: "No enabled policy requires MFA for all users on all cloud apps" });
    if (!on.some((p) => coversAdmins(p) && requiresMfa(p))) findings.push({ ...TENANT, kind: "ca-no-admin-mfa", id: `${TOOL_ID}/mfa-admins`, name: "MFA for administrators", detail: "No enabled policy requires MFA for Global Administrators" });
    if (!on.some(blocksLegacy)) findings.push({ ...TENANT, kind: "ca-legacy-auth-not-blocked", id: `${TOOL_ID}/legacy-auth`, name: "Legacy authentication", detail: "No enabled policy blocks legacy authentication (Exchange ActiveSync and other old clients), which cannot do MFA" });
    if (!on.some(blocksDeviceCode)) findings.push({ ...TENANT, kind: "ca-device-code-not-blocked", id: `${TOOL_ID}/device-code`, name: "Device code flow", detail: "No enabled policy for all users blocks the device code flow (Conditions, Authentication flows). Attackers use it in phishing: the victim enters a code and signs the attacker in. Block it and exclude only the devices that need it" });
    if (!on.some(strengthForAdmins)) findings.push({ ...TENANT, kind: "ca-no-admin-auth-strength", id: `${TOOL_ID}/admin-strength`, name: "Authentication strength for administrators", detail: "No enabled policy requires an authentication strength (such as phishing-resistant MFA) for Global Administrators. Plain MFA can be phished; require passkeys, Windows Hello or certificates for admin roles" });
  }
  for (const p of policies) {
    const base = { ...TENANT, name: p.displayName || p.id };
    if (p.state === "enabledForReportingButNotEnforced") {
      findings.push({ ...base, kind: "ca-report-only", id: `${p.id}#report-only`, detail: `Report-only since ${String(p.modifiedDateTime || p.createdDateTime || "").slice(0, 10) || "unknown"}: it logs what it would do but enforces nothing` });
    }
    const n = exclusions(p);
    if (p.state === "enabled" && n > maxExclusions) {
      const u = users(p);
      findings.push({ ...base, kind: "ca-many-exclusions", id: `${p.id}#exclusions`, detail: `Excludes ${arr(u.excludeUsers).length} users, ${arr(u.excludeGroups).length} groups and ${arr(u.excludeRoles).length} roles. Keep exclusions to emergency access accounts` });
    }
  }
  return findings;
}

// Admins (users holding a privileged role) that an enabled MFA or block policy would cover but excludes, by user,
// group or role. admins: [{ id, upn, roles: Set of role template ids, synced }]; groupMembers: Map group id -> Set of
// user ids; named: break-glass UPNs (lower case). Named emergency access accounts are skipped. When none are named,
// a cloud-only Global Administrator excluded from every such policy is taken for one, as Privileged roles does.
// Pure, for the tests.
function adminExclusions(policies, admins, groupMembers, named) {
  const enforcing = policies.filter((p) => p.state === "enabled" && (requiresMfa(p) || arr(grant(p).builtInControls).includes("block")));
  const findings = [];
  for (const a of admins) {
    if (named.includes(String(a.upn || "").toLowerCase())) continue;
    const applies = enforcing.filter((p) => allUsers(p) || arr(users(p).includeUsers).includes(a.id) || arr(users(p).includeRoles).some((r) => a.roles.has(r)));
    const excludedFrom = applies.filter((p) => {
      const u = users(p);
      return arr(u.excludeUsers).includes(a.id) || arr(u.excludeRoles).some((r) => a.roles.has(r)) || arr(u.excludeGroups).some((g) => (groupMembers.get(g) || new Set()).has(a.id));
    });
    if (!excludedFrom.length) continue;
    if (!named.length && a.roles.has(GLOBAL_ADMIN) && !a.synced && excludedFrom.length === applies.length) continue;
    const names = excludedFrom.map((p) => p.displayName || p.id);
    findings.push({
      ...TENANT,
      kind: "ca-admin-excluded",
      id: `${TOOL_ID}/admin-excluded/${a.id}`,
      name: a.upn || a.id,
      principalId: a.id,
      detail: `Holds a privileged role but is excluded from ${names.length} enabled MFA or block polic${names.length === 1 ? "y" : "ies"}: ${names.slice(0, MAX_NAMED).join(", ")}${names.length > MAX_NAMED ? ` and ${names.length - MAX_NAMED} more` : ""}. If this is an emergency access account, list it in the "Emergency access accounts" setting`,
    });
  }
  return findings;
}

const isType = (p, t) => String((p && p["@odata.type"]) || "").toLowerCase().includes(t);

// Active privileged role holders (direct or through a role group) and the members of excluded groups.
async function adminExclusionFindings(policies) {
  const enabled = policies.filter((p) => p.state === "enabled");
  if (!enabled.some((p) => arr(users(p).excludeUsers).length || arr(users(p).excludeGroups).length || arr(users(p).excludeRoles).length)) return [];
  const assignments = await graphGetAll("/roleManagement/directory/roleAssignments?$expand=principal", TOOL_ID);
  const admins = new Map(); // user id -> { id, upn, roles, synced }
  const add = (u, template) => {
    if (!admins.has(u.id)) admins.set(u.id, { id: u.id, upn: u.userPrincipalName || u.displayName || "", roles: new Set(), synced: u.onPremisesSyncEnabled === true });
    admins.get(u.id).roles.add(template);
  };
  const roleGroups = new Map(); // group id -> Set of role templates
  for (const a of assignments) {
    if (!PRIVILEGED_TEMPLATES.has(a.roleDefinitionId) || (a.directoryScopeId && a.directoryScopeId !== "/")) continue;
    const p = a.principal || {};
    if (isType(p, "group")) roleGroups.set(p.id, (roleGroups.get(p.id) || new Set()).add(a.roleDefinitionId));
    else if (!isType(p, "serviceprincipal") && p.id) add(p, a.roleDefinitionId);
  }
  const excludedGroups = new Set(enabled.flatMap((p) => arr(users(p).excludeGroups)));
  const groupIds = [...new Set([...roleGroups.keys(), ...excludedGroups])].slice(0, MAX_GROUPS);
  const groupMembers = new Map();
  const groupFailures = await mapLimit(groupIds, 4, async (id) => {
    const members = await graphGetAll(`/groups/${id}/transitiveMembers/microsoft.graph.user?$select=id,userPrincipalName,displayName,onPremisesSyncEnabled&$top=999`, TOOL_ID);
    groupMembers.set(id, new Set(members.map((m) => m.id)));
    for (const t of roleGroups.get(id) || []) for (const m of members) add(m, t);
  });
  // The expanded principal has default fields only: look up whether holders are synced and their sign-in name.
  const list = [...admins.values()].slice(0, MAX_ADMINS);
  const userFailures = await mapLimit(list, 6, async (a) => {
    const u = await graphGet(`/users/${a.id}?$select=id,userPrincipalName,onPremisesSyncEnabled`, TOOL_ID);
    a.synced = a.synced || u.onPremisesSyncEnabled === true;
    a.upn = u.userPrincipalName || a.upn;
  });
  const named = String(settings.get("BREAK_GLASS_ACCOUNTS") || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const findings = adminExclusions(policies, list, groupMembers, named);
  if (groupFailures.length) findings.push(scanError(TOOL_ID, "admin-groups", `${groupFailures.length} of ${groupIds.length} groups not expanded for the admin exclusion check`, graphHint({ message: groupFailures[0].message }, "GroupMember.Read.All")));
  if (userFailures.length) findings.push(scanError(TOOL_ID, "admin-users", `${userFailures.length} of ${list.length} admins not looked up for the admin exclusion check`, graphHint({ message: userFailures[0].message }, "User.Read.All")));
  return findings;
}

async function run() {
  const maxExclusions = numberSetting("CA_MAX_EXCLUSIONS", 5, { min: 0, max: 1000 });
  let defaults;
  try {
    defaults = !!(await graphGet("/policies/identitySecurityDefaultsEnforcementPolicy", TOOL_ID)).isEnabled;
  } catch (err) {
    throw new Error(graphHint(err, "Policy.Read.All"));
  }
  let policies;
  try {
    policies = await graphGetAll("/identity/conditionalAccess/policies", TOOL_ID);
  } catch (err) {
    // Without P1 there is no Conditional Access to read; security defaults
    // are then the only protection.
    if (defaults) policies = [];
    else throw new Error(graphHint(err, "Policy.Read.All"));
  }
  const findings = analyse(policies, defaults, maxExclusions);
  try {
    findings.push(...(await adminExclusionFindings(policies)));
  } catch (err) {
    findings.push(scanError(TOOL_ID, "admin-exclusions", "Admins excluded from policies not checked", graphHint(err, "RoleManagement.Read.Directory")));
  }
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Conditional Access",
  schedule: "45 5 * * *", // daily at 05:45
  run,
  _test: { analyse, requiresMfa, blocksLegacy, blocksDeviceCode, adminExclusions },
};
