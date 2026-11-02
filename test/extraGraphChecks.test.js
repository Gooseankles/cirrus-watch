// The extra Graph checks (risky users, Secure Score, admin units, directory
// sync) and guest owners. Graph is stubbed; no Azure. Covers each tool's pure
// logic and the paths around it: on by default, none = off (no Graph call), a 403 (one
// scan-error finding naming the permission), no Entra ID P2 (an info log line,
// no findings), and a customer tenant never inheriting the home tenant's list.
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const graphClient = require("../src/graphClient");
const log = require("../src/log");

const calls = [];
const logged = [];
let answer = () => ({ value: [] });
log.record = (entry) => logged.push(entry);
// Before the tools are loaded: they take the Graph helpers when required.
graphClient.graphGet = async (url) => { calls.push(["GET", url]); return answer("GET", url); };
graphClient.graphGetAll = async (url) => { calls.push(["ALL", url]); const r = await answer("ALL", url); return Array.isArray(r) ? r : r.value || []; };
graphClient.graphPost = async (url, body) => { calls.push(["POST", url, body]); return answer("POST", url, body); };

const settings = require("../src/settings");
const { runIn } = require("../src/tenantContext");
const extra = require("../src/tools/extraChecks");
const riskyUsers = require("../src/tools/riskyUsers");
const secureScore = require("../src/tools/secureScore");
const adminUnits = require("../src/tools/adminUnits");
const directorySync = require("../src/tools/directorySync");
const guestOwners = require("../src/tools/guestOwners");

after(env.cleanup);
beforeEach(() => {
  calls.length = 0;
  logged.length = 0;
  answer = () => ({ value: [] });
  delete process.env.EXTRA_GRAPH_CHECKS;
});

function graphError(status, body = "{}") {
  return Object.assign(new Error(`Graph GET https://graph.microsoft.com/v1.0/x failed (${status}): ${body}`), { status });
}
const NOW = Date.parse("2026-10-31T12:00:00Z");
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

// ---- on by default, none turns them off ----

test("every extra check is on by default; none turns them off and calls nothing", async () => {
  assert.deepEqual(extra.enabledChecks().sort(), Object.keys(extra.EXTRA_CHECKS).sort());
  process.env.EXTRA_GRAPH_CHECKS = "none";
  assert.deepEqual(extra.enabledChecks(), []);
  for (const tool of [riskyUsers, secureScore, adminUnits, directorySync]) {
    assert.deepEqual(await tool.run(), [], tool.id);
  }
  assert.equal(calls.length, 0);
});

test("EXTRA_GRAPH_CHECKS takes a list or all, ignores unknown ids", () => {
  process.env.EXTRA_GRAPH_CHECKS = "risky-users, nonsense ;directory-sync";
  assert.deepEqual(extra.enabledChecks(), ["risky-users", "directory-sync"]);
  process.env.EXTRA_GRAPH_CHECKS = "ALL";
  assert.deepEqual(extra.enabledChecks().sort(), Object.keys(extra.EXTRA_CHECKS).sort());
});

test("a customer tenant never inherits the home tenant's list", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "none";
  await runIn({ key: "contoso" }, async () => {
    assert.equal(settings.get("EXTRA_GRAPH_CHECKS"), "");
    assert.equal(extra.enabledChecks().length, Object.keys(extra.EXTRA_CHECKS).length, "its own blank = all");
  });
  await settings.setMany({ values: { EXTRA_GRAPH_CHECKS: "directory-sync" } }, "contoso");
  await runIn({ key: "contoso" }, async () => {
    assert.deepEqual(extra.enabledChecks(), ["directory-sync"]);
  });
  const field = settings.getAll("contoso").find((f) => f.key === "EXTRA_GRAPH_CHECKS");
  assert.equal(field.homeValue, "");
});

// ---- risky users ----

