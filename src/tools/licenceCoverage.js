// How many Entra licences the features in use actually need, against how many
// the tenant owns. Microsoft counts licences per user who benefits, not per
// feature switched on: one P2 licence does not cover 50 people using PIM or
// access packages. Counted (member users, enabled):
//   P1: users in scope of an enabled Conditional Access policy.
//   P2: users in scope of a risk-based policy; users with eligible or
//       time-bound PIM assignments (Entra roles, Azure roles, PIM for Groups);
//       users with an access package (P2 covers the basic features).
//   ID Governance: access packages that use Governance-only features
//       (auto-assignment policies, custom extensions).
// Guests are billed per monthly active user instead and are reported apart.
// Graph: LicenseAssignment.Read.All (licences owned), User.Read.All,
// GroupMember.Read.All, Policy.Read.All, RoleManagement.Read.Directory,
// EntitlementManagement.Read.All, PrivilegedEligibilitySchedule.Read.AzureADGroup
// and PrivilegedAssignmentSchedule.Read.AzureADGroup (PIM for Groups). Azure
// role PIM is read with Reader.
const { graphGet, graphGetAll } = require("../graphClient");
const { armGet, subscriptionIdsToScan } = require("../armClient");
const { numberSetting, mapLimit, scanError, itemErrors, graphHint } = require("./util");

const TOOL_ID = "licence-coverage";
const TENANT = { resourceGroup: null, subscriptionId: null };
const MAX_USER_FINDINGS = 200; // per-user lines listed per licence that runs short

// Service plans (names from Microsoft's licensing reference), and the plans that
// satisfy each tier. Products such as Microsoft 365 E5 or Entra Suite carry the
// same plans, so they count too.
const PLAN = { P1: "AAD_PREMIUM", P2: "AAD_PREMIUM_P2", GOV: "ENTRA_IDENTITY_GOVERNANCE" };
const PLAN_IDS = {
  "41781fb2-bc02-4b7c-bd55-b576c07bb09d": PLAN.P1,
  "eec0eb4f-6444-4f95-aba0-50c24d67f998": PLAN.P2,
  "e866a266-3cff-43a3-acca-0c90a7e00c8b": PLAN.GOV,
};
const TIERS = [
  { key: "p1", label: "Microsoft Entra ID P1", plans: [PLAN.P1, PLAN.P2] },
  { key: "p2", label: "Microsoft Entra ID P2", plans: [PLAN.P2, PLAN.GOV] },
  { key: "gov", label: "Microsoft Entra ID Governance", plans: [PLAN.GOV] },
];

const arr = (x) => (Array.isArray(x) ? x : []);
const planName = (name) => String(name || "").toUpperCase();

/* ---------- licences owned ---------- */

// Units per tier from subscribedSkus; a SKU counts once per tier however many
// matching plans it has. Suspended and deleted SKUs no longer cover anyone.
function ownedLicences(skus) {
  const owned = { p1: 0, p2: 0, gov: 0 };
  const products = { p1: [], p2: [], gov: [] };
  const planIds = new Map(Object.entries(PLAN_IDS));
  for (const s of skus) {
    if (s.appliesTo && s.appliesTo !== "User") continue;
    if (!["Enabled", "Warning"].includes(s.capabilityStatus)) continue;
    const plans = new Set();
    for (const p of arr(s.servicePlans)) {
      const name = planName(p.servicePlanName);
      if (Object.values(PLAN).includes(name)) {
        plans.add(name);
        planIds.set(p.servicePlanId, name);
      }
    }
    const units = Number((s.prepaidUnits || {}).enabled || 0) + Number((s.prepaidUnits || {}).warning || 0);
    for (const t of TIERS) {
      if (!t.plans.some((p) => plans.has(p))) continue;
      owned[t.key] += units;
      products[t.key].push(`${s.skuPartNumber || s.skuId} ${units}`);
    }
  }
  return { owned, products, planIds };
}

// The tier plans a user has assigned and enabled.
function userPlans(user, planIds) {
  const out = new Set();
  for (const p of arr(user.assignedPlans)) {
    if (p.capabilityStatus !== "Enabled") continue;
    const name = planIds.get(p.servicePlanId);
    if (name) out.add(name);
  }
  return out;
}

/* ---------- who needs what ---------- */

class Needs {
  constructor() {
    this.byTier = { p1: new Map(), p2: new Map(), gov: new Map() }; // tier -> user id -> Set(reason)
  }
  add(tier, ids, reason) {
    for (const id of ids) {
      const m = this.byTier[tier];
      if (!m.has(id)) m.set(id, new Set());
      m.get(id).add(reason);
    }
  }
}

