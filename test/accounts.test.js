// The Accounts scan: one finding per account (stale, never signed in, pending
// invitation, no MFA, weak MFA), the MFA judgement only for accounts in use,
// and the run around it (the account read is fatal, the legacy and risky parts
// are not). Graph is stubbed; no Azure.
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const graphClient = require("../src/graphClient");
const log = require("../src/log");

const calls = [];
const logged = [];
let answer = () => ({ value: [] });
log.record = (entry) => logged.push(entry);
// Before the tool is loaded: it takes the Graph helpers when required.
graphClient.graphGet = async (url) => { calls.push(["GET", url]); return answer("GET", url); };
graphClient.graphGetAll = async (url) => { calls.push(["ALL", url]); const r = await answer("ALL", url); return Array.isArray(r) ? r : r.value || []; };

const accounts = require("../src/tools/accounts");
const { classify, mfaState } = accounts._test;

after(env.cleanup);
beforeEach(() => {
  calls.length = 0;
  logged.length = 0;
  answer = () => ({ value: [] });
  delete process.env.EXTRA_GRAPH_CHECKS;
});

const NOW = Date.parse("2026-11-08T12:00:00Z");
const daysAgo = (d) => new Date(NOW - d * 86400000).toISOString();
const OPTS = { memberDays: 90, guestDays: 60, newDays: 14, now: NOW };
const member = (id, over = {}) => ({ id, userPrincipalName: `${id}@x.com`, userType: "Member", accountEnabled: true, createdDateTime: daysAgo(400), ...over });
const guest = (id, over = {}) => member(id, { userType: "Guest", userPrincipalName: `${id}_y.com#EXT#@x.com`, ...over });
const signedIn = (d) => ({ signInActivity: { lastSuccessfulSignInDateTime: daysAgo(d) } });
const noMfa = (id) => ({ id, isAdmin: false, isMfaRegistered: false, methodsRegistered: [] });
const withMfa = (id, methods = ["microsoftAuthenticatorPush"]) => ({ id, isAdmin: false, isMfaRegistered: true, methodsRegistered: methods });

test("mfaState: none, weak, ok, and nothing for admins or accounts without a report row", () => {
  assert.equal(mfaState(undefined), null);
  assert.equal(mfaState({ id: "a", isAdmin: true, isMfaRegistered: false }), null);
  assert.deepEqual(mfaState(noMfa("u")), { state: "none", methods: [] });
  assert.deepEqual(mfaState({ id: "u", isMfaRegistered: true, methodsRegistered: ["email", "securityQuestion"] }), { state: "none", methods: ["email", "securityQuestion"] });
  assert.deepEqual(mfaState(withMfa("u", ["mobilePhone", "email"])), { state: "weak", methods: ["mobilePhone"] });
  assert.equal(mfaState(withMfa("u", ["mobilePhone", "microsoftAuthenticatorPush"])).state, "ok");
});

test("one finding per account: a stale member with no MFA is one stale row that says so", () => {
  const users = [
    member("stale-nomfa", signedIn(120)),
    member("stale-mfa", signedIn(120)),
    member("fresh-nomfa", signedIn(3)),
    member("fresh-mfa", signedIn(3)),
  ];
  const rows = [noMfa("stale-nomfa"), withMfa("stale-mfa"), noMfa("fresh-nomfa"), withMfa("fresh-mfa")];
  const out = classify(users, rows, OPTS);
  assert.deepEqual(out.map((f) => [f.kind, f.id]), [
    ["stale-user", "stale-nomfa#stale"],
    ["stale-user", "stale-mfa#stale"],
    ["user-no-mfa", "fresh-nomfa#no-mfa"],
  ]);
  assert.match(out[0].detail, /no sign-in for 120 days \(last 2026-07-11\); it also has no MFA method registered\. Disable it/);
  assert.doesNotMatch(out[1].detail, /MFA/);
  assert.equal(new Set(out.map((f) => f.principalId)).size, out.length, "no account twice");
});

test("MFA is judged only for accounts in use: never signed in gives nothing or never-signed-in, not user-no-mfa", () => {
  const users = [
    member("new-never", { createdDateTime: daysAgo(30) }),
    member("old-never", { createdDateTime: daysAgo(100) }),
    member("brand-new", { createdDateTime: daysAgo(3), ...signedIn(1) }),
    member("settled", { createdDateTime: daysAgo(20), ...signedIn(1) }),
  ];
  const rows = [noMfa("new-never"), noMfa("old-never"), noMfa("brand-new"), noMfa("settled")];
  const out = classify(users, rows, OPTS);
  assert.deepEqual(out.map((f) => [f.kind, f.id]), [
    ["never-signed-in", "old-never#never"],
    ["user-no-mfa", "settled#no-mfa"],
  ]);
  assert.match(out[0].detail, /Cloud-only account created 2026-07-31 has never signed in/);
});

test("weak MFA, admins, disabled accounts and accounts without a report row", () => {
  const users = [
    member("weak", signedIn(2)),
    member("admin", signedIn(2)),
    member("disabled", { accountEnabled: false, ...signedIn(500) }),
    member("norow", signedIn(2)),
    member("synced-stale", { onPremisesSyncEnabled: true, ...signedIn(200) }),
  ];
  const rows = [withMfa("weak", ["mobilePhone", "officePhone"]), { id: "admin", isAdmin: true, isMfaRegistered: false }, noMfa("disabled"), noMfa("synced-stale")];
  const out = classify(users, rows, OPTS);
  assert.deepEqual(out.map((f) => [f.kind, f.id]), [
    ["mfa-weak-only", "weak#weak"],
    ["stale-user", "synced-stale#stale"],
  ]);
  assert.match(out[0].detail, /Only phone or text message \(mobilePhone, officePhone\)/);
  assert.match(out[1].detail, /^Synced from on-premises AD: no sign-in for 200 days .*; it also has no MFA method registered$/, "no disable advice for a synced account");
  assert.equal(out[1].source, "ad-synced");
});