test("risky users: compromised and high are critical, medium a warning, the rest skipped", () => {
  const { classify } = riskyUsers._test;
  assert.equal(classify({ riskState: "confirmedCompromised", riskLevel: "high" }), "compromised");
  assert.equal(classify({ riskState: "atRisk", riskLevel: "high" }), "high");
  assert.equal(classify({ riskState: "atRisk", riskLevel: "medium" }), "medium");
  assert.equal(classify({ riskState: "atRisk", riskLevel: "low" }), null);
  assert.equal(classify({ riskState: "remediated", riskLevel: "high" }), null);
  assert.equal(classify({ riskState: "dismissed", riskLevel: "high" }), null);
  assert.equal(classify({ riskState: "atRisk", riskLevel: "high", isDeleted: true }), null);
});

test("risky users: worst then oldest first, capped, duplicates once", () => {
  const { riskyFindings } = riskyUsers._test;
  const users = [
    { id: "m1", riskState: "atRisk", riskLevel: "medium", riskLastUpdatedDateTime: "2026-01-01T00:00:00Z", userPrincipalName: "m1@x" },
    { id: "h2", riskState: "atRisk", riskLevel: "high", riskLastUpdatedDateTime: "2026-10-01T00:00:00Z" },
    { id: "h1", riskState: "atRisk", riskLevel: "high", riskLastUpdatedDateTime: "2026-09-01T00:00:00Z" },
    { id: "c1", riskState: "confirmedCompromised", riskLevel: "high", riskLastUpdatedDateTime: "2026-10-30T00:00:00Z" },
    { id: "c1", riskState: "confirmedCompromised", riskLevel: "high" },
    { id: "l1", riskState: "atRisk", riskLevel: "low" },
  ];
  const { findings, total } = riskyFindings(users, 3, NOW);
  assert.equal(total, 4);
  assert.deepEqual(findings.map((f) => f.principalId), ["c1", "h1", "h2"]);
  assert.deepEqual(findings.map((f) => f.kind), ["risky-user-compromised", "risky-user-high", "risky-user-high"]);
  assert.match(findings[1].detail, /last changed 60 day/);
});

test("risky users: reads both states and logs when capped", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "risky-users";
  process.env.RISKY_USERS_MAX = "1";
  answer = (m, url) => (url.includes("confirmedCompromised")
    ? { value: [{ id: "c1", riskState: "confirmedCompromised", riskLevel: "high" }] }
    : { value: [{ id: "h1", riskState: "atRisk", riskLevel: "high" }] });
  try {
    const out = await riskyUsers.run();
    assert.equal(out.length, 1);
    assert.equal(out[0].kind, "risky-user-compromised");
    assert.equal(calls.length, 2);
    assert.ok(logged.some((l) => l.level === "info" && /2 users at risk/.test(l.message)));
  } finally {
    delete process.env.RISKY_USERS_MAX;
  }
});

test("risky users: no Entra ID P2 is an info log line and no findings", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "risky-users";
  answer = () => { throw graphError(403, '{"error":{"code":"Forbidden","message":"Your tenant is not licensed for this feature."}}'); };
  assert.deepEqual(await riskyUsers.run(), []);
  assert.equal(logged.length, 1);
  assert.equal(logged[0].level, "info");
  assert.match(logged[0].message, /P2/);
});

test("risky users: a 403 is one scan error naming the permission", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "risky-users";
  answer = () => { throw graphError(403, '{"error":{"code":"Authorization_RequestDenied"}}'); };
  const out = await riskyUsers.run();
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "scan-error");
  assert.equal(out[0].id, "risky-users/scan-errors/permission");
  assert.match(out[0].name, /IdentityRiskyUser\.Read\.All/);
  assert.match(out[0].detail, /extra_graph_checks/);
  assert.equal(logged[0].level, "warn");
});

test("risky users: other errors still fail the run", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "risky-users";
  answer = () => { throw graphError(500); };
  await assert.rejects(riskyUsers.run(), /500/);
});

// ---- Secure Score ----

const snap = (date, current, max = 100, controlScores = []) => ({ createdDateTime: `${date}T00:00:00Z`, currentScore: current, maxScore: max, controlScores });