// Turns principal ids (users, groups, apps) into user ids; group members are
// read transitively and cached for the run.
function makeResolver(users, errors) {
  const cache = new Map();
  const groupUsers = (id) => {
    if (!cache.has(id)) {
      cache.set(id, graphGetAll(`/groups/${id}/transitiveMembers/microsoft.graph.user?$select=id&$top=999`, TOOL_ID)
        .then((rows) => rows.map((r) => r.id))
        .catch((err) => {
          // Not a group (an app, or deleted): nobody to count.
          if (!/\(404\)|Request_ResourceNotFound/i.test(String(err && err.message))) errors.push({ item: { id }, message: String(err.message || err).slice(0, 300) });
          return [];
        }));
    }
    return cache.get(id);
  };
  return async (ids) => {
    const out = new Set();
    for (const id of ids) {
      if (users.has(id)) out.add(id);
      else (await groupUsers(id)).forEach((u) => out.add(u));
    }
    return out;
  };
}

const isRiskPolicy = (p) => {
  const c = p.conditions || {};
  return arr(c.userRiskLevels).length > 0 || arr(c.signInRiskLevels).length > 0 || arr(c.servicePrincipalRiskLevels).length > 0;
};

async function conditionalAccess(needs, ctx) {
  let policies;
  try {
    policies = await graphGetAll("/identity/conditionalAccess/policies", TOOL_ID);
  } catch (err) {
    // No P1 in the tenant: no Conditional Access, so nothing needs it.
    if (/RequestFromNonPremiumTenant|NonPremium|premium license/i.test(String(err && err.message))) return [];
    throw new Error(graphHint(err, "Policy.Read.All"));
  }
  const roleMembers = async (templates) => {
    const ids = ctx.roleAssignments.filter((a) => templates.includes(a.roleDefinitionId)).map((a) => a.principalId);
    return ctx.resolve(ids);
  };
  for (const p of policies.filter((x) => x.state === "enabled")) {
    const u = (p.conditions && p.conditions.users) || {};
    const included = arr(u.includeUsers).includes("All")
      ? new Set(ctx.users.keys())
      : new Set([...(await ctx.resolve(arr(u.includeUsers).filter((x) => x !== "None" && x !== "GuestsOrExternalUsers"))), ...(await ctx.resolve(arr(u.includeGroups))), ...(await roleMembers(arr(u.includeRoles)))]);
    const excluded = new Set([...(await ctx.resolve(arr(u.excludeUsers).filter((x) => x !== "GuestsOrExternalUsers"))), ...(await ctx.resolve(arr(u.excludeGroups))), ...(await roleMembers(arr(u.excludeRoles)))]);
    const scope = [...included].filter((id) => !excluded.has(id));
    if (isRiskPolicy(p)) needs.add("p2", scope, "risk-based Conditional Access");
    else needs.add("p1", scope, "Conditional Access");
  }
  return [];
}

// Eligible, or active with an end date (time-bound): both need P2.
const timeBound = (a) => a.endDateTime && a.assignmentType !== "Activated";

async function pimEntraRoles(needs, ctx) {
  let eligible, active;
  try {
    [eligible, active] = await Promise.all([
      graphGetAll("/roleManagement/directory/roleEligibilityScheduleInstances?$select=principalId", TOOL_ID),
      graphGetAll("/roleManagement/directory/roleAssignmentScheduleInstances?$select=principalId,assignmentType,endDateTime", TOOL_ID),
    ]);
  } catch (err) {
    if (/RequestFromNonPremiumTenant|NonPremium|premium license|AadPremiumLicenseRequired/i.test(String(err && err.message))) return [];
    throw new Error(graphHint(err, "RoleManagement.Read.Directory"));
  }
  const ids = [...eligible.map((e) => e.principalId), ...active.filter(timeBound).map((a) => a.principalId)];
  needs.add("p2", await ctx.resolve(ids), "PIM for Entra roles");
  return [];
}

