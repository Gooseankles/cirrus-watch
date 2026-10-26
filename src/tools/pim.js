// PIM (Privileged Identity Management) health, for Entra admin roles and the
// powerful Azure roles on each subscription:
// - role settings: activating a privileged role needs no MFA, no reason, no
//   approval (Global and Privileged Role Administrator), lasts too long, or
//   admins may hand out the role permanently;
// - eligible people: guests, disabled accounts, eligibility that never ends or
//   runs out soon, and eligibility nobody has activated for a long time.
// Only roles someone is eligible for are checked: unused settings are noise.
// Graph: RoleManagement.Read.Directory (roles, PIM schedules and settings),
// User.Read.All (names, guests, disabled). Azure: Reader. Licence: Entra ID P2.
const { graphGet, graphGetAll } = require("../graphClient");
const { armGet, subscriptionIdsToScan, subscriptionNames } = require("../armClient");
const { numberSetting, mapLimit, runChecks, scanError, itemErrors, graphHint, daysUntil } = require("./util");

const TOOL_ID = "pim";
const MAX_USERS = 500; // eligible users looked up for type and status
const GLOBAL_ADMIN = "62e90394-69f5-4237-9190-012177145e10";
const PRIV_ROLE_ADMIN = "e8611ab8-c189-46e8-94e1-60213ab1f814";
const NEED_APPROVAL = new Set([GLOBAL_ADMIN, PRIV_ROLE_ADMIN]);

