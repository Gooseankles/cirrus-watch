// PIM (Privileged Identity Management) review, for Entra roles and Azure roles:
// - who has PIM access: every person who can activate a role or is active
//   through PIM, directly or through a group. A group can give PIM access in
//   two ways: the group is eligible for a role (its members may activate it),
//   or the group holds a role and people are eligible members of the group
//   ("PIM for Groups": they activate the membership). Saved each run
//   (pim/inventory.json in the tenant's history storage) for the PIM access
//   and Groups views;
// - role settings: activating a privileged role needs no MFA, no reason, no
//   approval (Global and Privileged Role Administrator, Owner, User Access
//   Administrator), lasts too long, or admins may hand out the role
//   permanently. Only roles someone is eligible for are checked;
// - people: guests and disabled accounts with PIM access to a privileged role,
//   access that never ends, ends soon or is never used;
// - groups that give PIM access to a privileged role but are not
//   role-assignable, or also have permanent members who skip PIM;
// - permanent Azure Owners next to people who must activate the same role.
// Graph: RoleManagement.Read.Directory, User.Read.All, GroupMember.Read.All,
// PrivilegedEligibilitySchedule.Read.AzureADGroup and
// PrivilegedAssignmentSchedule.Read.AzureADGroup. Azure: Reader. Entra ID P2.
const store = require("../findingsStore");
const log = require("../log");
const tenants = require("../tenants");
const { graphGetAll } = require("../graphClient");
const { armGet, subscriptionIdsToScan, subscriptionNames } = require("../armClient");
const { numberSetting, mapLimit, runChecks, scanError, itemErrors, graphHint, daysUntil } = require("./util");

const TOOL_ID = "pim";
const INVENTORY_KEY = "pim/inventory.json";
const MAX_GROUPS = 300; // groups holding roles that are checked for members and PIM for Groups
const MAX_NAMED = 5; // people named in one finding
const DAY = 86400000;
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
  "b24988ac-6180-42a0-ab88-20f7382dd24c": "Contributor",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
  "f58310d9-a9f6-439a-9e8d-f62e7b41a168": "Role Based Access Control Administrator",
};
const OWNER_LIKE = new Set(["8e3af657-a8ff-443c-a75c-2fe8c4bcb635", "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9"]);