test("guests: pending invitation, stale, never signed in, and never an MFA finding", () => {
  const users = [
    guest("pending-old", { externalUserState: "PendingAcceptance", createdDateTime: daysAgo(70) }),
    guest("pending-new", { externalUserState: "PendingAcceptance", createdDateTime: daysAgo(10) }),
    guest("stale", { externalUserState: "Accepted", ...signedIn(70) }),
    guest("active", { externalUserState: "Accepted", ...signedIn(5) }),
    guest("never", { externalUserState: "Accepted", createdDateTime: daysAgo(70) }),
  ];
  const rows = [noMfa("stale"), noMfa("active"), noMfa("never")];
  const out = classify(users, rows, OPTS);
  assert.deepEqual(out.map((f) => [f.kind, f.id]), [
    ["guest-invite-pending", "pending-old#pending"],
    ["stale-guest", "stale#stale"],
    ["never-signed-in", "never#never"],
  ]);
  assert.match(out[0].detail, /^Guest invited 2026-08-30 never accepted the invitation/);
  assert.match(out[1].detail, /^Guest: no sign-in for 70 days/);
  assert.doesNotMatch(out[1].detail, /MFA/, "a guest's MFA is its own tenant's business");
});

test("the last sign-in prefers a successful one over the newer failed attempt", () => {
  const u = member("u", { signInActivity: { lastSuccessfulSignInDateTime: daysAgo(100), lastSignInDateTime: daysAgo(1), lastNonInteractiveSignInDateTime: daysAgo(2) } });
  const out = classify([u], [withMfa("u")], OPTS);
  assert.deepEqual(out.map((f) => f.kind), ["stale-user"]);
  const v = member("v", { signInActivity: { lastSignInDateTime: daysAgo(100), lastNonInteractiveSignInDateTime: daysAgo(2) } });
  assert.deepEqual(classify([v], [withMfa("v")], OPTS), [], "without a successful one the newest of the other two counts");
});

// ---- the run ----

const accountAnswers = (users, rows) => (method, url) => {
  if (url.startsWith("/users?")) return users;
  if (url.startsWith("/reports/authenticationMethods/")) return rows;
  return { value: [] };
};

test("run: account findings plus the two parts; risky users off calls nothing of Graph for it", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "none";
  answer = accountAnswers([member("stale", signedIn(120)), member("fresh", signedIn(1))], [noMfa("stale"), noMfa("fresh")]);
  const out = await accounts.run();
  assert.deepEqual(out.map((f) => f.kind).sort(), ["stale-user", "user-no-mfa"]);
  assert.ok(calls.some(([, url]) => url.startsWith("/auditLogs/signIns")), "the legacy part ran");
  assert.ok(!calls.some(([, url]) => url.includes("/identityProtection/")), "the risky part did not");
});

test("run: a failing account read fails the run with the permission hint", async () => {
  answer = (method, url) => {
    if (url.startsWith("/users?")) throw Object.assign(new Error("Graph GET /users failed (403): Authorization_RequestDenied"), { status: 403 });
    return { value: [] };
  };
  await assert.rejects(accounts.run(), /AuditLog\.Read\.All/);
});

test("run: a failing legacy part is one scan-error finding, the account findings stay", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "none";
  answer = (method, url) => {
    if (url.startsWith("/auditLogs/signIns")) throw new Error("Graph GET /auditLogs/signIns failed (500): boom");
    return accountAnswers([member("stale", signedIn(120))], [])(method, url);
  };
  const out = await accounts.run();
  assert.deepEqual(out.map((f) => f.kind).sort(), ["scan-error", "stale-user"]);
  const err = out.find((f) => f.kind === "scan-error");
  assert.equal(err.id, "accounts/scan-errors/Legacy sign-ins");
  assert.match(err.detail, /failed \(500\): boom/);
});

test("run: without Entra ID P1 the legacy part is an info line and no findings", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "none";
  answer = (method, url) => {
    if (url.startsWith("/auditLogs/signIns")) throw Object.assign(new Error('Graph GET failed (403): {"error":{"code":"Authentication_RequestFromNonPremiumTenantOrB2CTenant"}}'), { status: 403 });
    return accountAnswers([], [])(method, url);
  };
  assert.deepEqual(await accounts.run(), []);
  assert.ok(logged.some((l) => l.tool === "accounts" && l.level === "info" && /Legacy sign-ins not checked/.test(l.message)));
});

test("run: the risky users part reports under the accounts id, with the check id in the finding", async () => {
  process.env.EXTRA_GRAPH_CHECKS = "risky-users";
  answer = (method, url) => {
    if (url.includes("/identityProtection/")) throw Object.assign(new Error('Graph GET failed (403): {"error":{"code":"Authorization_RequestDenied"}}'), { status: 403 });
    return accountAnswers([], [])(method, url);
  };
  const out = await accounts.run();
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "accounts/scan-errors/risky-users-permission");
  assert.match(out[0].detail, /add "risky-users" to extra_graph_checks/);
  assert.equal(logged.find((l) => l.level === "warn").tool, "accounts");
});
