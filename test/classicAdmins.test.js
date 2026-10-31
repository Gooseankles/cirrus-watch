// Subscriptions scan, classic administrators: a 404 means none, a 403 is a quiet note, not a scan failure.
// armClient is stubbed before the tool is loaded (tools take its functions at require time). No Azure.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const arm = require("../src/armClient");

after(env.cleanup);

const SUBS = [
  { subscriptionId: "s1", name: "Prod", state: "Enabled", chain: [{ name: "mg1" }] },
  { subscriptionId: "s2", name: "Retired", state: "Enabled", chain: [{ name: "mg1" }] },
  { subscriptionId: "s3", name: "Locked", state: "Enabled", chain: [{ name: "mg1" }] },
  { subscriptionId: "s4", name: "Gone", state: "Disabled", chain: [{ name: "mg1" }] },
];
const calls = [];
arm.resourceGraphQuery = async (kql) => (/ResourceContainers/.test(kql) ? SUBS : []);
arm.armGet = async (url) => {
  calls.push(url);
  const sub = url.match(/subscriptions\/([^/]+)/)[1];
  if (sub === "s1") return { value: [{ name: "x", properties: { emailAddress: "old@contoso.com", role: "CoAdministrator" } }] };
  if (sub === "s2") throw new Error("GET classicAdministrators failed (404): not found");
  throw new Error("GET classicAdministrators failed (403): AuthorizationFailed");
};
const tool = require("../src/tools/subscriptions");

test("classic admins are listed, 404 is empty, 403 is one note, disabled subscriptions are skipped", async () => {
  const found = await tool.run();
  const mine = found.filter((f) => /^classic-admin/.test(f.kind) || /classic/i.test(f.id || ""));
  assert.deepEqual(mine.map((f) => [f.kind, f.subscriptionId]), [
    ["classic-admin", "s1"],
    ["classic-admin-unread", "s3"],
  ]);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((u) => u.includes("api-version=2015-07-01")));
});