// Same list as the privileged-roles scan, for when Graph does not mark a role isPrivileged.
const PRIVILEGED_TEMPLATES = new Set([
  GLOBAL_ADMIN, PRIV_ROLE_ADMIN,
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

// Azure roles that control everything or who gets access (role definition GUIDs).
const AZURE_PRIVILEGED = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "Owner",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
  "f58310d9-a9f6-439a-9e8d-f62e7b41a168": "Role Based Access Control Administrator",
};
const OWNER_LIKE = new Set(["8e3af657-a8ff-443c-a75c-2fe8c4bcb635", "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9"]);

const noPremium = (err) => /RequestFromNonPremiumTenant|NonPremium|premium license|AadPremiumLicenseRequired/i.test(String(err && err.message));
const guid = (rid) => String(rid || "").toLowerCase().split("/").pop();
const isGuest = (u) => Boolean(u) && (u.userType === "Guest" || /#EXT#/i.test(u.userPrincipalName || ""));
const labelOf = (u, id) => (u && (u.userPrincipalName || u.displayName)) || id;

// ISO 8601 duration (PT8H, P1DT4H, P365D) in hours; null when unreadable.
function hours(iso) {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(String(iso || ""));
  if (!m) return null;
  return (Number(m[1] || 0) * 24) + Number(m[2] || 0) + Number(m[3] || 0) / 60 + Number(m[4] || 0) / 3600;
}
const durationText = (h) => (h >= 48 && h % 24 === 0 ? `${h / 24} days` : `${Math.round(h * 10) / 10} hours`);

// Problems in one role's PIM settings. The rule ids are the same in Graph and
// ARM; Graph names the type in @odata.type, ARM in ruleType. -> [{ kind, text }]
function policyProblems(rules, { approval }) {
  const byId = new Map((rules || []).map((r) => [r.id, r]));
  const out = [];
  const enable = byId.get("Enablement_EndUser_Assignment");
  const enabled = new Set(((enable && enable.enabledRules) || []).map(String));
  const authContext = byId.get("AuthenticationContext_EndUser_Assignment");
  if (enable && !enabled.has("MultiFactorAuthentication") && !(authContext && authContext.isEnabled)) {
    out.push({ kind: "pim-activation-no-mfa", text: "can be activated without MFA or an authentication context" });
  }
  if (enable && !enabled.has("Justification")) out.push({ kind: "pim-activation-no-reason", text: "can be activated without giving a reason" });
  const appr = byId.get("Approval_EndUser_Assignment");
  if (approval && appr && !(appr.setting && appr.setting.isApprovalRequired)) {
    out.push({ kind: "pim-activation-no-approval", text: "can be activated without anyone approving it" });
  }
  const maxHours = numberSetting("PIM_MAX_ACTIVATION_HOURS", 8, { min: 1, max: 24 });
  const exp = byId.get("Expiration_EndUser_Assignment");
  const h = exp && hours(exp.maximumDuration);
  if (h && h > maxHours) out.push({ kind: "pim-activation-too-long", text: `stays active for up to ${durationText(h)} after activation (limit here ${maxHours} hours)` });
  const active = byId.get("Expiration_Admin_Assignment");
  if (active && active.isExpirationRequired === false) out.push({ kind: "pim-permanent-active-allowed", text: "may be assigned as permanently active, which skips PIM" });
  const eligible = byId.get("Expiration_Admin_Eligibility");
  if (eligible && eligible.isExpirationRequired === false) out.push({ kind: "pim-permanent-eligible-allowed", text: "may be made eligible with no end date, so access is never re-checked" });
  return out;
}

// --- Entra roles ---

async function roleDefinitions() {
  let defs;
  try {
    defs = await graphGetAll("https://graph.microsoft.com/beta/roleManagement/directory/roleDefinitions?$select=id,displayName,templateId,isPrivileged", TOOL_ID);
  } catch {
    defs = await graphGetAll("/roleManagement/directory/roleDefinitions?$select=id,displayName,templateId", TOOL_ID);
  }
  const byId = new Map();
  for (const d of defs) {
    const template = d.templateId || d.id;
    const role = { name: d.displayName, template, privileged: d.isPrivileged === true || PRIVILEGED_TEMPLATES.has(template) };
    byId.set(d.id, role);
    byId.set(template, role);
  }
  return byId;
}

// The expanded principal has default fields only: fetch type and status.
async function lookUpUsers(ids) {
  const users = new Map();
  const list = [...new Set(ids)].slice(0, MAX_USERS);
  const failures = await mapLimit(list, 6, async (id) => {
    try {
      users.set(id, await graphGet(`/users/${id}?$select=id,displayName,userPrincipalName,userType,accountEnabled`, TOOL_ID));
    } catch (err) {
      if (/\(404\)|Request_ResourceNotFound/i.test(String(err && err.message))) return; // a group or app, not a user
      throw err;
    }
  });
  const errors = itemErrors(TOOL_ID, "users", "eligible users looked up", failures, list.length);
  for (const e of errors) e.detail = graphHint({ message: e.detail }, "User.Read.All");
  return { users, errors };
}

// When each person last activated each role, from PIM's own request history.
async function lastActivations() {
  const rows = await graphGetAll("/roleManagement/directory/roleAssignmentScheduleRequests?$select=principalId,roleDefinitionId,action,createdDateTime", TOOL_ID);
  const last = new Map();
  let oldest = Date.now();
  for (const r of rows) {
    const t = Date.parse(r.createdDateTime);
    if (Number.isFinite(t)) oldest = Math.min(oldest, t);
    if (r.action !== "selfActivate" || !Number.isFinite(t)) continue;
    const key = `${r.principalId}|${r.roleDefinitionId}`;
    if (!last.has(key) || last.get(key) < t) last.set(key, t);
  }
  return { last, oldest };
}

async function entraRoles() {
  let roles, eligible;
  try {
    [roles, eligible] = await Promise.all([
      roleDefinitions(),
      graphGetAll("/roleManagement/directory/roleEligibilityScheduleInstances?$select=id,principalId,roleDefinitionId,directoryScopeId,startDateTime,endDateTime", TOOL_ID),
    ]);
  } catch (err) {
    if (noPremium(err)) {
      return [scanError(TOOL_ID, "entra-licence", "PIM for Entra roles not checked", "PIM needs Microsoft Entra ID P2 in this tenant; without it there is nothing to check")];
    }
    throw new Error(graphHint(err, "RoleManagement.Read.Directory"));
  }
  eligible = eligible.filter((e) => (roles.get(e.roleDefinitionId) || {}).privileged);
  if (!eligible.length) return [];

  const findings = [];
  const [{ users, errors }, history, settings] = await Promise.all([
    lookUpUsers(eligible.map((e) => e.principalId)),
    lastActivations().catch((err) => {
      findings.push(scanError(TOOL_ID, "entra-history", "Unused eligibility not checked", graphHint(err, "RoleManagement.Read.Directory")));
      return null;
    }),
    entraSettings(roles, new Set(eligible.map((e) => (roles.get(e.roleDefinitionId) || {}).template))).catch((err) => [
      scanError(TOOL_ID, "entra-settings", "PIM settings for Entra roles not checked", graphHint(err, "RoleManagement.Read.Directory")),
    ]),
  ]);
  findings.push(...errors, ...settings);

  const soonDays = numberSetting("PIM_EXPIRY_WARN_DAYS", 14, { min: 1, max: 90 });
  const unusedDays = numberSetting("PIM_UNUSED_DAYS", 90, { min: 14, max: 730 });
  const now = Date.now();
  for (const e of eligible) {
    const role = roles.get(e.roleDefinitionId);
    const u = users.get(e.principalId);
    const scope = e.directoryScopeId && e.directoryScopeId !== "/" ? ` (scope ${e.directoryScopeId})` : "";
    const base = { name: labelOf(u, e.principalId), resourceGroup: null, subscriptionId: null, principalId: e.principalId };
    const what = `${role.name}${scope}`;
    if (u && isGuest(u)) findings.push({ ...base, kind: "pim-eligible-guest", id: `${e.id}#guest`, detail: `Guest account is eligible for ${what}. A guest's own organisation controls its sign-in and MFA` });
    if (u && u.accountEnabled === false) findings.push({ ...base, kind: "pim-eligible-disabled", id: `${e.id}#disabled`, detail: `Disabled account is still eligible for ${what}; remove the eligibility` });
    if (u && u.accountEnabled === false) continue;
    if (!e.endDateTime) {
      findings.push({ ...base, kind: "pim-eligible-no-end", id: `${e.id}#no-end`, detail: `Eligible for ${what} with no end date. Set an end date so the need is checked again` });
    } else {
      const left = daysUntil(e.endDateTime, now);
      if (left >= 0 && left <= soonDays) findings.push({ ...base, kind: "pim-eligible-expiring", id: `${e.id}#expiring`, detail: `Eligibility for ${what} ends in ${left} day${left === 1 ? "" : "s"} (${e.endDateTime.slice(0, 10)}). Extend it if it is still needed` });
    }
    // Unused: eligible longer than the window and no activation in a history that reaches back that far.
    const since = Date.parse(e.startDateTime);
    const windowStart = now - unusedDays * 86400000;
    if (history && Number.isFinite(since) && since < windowStart && history.oldest <= windowStart) {
      const lastUse = history.last.get(`${e.principalId}|${e.roleDefinitionId}`) || history.last.get(`${e.principalId}|${role.template}`);
      if (!lastUse || lastUse < windowStart) {
        findings.push({ ...base, kind: "pim-eligible-unused", id: `${e.id}#unused`, detail: `Eligible for ${what} but has not activated it in ${unusedDays} days${lastUse ? ` (last ${new Date(lastUse).toISOString().slice(0, 10)})` : ""}. Remove the eligibility if it is not needed` });
      }
    }
  }
  return findings;
}

// PIM settings of the privileged Entra roles in use (templates). One policy per role, tenant-wide.
async function entraSettings(roles, templates) {
  const rows = await graphGetAll("/policies/roleManagementPolicyAssignments?$filter=scopeId eq '/' and scopeType eq 'DirectoryRole'&$expand=policy($expand=rules)", TOOL_ID);
  const findings = [];
  for (const a of rows) {
    const role = roles.get(a.roleDefinitionId);
    if (!role || !templates.has(role.template)) continue;
    for (const p of policyProblems(a.policy && a.policy.rules, { approval: NEED_APPROVAL.has(role.template) })) {
      findings.push({ kind: p.kind, id: `${TOOL_ID}/entra/${role.template}/${p.kind}`, name: role.name, resourceGroup: null, subscriptionId: null, detail: `Entra role ${role.name} ${p.text}` });
    }
  }
  return findings;
}

// --- Azure roles ---

async function azureRoles() {
  const [subs, names] = await Promise.all([subscriptionIdsToScan(TOOL_ID), subscriptionNames(TOOL_ID).catch(() => new Map())]);
  const findings = [];
  const failures = await mapLimit(subs, 4, async (s) => {
    const base = `https://management.azure.com/subscriptions/${s}/providers/Microsoft.Authorization`;
    const all = async (path) => {
      const rows = [];
      let url = `${base}/${path}`;
      while (url) {
        const page = await armGet(url, TOOL_ID);
        rows.push(...(page.value || []));
        url = page.nextLink;
      }
      return rows;
    };
    const eligible = (await all("roleEligibilityScheduleInstances?api-version=2020-10-01")).map((r) => r.properties || {});
    const inUse = new Set(eligible.map((p) => guid(p.roleDefinitionId)).filter((g) => AZURE_PRIVILEGED[g]));
    if (!inUse.size) return; // PIM is not used for the powerful roles here
    const subName = names.get(s) || s;

    // Settings: the subscription-scope policy of each privileged role someone is eligible for.
    const [assignments, policies, active] = await Promise.all([
      all("roleManagementPolicyAssignments?api-version=2020-10-01"),
      all("roleManagementPolicies?api-version=2020-10-01"),
      all("roleAssignmentScheduleInstances?api-version=2020-10-01"),
    ]);
    const policyById = new Map(policies.map((p) => [String(p.id).toLowerCase(), p]));
    for (const a of assignments) {
      const props = a.properties || {};
      const g = guid(props.roleDefinitionId);
      if (!inUse.has(g)) continue;
      const policy = policyById.get(String(props.policyId).toLowerCase());
      const rules = policy && policy.properties && (policy.properties.effectiveRules || policy.properties.rules);
      for (const p of policyProblems(rules, { approval: OWNER_LIKE.has(g) })) {
        findings.push({ kind: p.kind, id: `/subscriptions/${s}#pim/${g}/${p.kind}`, name: `${AZURE_PRIVILEGED[g]} on ${subName}`, resourceGroup: null, subscriptionId: s, detail: `Azure role ${AZURE_PRIVILEGED[g]} on subscription ${subName} ${p.text}` });
      }
    }

    // Standing: a person holds the role permanently next to people who must activate it.
    for (const r of active) {
      const p = r.properties || {};
      const g = guid(p.roleDefinitionId);
      if (!inUse.has(g) || p.assignmentType === "Activated" || p.endDateTime || p.memberType === "Inherited") continue;
      const who = p.expandedProperties && p.expandedProperties.principal;
      if (who && /serviceprincipal/i.test(who.type || "")) continue; // apps cannot activate roles
      const scope = p.scope || `/subscriptions/${s}`;
      findings.push({
        kind: "pim-azure-standing",
        id: `${r.id}#standing`,
        name: (who && (who.email || who.displayName)) || p.principalId,
        resourceGroup: (scope.match(/resourceGroups\/([^/]+)/i) || [])[1] || null,
        subscriptionId: s,
        principalId: p.principalId,
        detail: `${AZURE_PRIVILEGED[g]} is assigned permanently at ${scope === `/subscriptions/${s}` ? `subscription ${subName}` : scope}, while others must activate it through PIM. Make it eligible`,
      });
    }
  });
  findings.push(...itemErrors(TOOL_ID, "azure", "subscriptions checked for PIM", failures.map((f) => ({ ...f, item: { subscriptionId: f.item } })), subs.length));
  return findings;
}

async function run() {
  return runChecks(TOOL_ID, { "Entra roles": entraRoles, "Azure roles": azureRoles });
}

module.exports = {
  id: TOOL_ID,
  label: "PIM",
  schedule: "10 5 * * *", // daily at 05:10
  run,
  policyProblems, // for tests
};
