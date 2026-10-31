// A scan run that hangs: it is stopped waiting for at its deadline, the
// tenant gets a clear error, and the next run can start (the busy set is
// cleared). /health turns "stale" when no scheduled scan has finished well.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const { registerScanTool, _test } = require("../src/toolRegistry");
const findingsStore = require("../src/findingsStore");
const health = require("../src/health");

after(env.cleanup);

// Enough of Express for registerScanTool.
const app = { get() {}, post() {} };

test("withDeadline: a slow promise is cut off, a fast one passes and leaves no timer", async () => {
  const never = new Promise(() => {});
  await assert.rejects(_test.withDeadline(never, 20, "too slow"), /too slow/);
  assert.equal(await _test.withDeadline(Promise.resolve(7), 60 * 60000, "too slow"), 7);
  // A timer left behind would keep this test file running for an hour.
});

test("deadlineMs: the tool's own value wins over SCAN_DEADLINE_MINUTES and the 45-minute default", () => {
  assert.equal(_test.deadlineMs({}), 45 * 60000);
  process.env.SCAN_DEADLINE_MINUTES = "10";
  assert.equal(_test.deadlineMs({}), 10 * 60000);
  assert.equal(_test.deadlineMs({ deadlineMinutes: 90 }), 90 * 60000);
  delete process.env.SCAN_DEADLINE_MINUTES;
});

test("a hung run records a timeout for the tenant and does not block the next run", async () => {
  let hang = true;
  let calls = 0;
  const tool = {
    id: "slow-scan",
    label: "Slow scan",
    deadlineMinutes: 0.001, // 60 ms
    run: () => {
      calls++;
      return hang ? new Promise(() => {}) : Promise.resolve([{ kind: "thing", id: "a1", name: "found" }]);
    },
  };
  registerScanTool(app, tool);

  await _test.execute(tool.id);
  const failed = await findingsStore.read(tool.id);
  assert.match(failed.tenantErrors.home.error, /scan timed out/);

  hang = false;
  tool.deadlineMinutes = undefined; // the 45-minute default: its timer must be cleared
  await _test.execute(tool.id);
  assert.equal(calls, 2, "the second run started: the tenant was no longer busy");
  const ok = await findingsStore.read(tool.id);
  assert.deepEqual(ok.findings.map((f) => f.id), ["a1"]);
  assert.equal(ok.tenantErrors.home, undefined);
});

test("health: ok after a start, stale when no scheduled scan finished in time", async () => {
  health._test.reset();
  const now = Date.now();
  const hour = 3600000;
  assert.equal(health.status(now, now - hour), "ok", "up for less than 26 hours");
  assert.equal(health.status(now, now - 27 * hour), "stale");
  process.env.HEALTH_SCAN_MAX_AGE_HOURS = "48";
  assert.equal(health.status(now, now - 27 * hour), "ok");
  delete process.env.HEALTH_SCAN_MAX_AGE_HOURS;

  // A Run now does not count; a scheduled run that saved does.
  const tool = { id: "quick-scan", label: "Quick scan", run: async () => [] };
  registerScanTool(app, tool);
  await _test.execute(tool.id);
  assert.equal(health.status(Date.now(), now - 27 * hour), "stale");
  await _test.execute(tool.id, null, { scheduled: true });
  assert.equal(health.status(Date.now(), now - 27 * hour), "ok");
  assert.equal(health.status(Date.now() + 27 * hour, now - 27 * hour), "stale");
});