async function pimGroups(needs, ctx) {
  const max = numberSetting("LICENCE_MAX_PIM_GROUPS", 1000, { min: 0, max: 20000 });
  // PIM for Groups can't manage dynamic groups or groups synced from on-premises; Graph answers 400 for them.
  const groups = (await graphGetAll("/groups?$filter=securityEnabled eq true&$select=id,groupTypes,onPremisesSyncEnabled&$top=999", TOOL_ID))
    .filter((g) => !(g.groupTypes || []).includes("DynamicMembership") && !g.onPremisesSyncEnabled)
    .slice(0, max);
  const ids = [];
  let refused = null, noPremium = false;
  const failures = await mapLimit(groups, 6, async (g) => {
    if (refused || noPremium) return;
    try {
      const [eligible, active] = await Promise.all([
        graphGetAll(`/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances?$filter=groupId eq '${g.id}'&$select=principalId`, TOOL_ID),
        graphGetAll(`/identityGovernance/privilegedAccess/group/assignmentScheduleInstances?$filter=groupId eq '${g.id}'&$select=principalId,assignmentType,endDateTime`, TOOL_ID),
      ]);
      ids.push(...eligible.map((e) => e.principalId), ...active.filter(timeBound).map((a) => a.principalId));
    } catch (err) {
      const msg = String(err && err.message);
      if (/ResourceTypeNotSupported/.test(msg)) return; // a group kind PIM can't manage: nothing to count
      if (/RequestFromNonPremiumTenant|NonPremium|premium license|AadPremiumLicenseRequired/i.test(msg)) noPremium = true;
      else if (/\(403\)|Authorization_RequestDenied|Forbidden/i.test(msg)) refused = err;
      else throw err;
    }
  });
  if (noPremium) return []; // no P2: PIM for Groups is not in use
  if (refused) throw new Error(graphHint(refused, "PrivilegedEligibilitySchedule.Read.AzureADGroup and PrivilegedAssignmentSchedule.Read.AzureADGroup"));
  needs.add("p2", await ctx.resolve(ids), "PIM for Groups");
  return itemErrors(TOOL_ID, "pim-groups", "groups checked for PIM", failures, groups.length);
}

async function pimAzureRoles(needs, ctx) {
  const subs = await subscriptionIdsToScan(TOOL_ID);
  const ids = [];
  const failures = await mapLimit(subs, 6, async (s) => {
    const base = `https://management.azure.com/subscriptions/${s}/providers/Microsoft.Authorization`;
    for (const [kind, keep] of [["roleEligibilityScheduleInstances", () => true], ["roleAssignmentScheduleInstances", (p) => timeBound(p)]]) {
      let url = `${base}/${kind}?api-version=2020-10-01`;
      while (url) {
        const page = await armGet(url, TOOL_ID);
        for (const r of page.value || []) if (keep(r.properties || {})) ids.push((r.properties || {}).principalId);
        url = page.nextLink;
      }
    }
  });
  needs.add("p2", await ctx.resolve(ids.filter(Boolean)), "PIM for Azure roles");
  return itemErrors(TOOL_ID, "pim-azure", "subscriptions checked for PIM", failures.map((f) => ({ ...f, item: { subscriptionId: f.item } })), subs.length);
}

// Auto-assignment policies and custom extensions are Governance-only.
const governanceOnly = (a) => {
  const pol = a.assignmentPolicy || {};
  const auto = pol.automaticRequestSettings;
  return !!(auto && auto.requestAccessForAllowedTargets) || arr(a.customExtensionCalloutInstances).length > 0;
};

async function accessPackages(needs, ctx) {
  let rows;
  try {
    rows = await graphGetAll("/identityGovernance/entitlementManagement/assignments?$filter=state eq 'Delivered'&$expand=target,assignmentPolicy&$top=999", TOOL_ID);
  } catch (err) {
    if (/RequestFromNonPremiumTenant|NonPremium|premium license/i.test(String(err && err.message))) return [];
    throw new Error(graphHint(err, "EntitlementManagement.Read.All"));
  }
  const basic = [], gov = [];
  for (const a of rows) {
    const id = (a.target && a.target.objectId) || a.targetId;
    if (!id) continue;
    (governanceOnly(a) ? gov : basic).push(id);
  }
  needs.add("p2", await ctx.resolve(basic), "access packages");
  needs.add("gov", await ctx.resolve(gov), "access packages with Governance features");
  return [];
}

/* ---------- findings ---------- */

function reasonCounts(map) {
  const n = new Map();
  for (const reasons of map.values()) for (const r of reasons) n.set(r, (n.get(r) || 0) + 1);
  return [...n].sort((a, b) => b[1] - a[1]).map(([r, c]) => `${r} ${c}`).join(", ");
}