test("secure score: the week-old snapshot is the newest at least six days older", () => {
  const { pickWeek } = secureScore._test;
  const { latest, previous } = pickWeek([snap("2026-10-24", 60), snap("2026-10-31", 50), snap("2026-10-26", 58), snap("2026-10-23", 61), snap("2026-10-30", 52)]);
  assert.equal(latest.createdDateTime.slice(0, 10), "2026-10-31");
  assert.equal(previous.createdDateTime.slice(0, 10), "2026-10-24");
  assert.equal(pickWeek([snap("2026-10-31", 50)]).previous, null);
  assert.deepEqual(pickWeek([]), { latest: null, previous: null });
});

test("secure score: always the current score, a drop only at the threshold", () => {
  const { scoreFindings } = secureScore._test;
  const latest = snap("2026-10-31", 50, 100);
  assert.deepEqual(scoreFindings(latest, snap("2026-10-24", 54), 5).map((f) => f.kind), ["secure-score-current"]);
  const drop = scoreFindings(latest, snap("2026-10-24", 55), 5);
  assert.deepEqual(drop.map((f) => f.kind), ["secure-score-current", "secure-score-drop"]);
  assert.match(drop[1].name, /fell 5 points/);
  assert.equal(scoreFindings(latest, snap("2026-10-24", 90), 0).length, 1, "0 turns the drop finding off");
  assert.equal(scoreFindings(latest, null, 5).length, 1);
  assert.match(scoreFindings(latest, null, 5)[0].name, /50%/);
});

test("secure score: top open controls by points left, skipping done, ignored, third-party and deprecated", () => {
  const { openControls } = secureScore._test;
  const latest = snap("2026-10-31", 50, 100, [
    { controlName: "MFA", score: 2 }, { controlName: "Done", score: 5 }, { controlName: "Ign", score: 0 },
    { controlName: "Third", score: 0 }, { controlName: "Old", score: 0 }, { controlName: "Small", score: 0 },
    ...["A", "B", "C", "D"].map((c) => ({ controlName: c, score: 0 })),
  ]);
  const profiles = [
    { id: "mfa", title: "Require MFA", maxScore: 10, rank: 1, service: "AzureAD" },
    { id: "Done", maxScore: 5 },
    { id: "Ign", maxScore: 9, controlStateUpdates: [{ state: "Default", updatedDateTime: "2026-01-01" }, { state: "Ignored", updatedDateTime: "2026-02-01" }] },
    { id: "Third", maxScore: 9, controlStateUpdates: [{ state: "ThirdParty" }] },
    { id: "Old", maxScore: 9, deprecated: true },
    { id: "NotScored", maxScore: 9 },
    { id: "Small", maxScore: 1 },
    { id: "A", maxScore: 6, rank: 5 }, { id: "B", maxScore: 6, rank: 2 }, { id: "C", maxScore: 4 }, { id: "D", maxScore: 3 },
  ];
  const out = openControls(latest, profiles);
  assert.deepEqual(out.map((f) => f.id.split("/").pop()), ["mfa", "B", "A", "C", "D"]);
  assert.equal(out[0].kind, "secure-score-control-open");
  assert.match(out[0].detail, /^8 of 10 points open \(AzureAD\)/);
});

test("secure score: run reports the score and a 403 names SecurityEvents.Read.All", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "secure-score";
  answer = (m, url) => (url.startsWith("/security/secureScores") ? { value: [snap("2026-10-31", 40), snap("2026-10-24", 50)] } : []);
  const out = await secureScore.run();
  assert.deepEqual(out.map((f) => f.kind), ["secure-score-current", "secure-score-drop"]);
  answer = () => { throw graphError(403); };
  const refused = await secureScore.run();
  assert.equal(refused.length, 1);
  assert.match(refused[0].name, /SecurityEvents\.Read\.All/);
});

test("secure score: no snapshots yet is an info line and no findings", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "secure-score";
  assert.deepEqual(await secureScore.run(), []);
  assert.equal(logged[0].level, "info");
});

// ---- administrative units ----