const noPremium = (err) => /RequestFromNonPremiumTenant|NonPremium|premium license|AadPremiumLicenseRequired/i.test(String(err && err.message));
const guid = (rid) => String(rid || "").toLowerCase().split("/").pop();
const isGuest = (u) => Boolean(u) && (u.userType === "Guest" || /#EXT#/i.test(u.userPrincipalName || ""));
const earliest = (...dates) => dates.filter(Boolean).sort()[0] || null;

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

// A grant is one role at one scope given to one principal:
// { plane, roleKey, role, privileged, approval, scope, scopeText, subscriptionId, resourceGroup,
//   principalId, state: "eligible" | "active" (activated now) | "assigned" (standing or time-bound), start, end, ref }

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

// When each principal last activated each role, from PIM's own request history.
async function entraActivations() {
  const rows = await graphGetAll("/roleManagement/directory/roleAssignmentScheduleRequests?$select=principalId,roleDefinitionId,action,createdDateTime", TOOL_ID);
  const h = history();
  for (const r of rows) h.add(r.createdDateTime, r.action === "selfActivate" && `${r.principalId}|entra|${r.roleDefinitionId}`);
  return h;
}

// Activation history: key -> latest time, plus how far back the history goes.
function history() {
  const last = new Map();
  return {
    last,
    oldest: Date.now(),
    add(when, key) {
      const t = Date.parse(when);
      if (!Number.isFinite(t)) return;
      this.oldest = Math.min(this.oldest, t);
      if (key && (!last.has(key) || last.get(key) < t)) last.set(key, t);
    },
  };
}

async function entraGrants(ctx) {
  let roles, eligible, active;
  try {
    [roles, eligible, active] = await Promise.all([
      roleDefinitions(),
      graphGetAll("/roleManagement/directory/roleEligibilityScheduleInstances?$select=id,principalId,roleDefinitionId,directoryScopeId,startDateTime,endDateTime", TOOL_ID),
      graphGetAll("/roleManagement/directory/roleAssignmentScheduleInstances?$select=id,principalId,roleDefinitionId,directoryScopeId,assignmentType,startDateTime,endDateTime", TOOL_ID),
    ]);
  } catch (err) {
    if (noPremium(err)) {
      ctx.notes.push("PIM for Entra roles is not available: the tenant has no Microsoft Entra ID P2.");
      return [];
    }
    throw new Error(graphHint(err, "RoleManagement.Read.Directory"));
  }
  const grant = (x, state) => {
    const role = roles.get(x.roleDefinitionId) || { name: x.roleDefinitionId, template: x.roleDefinitionId, privileged: false };
    const scoped = x.directoryScopeId && x.directoryScopeId !== "/";
    return {
      plane: "entra", roleKey: `entra|${role.template}`, roleIds: [x.roleDefinitionId, role.template], role: role.name, privileged: role.privileged,
      approval: NEED_APPROVAL.has(role.template), scope: x.directoryScopeId || "/", scopeText: scoped ? `Entra scope ${x.directoryScopeId}` : "Whole tenant",
      subscriptionId: null, resourceGroup: null, principalId: x.principalId, state, start: x.startDateTime || null, end: x.endDateTime || null, ref: x.id,
    };
  };
  const out = eligible.map((x) => grant(x, "eligible"));
  for (const a of active) out.push(grant(a, a.assignmentType === "Activated" ? "active" : "assigned"));

  const findings = [];
  try {
    ctx.histories.push(await entraActivations());
  } catch (err) {
    findings.push(scanError(TOOL_ID, "entra-history", "Unused Entra role eligibility not checked", graphHint(err, "RoleManagement.Read.Directory")));
  }
  try {
    findings.push(...(await entraSettings(roles, new Set(out.filter((g) => g.state === "eligible" && g.privileged).map((g) => g.roleKey)))));
  } catch (err) {
    findings.push(scanError(TOOL_ID, "entra-settings", "PIM settings for Entra roles not checked", graphHint(err, "RoleManagement.Read.Directory")));
  }
  ctx.findings.push(...findings);
  return out;
}

// PIM settings of the privileged Entra roles in use. One policy per role, tenant-wide.
async function entraSettings(roles, inUse) {
  if (!inUse.size) return [];
  const rows = await graphGetAll("/policies/roleManagementPolicyAssignments?$filter=scopeId eq '/' and scopeType eq 'DirectoryRole'&$expand=policy($expand=rules)", TOOL_ID);
  const findings = [];
  for (const a of rows) {
    const role = roles.get(a.roleDefinitionId);
    if (!role || !inUse.has(`entra|${role.template}`)) continue;
    for (const p of policyProblems(a.policy && a.policy.rules, { approval: NEED_APPROVAL.has(role.template) })) {
      findings.push({ kind: p.kind, id: `${TOOL_ID}/entra/${role.template}/${p.kind}`, name: role.name, resourceGroup: null, subscriptionId: null, detail: `Entra role ${role.name} ${p.text}` });
    }
  }
  return findings;
}

// --- Azure roles ---

function azureScopeText(scope, sub, subName) {
  const s = String(scope || "");
  const mg = s.match(/managementGroups\/([^/]+)$/i);
  if (mg) return `Management group ${mg[1]}`;
  if (s === "/") return "Tenant root";
  if (s.toLowerCase() === `/subscriptions/${sub}`.toLowerCase()) return `Subscription ${subName}`;
  return s.replace(/^\/subscriptions\/[^/]+/i, "").replace(/^\/resourceGroups\//i, "rg ").replace(/\/providers\//i, " / ");
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

async function azureGrants(ctx) {
  const [subs, names] = await Promise.all([subscriptionIdsToScan(TOOL_ID), subscriptionNames(TOOL_ID).catch(() => new Map())]);
  const out = [];
  const seen = new Set(); // instances inherited from a management group show up in every subscription
  const failures = await mapLimit(subs, 4, async (s) => {
    const base = `https://management.azure.com/subscriptions/${s}/providers/Microsoft.Authorization`;
    const subName = names.get(s) || s;
    const [eligible, active] = await Promise.all([
      armAll(`${base}/roleEligibilityScheduleInstances?api-version=2020-10-01`),
      armAll(`${base}/roleAssignmentScheduleInstances?api-version=2020-10-01`),
    ]);
    const grant = (r, state) => {
      const p = r.properties || {};
      const x = p.expandedProperties || {};
      const g = guid(p.roleDefinitionId);
      const scope = p.scope || (x.scope && x.scope.id) || `/subscriptions/${s}`;
      const inSub = scope.toLowerCase().startsWith(`/subscriptions/${s}`.toLowerCase());
      if (x.principal) ctx.known.set(p.principalId, { name: x.principal.displayName, upn: x.principal.email, type: String(x.principal.type || "").toLowerCase() });
      return {
        plane: "azure", roleKey: `azure|${g}`, roleIds: [g], role: (x.roleDefinition && x.roleDefinition.displayName) || AZURE_PRIVILEGED[g] || g,
        privileged: Boolean(AZURE_PRIVILEGED[g]), approval: OWNER_LIKE.has(g), scope, scopeText: azureScopeText(scope, s, subName),
        subscriptionId: inSub ? s : null, resourceGroup: (scope.match(/resourceGroups\/([^/]+)/i) || [])[1] || null,
        principalId: p.principalId, principalType: String(p.principalType || (x.principal && x.principal.type) || "").toLowerCase(),
        state, start: p.startDateTime || null, end: p.endDateTime || null, ref: r.id, viaGroupAssignment: p.memberType === "Group",
      };
    };
    const mine = [];
    for (const r of eligible) mine.push(grant(r, "eligible"));
    for (const r of active) {
      const p = r.properties || {};
      const state = p.assignmentType === "Activated" ? "active" : "assigned";
      // Standing assignments matter only for groups (PIM for Groups) and the privileged roles (findings).
      const g = grant(r, state);
      if (state === "assigned" && !g.end && g.principalType !== "group" && !g.privileged) continue;
      mine.push(g);
    }
    for (const g of mine) {
      if (g.viaGroupAssignment) continue; // the same access, listed through its group below
      const k = `${g.principalId}|${g.roleKey}|${g.scope.toLowerCase()}|${g.state}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(g);
    }
    const inUse = new Set(mine.filter((g) => g.state === "eligible" && g.privileged).map((g) => guid(g.roleKey)));
    const h = history();
    try {
      for (const r of await armAll(`${base}/roleAssignmentScheduleRequests?api-version=2020-10-01`)) {
        const p = r.properties || {};
        h.add(p.createdOn, /selfactivate/i.test(p.requestType || "") && `${p.principalId}|azure|${guid(p.roleDefinitionId)}`);
      }
      ctx.histories.push(h);
    } catch {
      // history is only used for the unused check; a gap there is not worth a finding per subscription
    }
    if (inUse.size) ctx.findings.push(...(await azureSettings(base, s, subName, inUse)));
    ctx.findings.push(...standingFindings(mine, inUse, s, subName));
  });
  ctx.findings.push(...itemErrors(TOOL_ID, "azure", "subscriptions checked for PIM", failures.map((f) => ({ ...f, item: { subscriptionId: f.item } })), subs.length));
  return out;
}

// Settings: the subscription-scope policy of each privileged role someone is eligible for.
async function azureSettings(base, s, subName, inUse) {
  const [assignments, policies] = await Promise.all([
    armAll(`${base}/roleManagementPolicyAssignments?api-version=2020-10-01`),
    armAll(`${base}/roleManagementPolicies?api-version=2020-10-01`),
  ]);
  const policyById = new Map(policies.map((p) => [String(p.id).toLowerCase(), p]));
  const findings = [];
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
  return findings;
}

// A person holds a privileged role permanently next to people who must activate it.
function standingFindings(grants, inUse, s, subName) {
  const out = [];
  for (const g of grants) {
    if (g.state !== "assigned" || g.end || !g.privileged || !inUse.has(guid(g.roleKey)) || g.viaGroupAssignment) continue;
    if (/serviceprincipal|group/.test(g.principalType)) continue; // apps cannot activate; groups are judged in the group check
    out.push({
      kind: "pim-azure-standing",
      id: `${g.ref}#standing`,
      name: g.principalId,
      principalId: g.principalId,
      resourceGroup: g.resourceGroup,
      subscriptionId: s,
      detail: `${g.role} is assigned permanently at ${g.scopeText}, while others must activate it through PIM. Make it eligible`,
    });
  }
  return out;
}

// --- Principals and groups ---

// Users, groups and apps by id, in batches of 15 (the most an "in" filter takes).
async function lookUp(ids, ctx) {
  const todo = [...new Set(ids)].filter((id) => id && !ctx.people.has(id) && !ctx.groupInfo.has(id) && !ctx.apps.has(id));
  const batches = [];
  for (let i = 0; i < todo.length; i += 15) batches.push(todo.slice(i, i + 15));
  const failures = await mapLimit(batches, 4, async (b) => {
    const list = b.map((id) => `'${id}'`).join(",");
    for (const u of await graphGetAll(`/users?$filter=id in (${list})&$select=id,displayName,userPrincipalName,userType,accountEnabled`, TOOL_ID)) ctx.people.set(u.id, u);
    const rest = b.filter((id) => !ctx.people.has(id));
    if (!rest.length) return;
    const list2 = rest.map((id) => `'${id}'`).join(",");
    for (const g of await graphGetAll(`/groups?$filter=id in (${list2})&$select=id,displayName,isAssignableToRole,securityEnabled`, TOOL_ID)) ctx.groupInfo.set(g.id, g);
    const left = rest.filter((id) => !ctx.groupInfo.has(id));
    if (!left.length) return;
    const list3 = left.map((id) => `'${id}'`).join(",");
    for (const a of await graphGetAll(`/servicePrincipals?$filter=id in (${list3})&$select=id,displayName`, TOOL_ID)) ctx.apps.set(a.id, a);
  });
  const errors = itemErrors(TOOL_ID, "principals", "batches of people, groups and apps looked up", failures, batches.length);
  for (const e of errors) e.detail = graphHint({ message: e.detail }, "User.Read.All and GroupMember.Read.All");
  ctx.findings.push(...errors);
}

// The group activation history (assignmentScheduleRequests) is extra: when
// Graph refuses it, the group is still checked, but the refusal is said once
// per run (log and page note) instead of every member looking never activated.
// Any other error goes on like the sibling calls' (no P2, unsupported group).
function groupHistoryRefused(err, ctx) {
  if (noPremium(err) || !/\(403\)|Authorization_RequestDenied|Forbidden/i.test(String(err && err.message))) throw err;
  if (!ctx.historyRefused) {
    ctx.historyRefused = true;
    const hint = graphHint(err, "PrivilegedAssignmentSchedule.Read.AzureADGroup");
    log.record({ tool: TOOL_ID, level: "info", message: `PIM for Groups activation history not read: ${hint}` });
    ctx.notes.push("PIM for Groups activation history could not be read (Graph refused it), so group activations show no last-activated date.");
  }
  return [];
}

// Members and PIM for Groups state of one group.
async function readGroup(id, ctx) {
  const g = { id, members: [], eligible: [], activated: [], owners: [], pim: true };
  const [members, owners] = await Promise.all([
    graphGetAll(`/groups/${id}/transitiveMembers/microsoft.graph.user?$select=id,displayName,userPrincipalName,userType,accountEnabled&$top=999`, TOOL_ID),
    graphGetAll(`/groups/${id}/owners?$select=id,displayName,userPrincipalName`, TOOL_ID),
  ]);
  for (const u of members) ctx.people.set(u.id, { ...(ctx.people.get(u.id) || {}), ...u });
  g.owners = owners.map((o) => o.userPrincipalName || o.displayName || o.id);
  try {
    const [eligible, active, requests] = await Promise.all([
      graphGetAll(`/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances?$filter=groupId eq '${id}'&$select=principalId,accessId,startDateTime,endDateTime`, TOOL_ID),
      graphGetAll(`/identityGovernance/privilegedAccess/group/assignmentScheduleInstances?$filter=groupId eq '${id}'&$select=principalId,accessId,assignmentType,endDateTime`, TOOL_ID),
      graphGetAll(`/identityGovernance/privilegedAccess/group/assignmentScheduleRequests?$filter=groupId eq '${id}'&$select=principalId,accessId,action,createdDateTime`, TOOL_ID).catch((err) => groupHistoryRefused(err, ctx)),
    ]);
    g.eligible = eligible.map((e) => ({ principalId: e.principalId, access: e.accessId, start: e.startDateTime || null, end: e.endDateTime || null }));
    g.activated = active.filter((a) => a.assignmentType === "Activated").map((a) => ({ principalId: a.principalId, access: a.accessId, end: a.endDateTime || null }));
    const h = history();
    for (const r of requests) h.add(r.createdDateTime, r.action === "selfActivate" && `${r.principalId}|group|${id}|${r.accessId}`);
    ctx.histories.push(h);
  } catch (err) {
    const msg = String(err && err.message);
    if (/ResourceTypeNotSupported/.test(msg) || noPremium(err)) g.pim = false; // a group PIM cannot manage, or no P2
    else if (/\(403\)|Authorization_RequestDenied|Forbidden/i.test(msg)) throw new Error(graphHint(err, "PrivilegedEligibilitySchedule.Read.AzureADGroup and PrivilegedAssignmentSchedule.Read.AzureADGroup"));
    else throw err;
  }
  const activatedMembers = new Set(g.activated.filter((a) => a.access === "member").map((a) => a.principalId));
  g.permanent = members.filter((u) => !activatedMembers.has(u.id)).map((u) => u.id);
  return g;
}

// --- The access list ---

function lastUse(ctx, keys) {
  let best = null;
  for (const h of ctx.histories) for (const k of keys) {
    const t = h.last.get(k);
    if (t && (!best || t > best)) best = t;
  }
  return best;
}
const historyReaches = (ctx, t) => ctx.histories.length > 0 && Math.min(...ctx.histories.map((h) => h.oldest)) <= t;

function personOf(ctx, id) {
  const u = ctx.people.get(id);
  if (u) return { personId: id, kind: "user", name: u.displayName || u.userPrincipalName || id, upn: u.userPrincipalName || "", guest: isGuest(u), disabled: u.accountEnabled === false };
  const g = ctx.groupInfo.get(id);
  if (g) return { personId: id, kind: "group", name: g.displayName || id, upn: "", guest: false, disabled: false };
  const a = ctx.apps.get(id);
  if (a) return { personId: id, kind: "app", name: a.displayName || id, upn: "", guest: false, disabled: false };
  const k = ctx.known.get(id);
  return { personId: id, kind: k ? (k.type.includes("serviceprincipal") ? "app" : k.type.includes("group") ? "group" : "user") : "unknown", name: (k && k.name) || id, upn: (k && k.upn) || "", guest: false, disabled: false };
}

// One row per person, role, scope and way in.
function buildRows(grants, groups, ctx) {
  const rows = [];
  const add = (g, person, extra) => {
    const via = extra.via;
    const row = {
      id: `${person.personId}|${g.roleKey}|${g.scope.toLowerCase()}|${via}|${extra.groupId || ""}|${extra.state}`,
      ...person, plane: g.plane, role: g.role, roleKey: g.roleKey, privileged: g.privileged, scope: g.scope, scopeText: g.scopeText,
      subscriptionId: g.subscriptionId, resourceGroup: g.resourceGroup, ...extra,
    };
    const keys = via === "direct" || via === "group" ? g.roleIds.map((r) => `${via === "direct" ? person.personId : extra.groupId}|${g.plane}|${r}`) : [`${person.personId}|group|${extra.groupId}|${extra.access || "member"}`];
    const t = lastUse(ctx, keys);
    if (t) row.lastActivated = new Date(t).toISOString();
    rows.push(row);
  };
  for (const g of grants) {
    const p = personOf(ctx, g.principalId);
    if (p.kind !== "group") {
      if (g.state === "assigned" && !g.end) continue; // standing: not PIM access
      add(g, p, { via: "direct", state: g.state === "assigned" ? "time-bound" : g.state, start: g.start, end: g.end });
      continue;
    }
    const grp = groups.get(g.principalId);
    if (!grp) continue;
    const groupName = p.name;
    if (g.state === "eligible") {
      // The group is eligible for the role: its members may activate it.
      for (const id of grp.permanent) add(g, personOf(ctx, id), { via: "group", group: groupName, groupId: grp.id, state: "eligible", start: g.start, end: g.end });
    }
    // PIM for Groups: eligible members activate the membership, and with it the group's role.
    for (const e of grp.eligible) {
      const person = personOf(ctx, e.principalId);
      add(g, person, {
        via: e.access === "owner" ? "pim-group-owner" : "pim-group", group: groupName, groupId: grp.id, access: e.access,
        state: g.state === "eligible" ? "eligible-2-steps" : "eligible", start: earliest(e.start, g.start), end: earliest(e.end, g.end),
      });
    }
    for (const a of grp.activated.filter((x) => x.access === "member")) {
      add(g, personOf(ctx, a.principalId), { via: "pim-group", group: groupName, groupId: grp.id, access: "member", state: g.state === "eligible" ? "eligible" : "active", end: earliest(a.end, g.end) });
    }
  }
  return rows;
}

// --- Findings from the access list ---

function peopleFindings(rows, ctx) {
  const out = [];
  const soonDays = numberSetting("PIM_EXPIRY_WARN_DAYS", 14, { min: 1, max: 90 });
  const unusedDays = numberSetting("PIM_UNUSED_DAYS", 90, { min: 14, max: 730 });
  const now = Date.now();
  const windowStart = now - unusedDays * DAY;
  for (const r of rows) {
    if (!r.privileged || r.kind !== "user" || r.state === "active") continue;
    const how = r.via === "direct" ? "" : r.via === "group" ? ` through group ${r.group}` : ` through PIM for Groups (${r.access === "owner" ? "owner" : "member"} of ${r.group})`;
    const what = `${r.role} (${r.scopeText})${how}`;
    const base = { name: r.upn || r.name, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId, principalId: r.personId };
    if (r.guest) out.push({ ...base, kind: "pim-eligible-guest", id: `${TOOL_ID}/${r.id}#guest`, detail: `Guest account can activate ${what}. A guest's own organisation controls its sign-in and MFA` });
    if (r.disabled) {
      out.push({ ...base, kind: "pim-eligible-disabled", id: `${TOOL_ID}/${r.id}#disabled`, detail: `Disabled account can still activate ${what}; remove the access` });
      continue;
    }
    if (!r.end) {
      out.push({ ...base, kind: "pim-eligible-no-end", id: `${TOOL_ID}/${r.id}#no-end`, detail: `Can activate ${what} with no end date. Set an end date so the need is checked again` });
    } else {
      const left = daysUntil(r.end, now);
      if (left >= 0 && left <= soonDays) out.push({ ...base, kind: "pim-eligible-expiring", id: `${TOOL_ID}/${r.id}#expiring`, detail: `Access to ${what} ends in ${left} day${left === 1 ? "" : "s"} (${r.end.slice(0, 10)}). Extend it if it is still needed` });
    }
    // Unused: access older than the window and no activation in a history that reaches back that far.
    // Not judged for role eligibility through a group: members' activations are not tied to the group in the history.
    const since = Date.parse(r.start);
    if (r.via !== "group" && Number.isFinite(since) && since < windowStart && historyReaches(ctx, windowStart)) {
      const last = r.lastActivated ? Date.parse(r.lastActivated) : null;
      if (!last || last < windowStart) {
        out.push({ ...base, kind: "pim-eligible-unused", id: `${TOOL_ID}/${r.id}#unused`, detail: `Can activate ${what} but has not done so in ${unusedDays} days${last ? ` (last ${r.lastActivated.slice(0, 10)})` : ""}. Remove the access if it is not needed` });
      }
    }
  }
  return out;
}

// Groups that give PIM access to a privileged role: who can add members, and who skips PIM.
function groupFindings(grants, groups, ctx) {
  const out = [];
  const byGroup = new Map();
  for (const g of grants) if (g.privileged && groups.has(g.principalId)) {
    if (!byGroup.has(g.principalId)) byGroup.set(g.principalId, []);
    byGroup.get(g.principalId).push(g);
  }
  for (const [id, list] of byGroup) {
    const grp = groups.get(id);
    const info = ctx.groupInfo.get(id) || {};
    const name = info.displayName || id;
    const pimViaMembership = grp.eligible.length > 0;
    const pimViaRole = list.some((g) => g.state === "eligible");
    if (!pimViaMembership && !pimViaRole) continue;
    const roles = [...new Set(list.map((g) => `${g.role} (${g.scopeText})`))];
    const roleText = roles.slice(0, 3).join(", ") + (roles.length > 3 ? ` and ${roles.length - 3} more` : "");
    const sub = list.find((g) => g.subscriptionId);
    const base = { name, resourceGroup: null, subscriptionId: sub ? sub.subscriptionId : null, principalId: id };
    if (info.isAssignableToRole === false) {
      out.push({ ...base, kind: "pim-group-not-role-assignable", id: `${TOOL_ID}/group/${id}#not-role-assignable`, detail: `Group gives PIM access to ${roleText} but is not role-assignable: its ${grp.owners.length} owner(s) and anyone with a Groups or User Administrator role can add members and skip PIM. Use a role-assignable group` });
    }
    const standing = list.filter((g) => g.state === "assigned" && !g.end);
    if (pimViaMembership && standing.length && grp.permanent.length) {
      const names = grp.permanent.slice(0, MAX_NAMED).map((u) => personOf(ctx, u).upn || personOf(ctx, u).name);
      out.push({ ...base, kind: "pim-group-permanent-member", id: `${TOOL_ID}/group/${id}#permanent`, detail: `Group holds ${roleText} and people activate its membership through PIM, but ${grp.permanent.length} member(s) are in it permanently and skip activation: ${names.join(", ")}${grp.permanent.length > MAX_NAMED ? " …" : ""}` });
    }
  }
  return out;
}

// --- Run ---

async function run() {
  const ctx = { findings: [], notes: [], histories: [], people: new Map(), groupInfo: new Map(), apps: new Map(), known: new Map() };
  const grants = [];
  const failed = await runChecks(TOOL_ID, {
    "Entra roles": async () => { grants.push(...(await entraGrants(ctx))); return []; },
    "Azure roles": async () => { grants.push(...(await azureGrants(ctx))); return []; },
  });
  ctx.findings.push(...failed);

  // Who the principals are, then the groups that hold a role: members and PIM for Groups.
  const groups = new Map();
  try {
    await lookUp(grants.map((g) => g.principalId), ctx);
    const groupIds = [...new Set(grants.filter((g) => personOf(ctx, g.principalId).kind === "group").map((g) => g.principalId))];
    // Groups with a privileged or eligible role first, in case the cap cuts the list.
    groupIds.sort((a, b) => Number(grants.some((g) => g.principalId === b && (g.privileged || g.state === "eligible"))) - Number(grants.some((g) => g.principalId === a && (g.privileged || g.state === "eligible"))));
    const checked = groupIds.slice(0, MAX_GROUPS);
    let refused = null;
    const failures = await mapLimit(checked, 4, async (id) => {
      try {
        groups.set(id, await readGroup(id, ctx));
      } catch (err) {
        if (/PrivilegedEligibilitySchedule/.test(String(err.message))) refused = err;
        throw err;
      }
    });
    if (refused) ctx.findings.push(scanError(TOOL_ID, "pim-groups", "PIM for Groups not checked", refused.message));
    else ctx.findings.push(...itemErrors(TOOL_ID, "groups", "groups with roles checked for members", failures, checked.length));
    if (groupIds.length > MAX_GROUPS) ctx.notes.push(`Only the first ${MAX_GROUPS} of ${groupIds.length} groups holding roles were checked for members.`);
    await lookUp([...groups.values()].flatMap((g) => [...g.eligible, ...g.activated].map((e) => e.principalId)), ctx);
  } catch (err) {
    ctx.findings.push(scanError(TOOL_ID, "people", "People and groups not looked up", graphHint(err, "User.Read.All and GroupMember.Read.All")));
  }

  const rows = buildRows(grants, groups, ctx);
  for (const f of ctx.findings) if (f.kind === "pim-azure-standing") {
    const p = personOf(ctx, f.principalId);
    f.name = p.upn || p.name;
  }
  const findings = [...ctx.findings, ...peopleFindings(rows, ctx), ...groupFindings(grants, groups, ctx)];

  const groupRows = [...groups.values()].map((g) => {
    const info = ctx.groupInfo.get(g.id) || {};
    const held = grants.filter((x) => x.principalId === g.id);
    const sub = held.find((x) => x.subscriptionId);
    return {
      id: g.id, name: info.displayName || g.id, roleAssignable: info.isAssignableToRole === true, pimManaged: g.pim,
      roles: held.map((x) => ({ role: x.role, scopeText: x.scopeText, state: x.state, end: x.end, privileged: x.privileged, plane: x.plane })),
      owners: g.owners, permanent: g.permanent.length, eligible: g.eligible.filter((e) => e.access === "member").length,
      eligibleOwners: g.eligible.filter((e) => e.access === "owner").length, activeNow: g.activated.length,
      subscriptionId: sub ? sub.subscriptionId : null,
    };
  }).filter((g) => g.eligible || g.eligibleOwners || g.activeNow || g.roles.some((r) => r.state === "eligible"));

  await store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), rows, groups: groupRows, notes: ctx.notes });
  return findings;
}