function analyse(needs, users, { owned, products, planIds }) {
  const findings = [];
  // A user who needs P2 is covered for P1 by the same licence, so P2 users
  // count toward P1 too.
  const p1 = new Map([...needs.byTier.p1].map(([id, r]) => [id, new Set(r)]));
  for (const [id, r] of needs.byTier.p2) p1.set(id, new Set([...(p1.get(id) || []), ...r]));
  const tierUsers = {
    p1,
    p2: needs.byTier.p2,
    gov: needs.byTier.gov,
  };
  for (const t of TIERS) {
    const all = tierUsers[t.key];
    if (!all.size && !owned[t.key]) continue;
    const members = new Map(), guests = new Map();
    for (const [id, reasons] of all) {
      const u = users.get(id);
      if (!u || u.accountEnabled === false) continue;
      (u.userType === "Guest" ? guests : members).set(id, reasons);
    }
    const need = members.size, have = owned[t.key];
    const ratio = `${need} user${need === 1 ? "" : "s"} / ${have} licence${have === 1 ? "" : "s"}`;
    const why = need ? ` For: ${reasonCounts(members)}.` : "";
    const from = have ? ` Owned: ${products[t.key].join(", ")}.` : "";
    const guestText = guests.size
      ? t.key === "gov"
        ? ` Plus ${guests.size} guest${guests.size === 1 ? "" : "s"}, billed per monthly active guest (needs a linked Azure subscription).`
        : ` Plus ${guests.size} guest${guests.size === 1 ? "" : "s"}, billed per monthly active user.`
      : "";
    const base = { ...TENANT, name: t.label, id: `${TOOL_ID}/${t.key}`, tier: t.key, need, owned: have, guests: guests.size };
    if (need > have) {
      findings.push({ ...base, kind: "licence-short", detail: `${ratio}: ${need - have} short.${why}${from}${guestText}` });
      // Who is behind the shortfall: first those with no licence assigned.
      const list = [...members].map(([id, reasons]) => ({ id, reasons, has: t.plans.some((p) => userPlans(users.get(id), planIds).has(p)) }))
        .filter((x) => !x.has)
        .slice(0, MAX_USER_FINDINGS);
      for (const x of list) {
        const u = users.get(x.id);
        findings.push({ ...TENANT, kind: "licence-user", id: `${x.id}#${t.key}`, name: u.userPrincipalName || u.displayName || x.id, principalId: x.id, detail: `Needs ${t.label} for ${[...x.reasons].join(", ")}; none assigned` });
      }
    } else if (need) {
      findings.push({ ...base, kind: "licence-count", detail: `${ratio}: ${have - need} spare.${why}${from}${guestText}` });
    } else if (guests.size) {
      findings.push({ ...base, kind: "licence-count", detail: `${ratio}.${guestText}` });
    }
    if (t.key === "gov" && guests.size && !have) {
      findings.push({ ...base, kind: "licence-short", id: `${TOOL_ID}/gov-guests`, tier: null, detail: `Guests use Governance-only features, which needs at least one ${t.label} (or Entra Suite) licence in the tenant.` });
    }
  }
  return findings;
}

async function run() {
  let skus;
  try {
    skus = await graphGetAll("/subscribedSkus", TOOL_ID);
  } catch (err) {
    throw new Error(graphHint(err, "LicenseAssignment.Read.All"));
  }
  let userRows;
  try {
    userRows = await graphGetAll("/users?$select=id,displayName,userPrincipalName,userType,accountEnabled,assignedPlans&$top=999", TOOL_ID);
  } catch (err) {
    throw new Error(graphHint(err, "User.Read.All"));
  }
  const users = new Map(userRows.map((u) => [u.id, u]));
  const groupErrors = [];
  let roleAssignments = [];
  try {
    roleAssignments = await graphGetAll("/roleManagement/directory/roleAssignments?$select=principalId,roleDefinitionId", TOOL_ID);
  } catch {
    // Only Conditional Access scoped to roles loses accuracy.
  }
  const ctx = { users, roleAssignments, resolve: makeResolver(users, groupErrors) };
  const needs = new Needs();
  const checks = {
    "Conditional Access": () => conditionalAccess(needs, ctx),
    "PIM for Entra roles": () => pimEntraRoles(needs, ctx),
    "PIM for Groups": () => pimGroups(needs, ctx),
    "PIM for Azure roles": () => pimAzureRoles(needs, ctx),
    "Access packages": () => accessPackages(needs, ctx),
  };
  const names = Object.keys(checks);
  const results = await Promise.allSettled(names.map((n) => checks[n]()));
  const extra = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") extra.push(...(r.value || []));
    else extra.push(scanError(TOOL_ID, names[i].toLowerCase().replace(/\W+/g, "-"), `${names[i]} not counted`, String((r.reason && r.reason.message) || r.reason).slice(0, 300)));
  });
  return [...analyse(needs, users, ownedLicences(skus)), ...extra, ...itemErrors(TOOL_ID, "groups", "groups expanded", groupErrors, groupErrors.length)];
}

module.exports = {
  id: TOOL_ID,
  label: "Licence coverage",
  schedule: "0 6 * * *", // daily at 06:00
  run,
  _test: { analyse, ownedLicences, Needs, isRiskPolicy, governanceOnly, pimGroups },
};