test("admin units: guest and disabled scoped admins, empty restricted units, nothing else", () => {
  const { auFindings } = adminUnits._test;
  const aus = [
    { id: "au1", displayName: "Oslo", isMemberManagementRestricted: false },
    { id: "au2", displayName: "VIP", isMemberManagementRestricted: true },
    { id: "au3", displayName: "Full", isMemberManagementRestricted: true },
  ];
  const scoped = new Map([["au1", [
    { roleId: "r1", roleMemberInfo: { id: "g1" } },
    { roleId: "r1", roleMemberInfo: { id: "d1" } },
    { roleId: "r1", roleMemberInfo: { id: "ok" } },
    { roleId: "r1", roleMemberInfo: { id: "grp" } },
  ]]]);
  const users = new Map([
    ["g1", { userType: "Guest", userPrincipalName: "g_x#EXT#@t", accountEnabled: true }],
    ["d1", { userType: "Member", userPrincipalName: "d1@t", accountEnabled: false }],
    ["ok", { userType: "Member", userPrincipalName: "ok@t", accountEnabled: true }],
  ]);
  const out = auFindings({ aus, scoped, memberCount: new Map([["au2", 0], ["au3", 4]]), roleNames: new Map([["r1", "User Administrator"]]), users });
  assert.deepEqual(out.map((f) => f.kind).sort(), ["au-restricted-empty", "au-scoped-admin-disabled", "au-scoped-admin-guest"]);
  assert.match(out.find((f) => f.kind === "au-scoped-admin-guest").detail, /User Administrator over the administrative unit Oslo/);
});

test("admin units: run reads units, scoped admins, members of restricted units and the users", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "admin-units";
  answer = (m, url) => {
    if (url.startsWith("/directory/administrativeUnits?")) return [{ id: "au1", displayName: "Oslo" }, { id: "au2", displayName: "VIP", isMemberManagementRestricted: true }];
    if (url.endsWith("au1/scopedRoleMembers")) return [{ roleId: "r1", roleMemberInfo: { id: "g1" } }];
    if (url.endsWith("scopedRoleMembers")) return [];
    if (url.includes("/members/$ref")) return { value: [] };
    if (url.startsWith("/directoryRoles")) return [{ id: "r1", displayName: "Helpdesk Administrator" }];
    if (m === "POST") return { value: [{ id: "g1", userType: "Guest", userPrincipalName: "g@x", accountEnabled: true }] };
    return [];
  };
  const out = await adminUnits.run();
  assert.deepEqual(out.map((f) => f.kind).sort(), ["au-restricted-empty", "au-scoped-admin-guest"]);
  assert.ok(!calls.some((c) => c[1].includes("au1/members")), "unrestricted units' members are not read");
});

test("admin units: a 403 on the list names AdministrativeUnit.Read.All", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "admin-units";
  answer = () => { throw graphError(403); };
  const out = await adminUnits.run();
  assert.equal(out.length, 1);
  assert.match(out[0].name, /AdministrativeUnit\.Read\.All/);
});

// ---- directory sync ----

test("directory sync: cloud-only and fresh syncs are fine, late is a warning, a day is critical", () => {
  const { syncFindings } = directorySync._test;
  assert.deepEqual(syncFindings({ onPremisesSyncEnabled: null }, 3, NOW), []);
  assert.deepEqual(syncFindings({ onPremisesSyncEnabled: false, onPremisesLastSyncDateTime: hoursAgo(500) }, 3, NOW), []);
  assert.deepEqual(syncFindings({ onPremisesSyncEnabled: true, onPremisesLastSyncDateTime: hoursAgo(2) }, 3, NOW), []);
  const late = syncFindings({ id: "o", onPremisesSyncEnabled: true, onPremisesLastSyncDateTime: hoursAgo(5) }, 3, NOW);
  assert.equal(late[0].kind, "directory-sync-stale");
  assert.match(late[0].detail, /5 hours ago/);
  assert.equal(syncFindings({ onPremisesSyncEnabled: true, onPremisesLastSyncDateTime: hoursAgo(30) }, 3, NOW)[0].kind, "directory-sync-stopped");
  assert.match(syncFindings({ onPremisesSyncEnabled: true, onPremisesLastSyncDateTime: hoursAgo(72) }, 3, NOW)[0].detail, /3 days ago/);
  assert.equal(syncFindings({ onPremisesSyncEnabled: true, onPremisesLastSyncDateTime: null }, 3, NOW)[0].kind, "directory-sync-stale");
  assert.deepEqual(syncFindings({ onPremisesSyncEnabled: true, onPremisesLastSyncDateTime: hoursAgo(5) }, 6, NOW), []);
});

