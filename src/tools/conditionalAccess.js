// Gaps in Conditional Access: no MFA for everyone or for admins, legacy
// authentication not blocked, policies left in report-only, policies with long
// exclusion lists. Tenants on security defaults get one note instead.
// Graph: Policy.Read.All (Conditional Access needs Entra ID P1 or P2).
const { graphGet, graphGetAll } = require("../graphClient");
const { numberSetting, graphHint } = require("./util");

const TOOL_ID = "conditional-access";
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
const TENANT = { resourceGroup: null, subscriptionId: null };

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
  return analyse(policies, defaults, maxExclusions);
}

module.exports = {
  id: TOOL_ID,
  label: "Conditional Access",
  schedule: "45 5 * * *", // daily at 05:45
  run,
  _test: { analyse, requiresMfa, blocksLegacy },
};
