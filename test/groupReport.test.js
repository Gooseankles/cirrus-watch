// Access lookup, group report: every section is read on its own and a refused or failed read becomes a note in that
// section, never an error for the whole report. Graph and Resource Graph are stubbed; no Azure.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const graph = require("../src/graphClient");
const arm = require("../src/armClient");
const { groupReport, _test } = require("../src/tools/groupReport");

after(env.cleanup);

const G = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";
const refused = (url) => Object.assign(new Error(`Graph GET ${url} failed (403): {"error":{"code":"Authorization_RequestDenied","message":"Insufficient privileges to complete the operation."}}`), { status: 403 });

// A tenant where the identity has the default permissions only: no Policy.Read.All here, no Intune, no Sites.
function stubDefaultTenant() {
  const pages = {
    [`/groups/${G}/transitiveMemberOf`]: [{ "@odata.type": "#microsoft.graph.group", id: PARENT, displayName: "All staff" }],
    [`/groups/${G}/owners`]: [{ "@odata.type": "#microsoft.graph.user", id: "o1", displayName: "Eve", userType: "Guest", accountEnabled: true }],
    [`/groups/${G}/members/microsoft.graph.group`]: [{ id: CHILD, displayName: "Team A" }],
    [`/groups/${CHILD}/members/microsoft.graph.group`]: [],
    [`/groups/${G}/appRoleAssignments`]: [{ resourceId: "sp1", resourceDisplayName: "Payroll", appRoleId: "00000000-0000-0000-0000-000000000000" }],
    [`/groups/${G}/membersWithLicenseErrors`]: [],
    "/roleManagement/directory/roleAssignments": [],
    "/identityGovernance/entitlementManagement/accessPackages": [
      { displayName: "Finance access", resourceRoleScopes: [{ role: { displayName: "Member" }, scope: { originId: G } }, { role: { displayName: "Member" }, scope: { originId: "other" } }] },
    ],
    "/identityGovernance/privilegedAccess/group/eligibilityScheduleInstances": [],
  };
  const refusedPaths = ["/identity/conditionalAccess", "/deviceManagement", "/deviceAppManagement", "/sites/root", "/accessReviews", "microsoft.graph.administrativeUnit"];
  graph.graphGetAll = async (url) => {
    if (refusedPaths.some((p) => url.includes(p))) throw refused(url);
    const key = Object.keys(pages).find((k) => url.split("?")[0] === k || url.split("?")[0].endsWith(k));
    if (!key) throw new Error(`unexpected GET ${url}`);
    return pages[key];
  };
  graph.graphGet = async (url) => {
    if (refusedPaths.some((p) => url.includes(p))) throw refused(url);
    if (url.startsWith(`/groups/${G}?`)) return { id: G, displayName: "Finance", groupTypes: ["Unified"], securityEnabled: false, mailEnabled: true, mail: "finance@x.no", proxyAddresses: ["SMTP:finance@x.no", "smtp:fin@x.no"], resourceProvisioningOptions: ["Team"], assignedLicenses: [] };
    if (url.startsWith(`/groups/${G}/transitiveMembers`)) return { value: [{ "@odata.type": "#microsoft.graph.user", userType: "Member" }, { "@odata.type": "#microsoft.graph.user", userType: "Guest", accountEnabled: false }, { "@odata.type": "#microsoft.graph.group" }] };
    if (url.startsWith("/servicePrincipals/sp1")) return { id: "sp1", displayName: "Payroll", appRoles: [], appRoleAssignmentRequired: true };
    throw new Error(`unexpected GET ${url}`);
  };
  graph.graphPost = async () => ({ value: [] });
  arm.resourceGraphQuery = async () => [];
  arm.subscriptionNames = async () => new Map();
}

test("missing permissions give a note in their own section and the rest of the report still shows", async () => {
  stubDefaultTenant();
  const r = await groupReport(G);
  // Refused: each says why, and names the permission.
  assert.equal(r.conditionalAccess.ok, false);
  assert.match(r.conditionalAccess.note, /^Could not get this info: .*Policy\.Read\.All/);
  assert.equal(r.intune.ok, false);
  assert.match(r.intune.note, /^Could not get this info\. /);
  assert.match(r.intune.note, /DeviceManagementApps\.Read\.All/);
  assert.equal(r.site.ok, false);
  assert.match(r.site.note, /Sites\.Read\.All/);
  assert.equal(r.accessReviews.ok, false);
  assert.match(r.accessReviews.note, /AccessReview\.Read\.All/);
  // Partly refused: the section shows, with a note for the part.
  assert.equal(r.control.ok, true);
  assert.match(r.control.notes[0], /Administrative units: could not get this info/);
  // Read: the rest.
  assert.equal(r.details.kind, "Microsoft 365");
  assert.deepEqual(r.details.mail.aliases, ["fin@x.no"]);
  assert.equal(r.details.team, true);
  assert.equal(r.owners.guestOwners, 1);
  assert.deepEqual(r.members.counts.users, 2);
  assert.equal(r.members.counts.guests, 1);
  assert.equal(r.members.counts.disabled, 1);
  assert.deepEqual(r.members.tree, [{ name: "Team A", depth: 1 }]);
  assert.deepEqual(r.apps.apps.map((a) => [a.app, a.role, a.assignmentRequired]), [["Payroll", "Default access", true]]);
  assert.deepEqual(r.accessPackages.packages, [{ package: "Finance access", role: "Member" }]);
  assert.equal(r.keyVaults.ok, true);
  assert.equal(r.parents, 1);
});

