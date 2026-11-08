// A scan that replaced older scans takes over their stored data the first
// time its id is used in a tenant: latest results (with firstSeen), the
// per-run index, snapshots of the newest runs and accepted findings. Its
// first own run then reports only what really changed.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const env = require("./_env");
env.useTerraformTenants();
const findingsStore = require("../src/findingsStore");
const suppressions = require("../src/suppressions");
require("../src/tenants");

after(env.cleanup);
const tick = () => new Promise((r) => setTimeout(r, 5)); // distinct ranAt values

const stale = (id) => ({ kind: "stale-user", id: `${id}#stale`, name: id, detail: "no sign-in for 100 days", principalId: id });
const noMfa = (id) => ({ kind: "user-no-mfa", id: `${id}#no-mfa`, name: id, detail: "No MFA method registered", principalId: id });

test("a merged scan adopts the old scans' results, history, snapshots and accepted findings", async () => {
  // Two runs of the old Stale accounts scan, one of the old MFA coverage scan,
  // in the home tenant and in contoso. One stale finding is accepted.
  const r1 = await findingsStore.write("old-stale", [stale("ann"), stale("bob"), { ...stale("cat"), tenant: "contoso" }], { tenants: ["home", "contoso"] });
  await tick();
  const r2 = await findingsStore.write("old-stale", [stale("ann"), stale("dan"), { ...stale("cat"), tenant: "contoso" }], { tenants: ["home", "contoso"] });
  await tick();
  const r3 = await findingsStore.write("old-mfa", [noMfa("eve"), { ...noMfa("fay"), tenant: "contoso" }], { tenants: ["home", "contoso"] });
  await suppressions.set("old-stale", "home", findingsStore.findingKey(stale("ann")), { reason: "service account", until: null, by: "simon", at: r2.ranAt });

  findingsStore.registerReplaces("accounts", ["old-stale", "old-mfa"]);
  assert.deepEqual(findingsStore.replacesOf("accounts"), ["old-stale", "old-mfa"]);
  assert.deepEqual(findingsStore.replacesOf("old-stale"), []);

  // Latest: everything the old scans last saw, ages carried over.
  const latest = await findingsStore.read("accounts", ["home", "contoso"]);
  assert.equal(latest.ranAt, r3.ranAt);
  assert.deepEqual(latest.findings.map((f) => f.id).sort(), ["ann#stale", "cat#stale", "dan#stale", "eve#no-mfa", "fay#no-mfa"]);
  assert.equal(latest.findings.find((f) => f.id === "ann#stale").firstSeen, r1.ranAt, "seen since the first old run");
  assert.equal(latest.findings.find((f) => f.id === "dan#stale").firstSeen, r2.ranAt);
  assert.equal(latest.findings.find((f) => f.id === "cat#stale").tenant, "contoso");
  assert.ok(fs.existsSync(path.join(env.DATA_DIR, "findings", "accounts.json")));
  assert.ok(fs.existsSync(path.join(env.DATA_DIR, "findings", "old-stale.json")), "old files stay");

  // History: one entry per old run time, each old scan counted at its last run before it.
  const history = await findingsStore.history("accounts", ["home"]);
  assert.deepEqual(
    history.map((e) => [e.ranAt, e.count, e.added, e.resolved]),
    [
      [r1.ranAt, 2, 2, 0],
      [r2.ranAt, 2, 1, 1],
      [r3.ranAt, 3, 1, 0],
    ]
  );
  assert.deepEqual(history[2].byKind, { "stale-user": 2, "user-no-mfa": 1 });

  // Snapshots: each adopted run can be opened and shows both old scans as they stood.
  const run2 = await findingsStore.readRun("accounts", r2.ranAt, ["home", "contoso"]);
  assert.deepEqual(run2.findings.map((f) => f.id).sort(), ["ann#stale", "cat#stale", "dan#stale"]);
  assert.deepEqual(run2.added.map((f) => f.id), ["dan#stale"]);
  assert.deepEqual(run2.resolved.map((f) => f.id), ["bob#stale"]);
  const run3 = await findingsStore.readRun("accounts", r3.ranAt, ["home"]);
  assert.deepEqual(run3.findings.map((f) => f.id).sort(), ["ann#stale", "dan#stale", "eve#no-mfa"]);
  assert.deepEqual(run3.added.map((f) => f.id), ["eve#no-mfa"]);
  const at = await findingsStore.stateAt("accounts", r2.ranAt, ["home"]);
  assert.deepEqual(at.findings.map((f) => f.id).sort(), ["ann#stale", "dan#stale"]);

  // Accepted under the old id, still accepted under the new one.
  const marked = await suppressions.mark("accounts", latest.findings);
  assert.equal(marked, 1);
  assert.equal(latest.findings.find((f) => f.id === "ann#stale").accepted.reason, "service account");
  assert.deepEqual(Object.keys(await suppressions.load("accounts", "contoso")), []);

  // The first own run: only the real change is new, nothing is "new" just because the id changed.
  await tick();
  const own = await findingsStore.write("accounts", [stale("ann"), stale("dan"), noMfa("gus"), { ...stale("cat"), tenant: "contoso" }], { tenants: ["home", "contoso"] });
  assert.equal(own.added, 1);
  assert.equal(own.resolved, 2, "eve and fay are gone");
  assert.deepEqual(Object.keys(own.newByTenant), ["home"]);
  assert.deepEqual(own.newByTenant.home.map((f) => f.id), ["gus#no-mfa"]);
  const after1 = await findingsStore.read("accounts", ["home"]);
  assert.equal(after1.findings.find((f) => f.id === "ann#stale").firstSeen, r1.ranAt, "age survives the merge and the first own run");
  assert.equal((await findingsStore.history("accounts", ["home"])).length, 4);
});

test("a merged scan with nothing to adopt writes nothing and reads empty", async () => {
  findingsStore.registerReplaces("fresh", ["gone-a", "gone-b"]);
  const latest = await findingsStore.read("fresh", ["home", "fabrikam"]);
  assert.deepEqual(latest, { ranAt: null, findings: [], tenantErrors: {} });
  assert.deepEqual(await findingsStore.history("fresh", ["home"]), []);
  assert.equal(fs.existsSync(path.join(env.DATA_DIR, "findings", "fresh.json")), false);
  assert.deepEqual(await suppressions.load("fresh", "home"), {});
  assert.equal(fs.existsSync(path.join(env.DATA_DIR, "suppressions", "fresh.json")), false);
  const r = await findingsStore.write("fresh", [stale("ann")], { tenants: ["home"] });
  assert.deepEqual(r.newByTenant, {}, "a first run never notifies");
});

test("accepting under the merged id after the merge keeps what was adopted", async () => {
  findingsStore.registerReplaces("merged-two", ["old-x"]);
  await findingsStore.write("old-x", [stale("ann"), stale("bob")], { tenants: ["home"] });
  await suppressions.set("old-x", "home", findingsStore.findingKey(stale("ann")), { reason: "known", until: null, by: "simon", at: new Date().toISOString() });
  await suppressions.set("merged-two", "home", findingsStore.findingKey(stale("bob")), { reason: "also known", until: null, by: "simon", at: new Date().toISOString() });
  const doc = await suppressions.load("merged-two", "home");
  assert.deepEqual(Object.keys(doc).sort(), [findingsStore.findingKey(stale("ann")), findingsStore.findingKey(stale("bob"))].sort());
});
