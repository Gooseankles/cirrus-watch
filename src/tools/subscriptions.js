// Subscriptions themselves: ones placed straight in the tenant root management
// group (policies and access set on child groups never reach them), ones with
// no Owner on the subscription or a management group above it (nobody can
// manage access there without going to the tenant), and ones that are not
// Enabled (billing trouble or switched off), and classic administrators
// (Service Administrator, Co-Administrators) still listed. Role assignment
// limits are in Role assignments, quotas in Quotas. Resource Graph
// (ResourceContainers and AuthorizationResources) and the classic
// administrators list per subscription, so Reader is enough.
const { resourceGraphQuery, armGet } = require("../armClient");
const { runChecks, mapLimit, itemErrors } = require("./util");

const TOOL_ID = "subscriptions";
const CONCURRENCY = 6;
const CLASSIC_API = "2015-07-01";
const OWNER = "8e3af657-a8ff-443c-a75c-2fe8c4bcb635";

const subId = (s) => `/subscriptions/${s.subscriptionId}`;
const base = (s) => ({ id: subId(s), name: s.name || s.subscriptionId, resourceGroup: null, subscriptionId: s.subscriptionId });
const chainNames = (s) => (Array.isArray(s.chain) ? s.chain : []).map((c) => String((c && c.name) || "").toLowerCase()).filter(Boolean);

// subs: [{ subscriptionId, name, state, chain: [{ name, displayName }] }], the chain from the direct parent up to the
// tenant root. Pure, for the tests.
function judgePlacement(subs) {
  const findings = [];
  for (const s of subs) {
    if (!/^(enabled|warned|pastdue)$/i.test(s.state || "")) continue;
    const chain = Array.isArray(s.chain) ? s.chain : [];
    if (chain.length > 1) continue;
    findings.push({
      ...base(s),
      kind: "sub-in-root-mg",
      id: `${subId(s)}#root-mg`,
      detail: chain.length
        ? "Sits directly in the Tenant Root Group, so policies and role assignments set on child management groups do not reach it. Move it into the management group for its workload"
        : "Is not under any management group, so policies and role assignments set on management groups do not reach it. Move it into the management group for its workload",
    });
  }
  return findings;
}

// owners: [{ scope }] for every Owner assignment at a subscription, management group or root scope. Pure, for the tests.
function judgeOwners(subs, owners) {
  const subScopes = new Set();
  const mgScopes = new Set();
  let atRoot = false;
  for (const o of owners) {
    const scope = String(o.scope || "").toLowerCase().replace(/\/+$/, "");
    const sub = scope.match(/^\/subscriptions\/([^/]+)$/);
    const mg = scope.match(/\/providers\/microsoft\.management\/managementgroups\/([^/]+)$/);
    if (sub) subScopes.add(sub[1]);
    else if (mg) mgScopes.add(mg[1]);
    else if (scope === "") atRoot = true;
  }
  if (atRoot) return [];
  return subs
    .filter((s) => /^(enabled|warned|pastdue)$/i.test(s.state || ""))
    .filter((s) => !subScopes.has(String(s.subscriptionId).toLowerCase()) && !chainNames(s).some((m) => mgScopes.has(m)))
    .map((s) => ({
      ...base(s),
      kind: "sub-no-owner",
      id: `${subId(s)}#no-owner`,
      detail: "No active Owner on the subscription or any management group above it (PIM-eligible Owners are not counted), so nobody can grant access here without elevating at the tenant. Assign Owner to an admin group",
    }));
}

// Pure, for the tests.
function judgeState(subs) {
  const findings = [];
  for (const s of subs) {
    const state = String(s.state || "");
    if (/^(warned|pastdue)$/i.test(state)) {
      findings.push({
        ...base(s),
        kind: "sub-state",
        id: `${subId(s)}#state`,
        state,
        detail: `State is ${/warned/i.test(state) ? "Warned" : "PastDue"}: Azure will disable it soon (billing or spending limit). Fix the payment or the limit before resources stop`,
      });
    } else if (/^disabled$/i.test(state)) {
      findings.push({ ...base(s), kind: "sub-disabled", id: `${subId(s)}#state`, state, detail: "Disabled: its resources are stopped and it still clutters the tenant. Cancel and delete it, or re-enable it if it is still needed" });
    }
  }
  return findings;
}