// Each tenant's access list from its last scan.
async function inventory(keys) {
  const out = { updatedAt: null, rows: [], groups: [], notes: [], failures: [] };
  for (const k of keys) {
    let doc;
    try {
      doc = await store.getDoc(INVENTORY_KEY, k);
    } catch (err) {
      out.failures.push({ tenant: k, error: `could not read the PIM access list: ${err.message}` });
      continue;
    }
    if (!doc) continue;
    if (doc.updatedAt && (!out.updatedAt || doc.updatedAt > out.updatedAt)) out.updatedAt = doc.updatedAt;
    const tag = (x) => ({ ...x, ...(k !== tenants.HOME && { tenant: k }) });
    out.rows.push(...(doc.rows || []).map(tag));
    out.groups.push(...(doc.groups || []).map(tag));
    out.notes.push(...(doc.notes || []));
  }
  return out;
}

function registerRoutes(app, { readKeys, decorate }) {
  app.get("/api/pim", async (req, res) => {
    try {
      const inv = await inventory(readKeys(req));
      await decorate(TOOL_ID, [...inv.rows, ...inv.groups]);
      res.json(inv);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  id: TOOL_ID,
  label: "PIM",
  schedule: "10 5 * * *", // daily at 05:10
  run,
  registerRoutes,
  _test: { policyProblems, buildRows, peopleFindings, groupFindings, groupHistoryRefused, hours },
};
