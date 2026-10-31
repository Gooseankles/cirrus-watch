// The PIM scan's group activation history: a Graph refusal (403) is said once
// per run and the group goes on without a last-activated date; a tenant
// without P2 and any other error go on to the caller (readGroup marks the
// group as not PIM-managed or fails it). Plain errors in, no Azure.
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

test("a tenant without P2 is not a refusal: the error goes on to the caller, as any other error", () => {
  const ctx = { notes: [] };
  const noP2 = new Error('Graph GET .../assignmentScheduleRequests failed (403): {"error":{"code":"AadPremiumLicenseRequired"}}');
  assert.throws(() => groupHistoryRefused(noP2, ctx), /AadPremiumLicenseRequired/);
  const outage = new Error("Graph GET .../assignmentScheduleRequests failed (500): {}");
  assert.throws(() => groupHistoryRefused(outage, ctx), /\(500\)/);
  assert.equal(ctx.notes.length, 0);
  assert.equal(ctx.historyRefused, undefined);
});