test("a failing parent-group read still gives a report, matched on the group only", async () => {
  stubDefaultTenant();
  const getAll = graph.graphGetAll;
  graph.graphGetAll = async (url) => (url.includes("transitiveMemberOf") ? Promise.reject(new Error("Graph GET x failed (500): {}")) : getAll(url));
  const r = await groupReport(G);
  assert.match(r.parentsNote, /only the group itself is matched/);
  assert.equal(r.owners.ok, true);
});

test("Conditional Access: exclusions first, through a parent group, and policies for all users are counted", () => {
  const ids = new Set([G, PARENT]);
  const names = new Map([[G, "This group"], [PARENT, "All staff"]]);
  const policies = [
    { displayName: "B require MFA", state: "enabled", conditions: { users: { includeGroups: [PARENT] }, applications: { includeApplications: ["All"] } }, grantControls: { operator: "OR", builtInControls: ["mfa"] } },
    { displayName: "A break glass", state: "enabled", conditions: { users: { includeUsers: ["All"], excludeGroups: [G] }, applications: { includeApplications: ["app1", "app2"] } }, grantControls: { builtInControls: ["block"] } },
    { displayName: "C all users", state: "enabled", conditions: { users: { includeUsers: ["All"] }, applications: { includeApplications: ["All"] } }, grantControls: { builtInControls: ["mfa"] } },
    { displayName: "D off", state: "disabled", conditions: { users: { includeUsers: ["All"] }, applications: {} } },
    { displayName: "E other group", state: "enabled", conditions: { users: { includeGroups: ["zzz"] }, applications: {} } },
  ];
  const r = _test.caFindings(policies, ids, names);
  assert.deepEqual(r.policies.map((p) => [p.policy, p.effect, p.via]), [["A break glass", "excluded", "This group"], ["B require MFA", "included", "All staff"]]);
  assert.equal(r.policies[0].apps, "2 app(s)");
  assert.equal(r.policies[1].grant, "mfa");
  assert.equal(r.allUsers, 1);
});

test("the nested tree marks a loop and walks a group met twice only once", async () => {
  const kids = { root: [{ id: "a", name: "A" }, { id: "b", name: "B" }], a: [{ id: "c", name: "C" }], b: [{ id: "c", name: "C" }], c: [{ id: "a", name: "A" }] };
  const reads = [];
  const r = await _test.groupTree("root", async (id) => {
    reads.push(id);
    return kids[id] || [];
  });
  assert.deepEqual(r.tree, [
    { name: "A", depth: 1 },
    { name: "C", depth: 2 },
    { name: "A", depth: 3, loop: true },
    { name: "B", depth: 1 },
    { name: "C", depth: 2, repeated: true },
  ]);
  assert.equal(r.loops, 1);
  assert.equal(r.depth, 3);
  assert.deepEqual(reads, ["root", "a", "c", "b"]);
});

test("Intune rows: include and exclude targets of the group or a parent, other groups left out", () => {
  const ids = new Set([G, PARENT]);
  const names = new Map([[G, "This group"], [PARENT, "All staff"]]);
  const items = [
    { displayName: "Wi-Fi", assignments: [{ target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: PARENT } }, { target: { "@odata.type": "#microsoft.graph.groupAssignmentTarget", groupId: "zzz" } }] },
    { displayName: "Teams app", assignments: [{ intent: "required", target: { "@odata.type": "#microsoft.graph.exclusionGroupAssignmentTarget", groupId: G.toUpperCase() } }] },
    { displayName: "All devices", assignments: [{ target: { "@odata.type": "#microsoft.graph.allDevicesAssignmentTarget" } }] },
  ];
  assert.deepEqual(_test.intuneRows("App", items, ids, names), [
    { kind: "App", name: "Wi-Fi", effect: "included", via: "All staff" },
    { kind: "App", name: "Teams app", effect: "excluded", intent: "required", via: "This group" },
  ]);
});

test("notes: licence, permission and other errors say what is missing", () => {
  assert.match(_test.unavailable(new Error('failed (403): {"error":{"code":"RequestFromNonPremiumTenant"}}'), { permission: "Policy.Read.All", licence: "Microsoft Entra ID P1" }), /needs Microsoft Entra ID P1/);
  assert.match(_test.unavailable(new Error("failed (403): Forbidden"), { permission: "Sites.Read.All" }), /missing Sites\.Read\.All \(Graph application permission/);
  assert.match(_test.unavailable(new Error("failed (403): AuthorizationFailed"), { permission: "Reader on the subscriptions" }), /missing Reader on the subscriptions\.$/);
  assert.equal(_test.unavailable(new Error('Graph GET x failed (500): {"error":{"message":"Boom"}} request-id 1')), "Could not get this info (500: Boom).");
});

test("a section that throws returns ok false and never rejects", async () => {
  const r = await _test.section("x", { permission: "P" }, async () => {
    throw new Error("failed (403)");
  });
  assert.equal(r.ok, false);
  assert.match(r.note, /missing P/);
});