// admins: [{ subscriptionId, name, admins: [{ properties: { emailAddress, role } }] }] for the subscriptions read; refused:
// the subscriptions where the read was refused (403). Every classic administrator is a finding: the classic roles were
// retired on 31 August 2024; from December 2025 Azure gave the remaining Co- and Service Administrators an Owner role
// assignment on the subscription instead (its description names the classic admin retirement), and the classic entry
// itself no longer grants anything. Pure, for the tests.
function judgeClassicAdmins(read, refused = []) {
  const findings = [];
  for (const s of read) {
    for (const a of Array.isArray(s.admins) ? s.admins : []) {
      const p = (a && a.properties) || {};
      const email = String(p.emailAddress || a.name || "?");
      const roles = String(p.role || "").split(";").map((r) => r.trim()).filter(Boolean);
      const what = roles.some((r) => /^serviceadministrator$/i.test(r)) ? "Service Administrator" : roles.some((r) => /^coadministrator$/i.test(r)) ? "Co-Administrator" : roles.join(", ") || "classic administrator";
      findings.push({
        ...base(s),
        kind: "classic-admin",
        id: `${subId(s)}#classic-admin/${email.toLowerCase()}`,
        name: email,
        role: what,
        detail: `${email} is still listed as a classic ${what} on ${s.name || s.subscriptionId}. Classic roles were retired in August 2024, and in December 2025 Azure gave the remaining ones an Owner role assignment on the subscription instead. Check that Owner assignment (Access control, Role assignments) and reduce it to the role the person needs, then remove the classic entry`,
      });
    }
  }
  if (refused.length) {
    findings.push({
      kind: "classic-admin-unread",
      id: `${TOOL_ID}/classic-admins-unread`,
      name: `Classic administrators not read in ${refused.length} subscription${refused.length === 1 ? "" : "s"}`,
      resourceGroup: null,
      subscriptionId: refused[0].subscriptionId,
      detail: `Azure refused the classic administrators list (403) for ${refused.slice(0, 5).map((s) => s.name || s.subscriptionId).join(", ")}${refused.length > 5 ? ` and ${refused.length - 5} more` : ""}. Nothing is known about classic administrators there; Reader on the subscription normally allows it`,
    });
  }
  return findings;
}

async function classicAdmins(subs) {
  const live = subs.filter((s) => /^(enabled|warned|pastdue)$/i.test(s.state || ""));
  const read = [];
  const refused = [];
  const failures = await mapLimit(live, CONCURRENCY, async (s) => {
    try {
      const page = await armGet(`https://management.azure.com/subscriptions/${s.subscriptionId}/providers/Microsoft.Authorization/classicAdministrators?api-version=${CLASSIC_API}`, TOOL_ID);
      read.push({ ...s, admins: page.value || [] });
    } catch (err) {
      const msg = String((err && err.message) || err);
      // 404: the endpoint no longer answers for this subscription (classic roles retired), so nothing is listed.
      if (/\(404\)/.test(msg)) read.push({ ...s, admins: [] });
      else if (/\(403\)|AuthorizationFailed/i.test(msg)) refused.push(s);
      else throw err;
    }
  });
  if (live.length && failures.length === live.length) throw new Error(`every classic administrators list failed, e.g. ${failures[0].message}`);
  return [...judgeClassicAdmins(read, refused), ...itemErrors(TOOL_ID, "classic-admins", "subscriptions' classic administrators", failures, live.length)];
}

async function loadSubs() {
  return resourceGraphQuery(
    `ResourceContainers
    | where type =~ 'microsoft.resources/subscriptions'
    | project subscriptionId, name, state = tostring(properties.state), chain = properties.managementGroupAncestorsChain`,
    { toolId: TOOL_ID }
  );
}

async function run() {
  // One read of the subscriptions shared by the checks; if it fails, every check fails and the run says why.
  const subsP = loadSubs();
  subsP.catch(() => {});
  return runChecks(TOOL_ID, {
    "Management group placement": async () => judgePlacement(await subsP),
    Owners: async () => {
      // Tenant-wide (subscriptions: []) so Owners given on management groups and the root are seen too.
      const owners = await resourceGraphQuery(
        `AuthorizationResources
        | where type =~ 'microsoft.authorization/roleassignments'
        | where tolower(tostring(properties.roleDefinitionId)) endswith '${OWNER}'
        | extend scope = tolower(tostring(properties.scope))
        | where scope == '/' or scope matches regex '^/subscriptions/[^/]+$' or scope contains '/providers/microsoft.management/managementgroups/'
        | project scope`,
        { toolId: TOOL_ID, subscriptions: [] }
      );
      return judgeOwners(await subsP, owners);
    },
    State: async () => judgeState(await subsP),
    "Classic administrators": async () => classicAdmins(await subsP),
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Subscriptions",
  schedule: "35 4 * * *", // daily at 04:35
  run,
  _test: { judgePlacement, judgeOwners, judgeState, judgeClassicAdmins },
};