test("directory sync: basic properties only (no Organization.Read.All) is a permission finding", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "directory-sync";
  answer = () => ({ value: [{ id: "o", displayName: "Contoso", createdDateTime: null, onPremisesSyncEnabled: null }] });
  const out = await directorySync.run();
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "scan-error");
  assert.match(out[0].name, /Organization\.Read\.All/);
});

test("directory sync: run uses DIRECTORY_SYNC_MAX_HOURS", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "directory-sync";
  process.env.DIRECTORY_SYNC_MAX_HOURS = "12";
  const last = new Date(Date.now() - 5 * 3600000).toISOString();
  answer = () => ({ value: [{ id: "o", displayName: "Contoso", createdDateTime: "2020-01-01T00:00:00Z", onPremisesSyncEnabled: true, onPremisesLastSyncDateTime: last }] });
  try {
    assert.deepEqual(await directorySync.run(), []);
    delete process.env.DIRECTORY_SYNC_MAX_HOURS;
    assert.equal((await directorySync.run())[0].kind, "directory-sync-stale");
  } finally {
    delete process.env.DIRECTORY_SYNC_MAX_HOURS;
  }
});

// ---- guest owners ----

test("guest owners: a guest owner is a warning, critical on a role-assignable group", () => {
  const { guestOwnerFindings, isGuest } = guestOwners._test;
  assert.ok(isGuest({ userType: "Guest" }));
  assert.ok(!isGuest({ userType: "Member", userPrincipalName: "a_b.com#EXT#@t.onmicrosoft.com" }), "a guest turned Member is not a guest");
  assert.ok(!isGuest({ userType: "Member", userPrincipalName: "a@t" }));
  const out = guestOwnerFindings([
    { id: "g1", displayName: "Sales", owners: [{ id: "u1", userType: "Guest" }, { id: "u2", userType: "Member" }] },
    { id: "g2", displayName: "Admins", isAssignableToRole: true, owners: [{ id: "u1", userType: "Guest" }] },
    { id: "g3", displayName: "Fine", owners: [{ id: "u2", userType: "Member" }, { id: "sp", "@odata.type": "#microsoft.graph.servicePrincipal" }] },
  ]);
  assert.deepEqual(out.map((f) => [f.kind, f.id]), [["guest-owner", "guest-owners/g1/u1"], ["guest-owner-role-group", "guest-owners/g2/u1"]]);
  assert.match(out[1].detail, /no member owner/);
  assert.doesNotMatch(out[0].detail, /no member owner/);
});

test("guest owners: runs without the extra checks, re-reads groups with 20 owners in the expand", async () => {
  const twenty = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, userType: "Member" }));
  answer = (m, url) => {
    if (url.startsWith("/groups?")) return [{ id: "big", displayName: "Big", owners: twenty }, { id: "small", owners: [] }];
    if (url === "/groups/big/owners") return [...twenty, { id: "x1" }];
    if (m === "POST") return { value: [...twenty, { id: "x1", userType: "Guest", userPrincipalName: "x1#EXT#@t" }] };
    return [];
  };
  const out = await guestOwners.run();
  assert.deepEqual(out.map((f) => f.id), ["guest-owners/big/x1"]);
  assert.ok(calls.some((c) => c[0] === "POST" && c[2].ids.length === 21));
  assert.ok(!calls.some((c) => c[1] === "/groups/small/owners"));
});

test("guest owners: a refusal names GroupMember.Read.All", async () => {
  answer = () => { throw graphError(403); };
  await assert.rejects(guestOwners.run(), /GroupMember\.Read\.All/);
});
