// The PIM scan's group activation history: a Graph refusal (403) is said once
// per run and the group goes on without a last-activated date; a tenant
// without P2 and any other error go on to the caller (readGroup marks the
// group as not PIM-managed or fails it); a 429 left after the retries is
// counted for one note per run. Plain errors in, no Azure.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const { groupHistoryRefused } = require("../src/tools/pim")._test;

after(env.cleanup);

const refused = new Error('Graph GET https://graph.microsoft.com/v1.0/identityGovernance/privilegedAccess/group/assignmentScheduleRequests failed (403): {"error":{"code":"Authorization_RequestDenied"}} [client-request-id 11111111-2222-4333-8444-555555555555]');

test("a 403 on the history is noted once per run, then silent; the call returns no rows", () => {
  const ctx = { notes: [] };
  assert.deepEqual(groupHistoryRefused(refused, ctx), []);
  assert.deepEqual(groupHistoryRefused(refused, ctx), []);
  assert.equal(ctx.historyRefused, true);
  assert.equal(ctx.notes.length, 1);
  assert.match(ctx.notes[0], /activation history could not be read/);
});

test("the once-per-run flag lives on the run's own context", () => {
  const first = { notes: [] };
  const second = { notes: [] };
  groupHistoryRefused(refused, first);
  groupHistoryRefused(refused, second);
  assert.equal(second.notes.length, 1);
});

test("a 429 left after the retries is kept per group, not thrown: the group goes on without a history", () => {
  const ctx = { notes: [] };
  const throttled = new Error('Graph GET .../assignmentScheduleRequests failed (429): {"error":{"code":"UnknownError","message":"Too Many Requests"}}');
  assert.equal(groupHistoryRefused(throttled, ctx, "g1"), null);
  assert.equal(groupHistoryRefused(Object.assign(new Error("throttled"), { status: 429 }), ctx, "g2"), null);
  assert.deepEqual([...ctx.historyThrottled], ["g1", "g2"]);
  assert.equal(ctx.historyRefused, undefined);
  assert.equal(ctx.notes.length, 0);
});

test("429 inside a request id is not throttling: a 403 is still a refusal and a 500 still goes on", () => {
  const ctx = { notes: [] };
  const ids = "[client-request-id 9d4e4290-1111-4222-8333-444444444429]";
  assert.deepEqual(groupHistoryRefused(new Error(`Graph GET x failed (403): {"error":{"code":"Authorization_RequestDenied"}} ${ids}`), ctx, "g1"), []);
  assert.equal(ctx.historyRefused, true);
  assert.throws(() => groupHistoryRefused(new Error(`Graph GET x failed (500): {} ${ids}`), ctx, "g1"), /\(500\)/);
  assert.equal(ctx.historyThrottled, undefined);
});

test("a throttled group's members are not called unused, though another group's history reaches back", () => {
  const { peopleFindings } = require("../src/tools/pim")._test;
  const day = 86400000;
  const reaches = { plane: "group", last: new Map(), oldest: Date.now() - 365 * day };
  const row = (groupId) => ({ id: `r-${groupId}`, plane: "entra", privileged: true, kind: "user", state: "eligible", via: "pim-group", group: groupId, groupId, access: "member", role: "Global Administrator", scopeText: "x", start: new Date(Date.now() - 400 * day).toISOString(), end: new Date(Date.now() + 200 * day).toISOString(), personId: "u1" });
  const unused = (ctx) => peopleFindings([row("g1"), row("g2")], ctx).filter((f) => f.kind === "pim-eligible-unused").map((f) => f.id);
  assert.deepEqual(unused({ histories: [reaches], historyThrottled: new Set(["g1"]) }), ["pim/r-g2#unused"]);
  assert.equal(unused({ histories: [reaches] }).length, 2);
});

test("a tenant without P2 is not a refusal: the error goes on to the caller, as any other error", () => {
  const ctx = { notes: [] };
  const noP2 = new Error('Graph GET .../assignmentScheduleRequests failed (403): {"error":{"code":"AadPremiumLicenseRequired"}}');
  assert.throws(() => groupHistoryRefused(noP2, ctx), /AadPremiumLicenseRequired/);
  const outage = new Error("Graph GET .../assignmentScheduleRequests failed (500): {}");
  assert.throws(() => groupHistoryRefused(outage, ctx), /\(500\)/);
  assert.equal(ctx.notes.length, 0);
  assert.equal(ctx.historyRefused, undefined);
});
