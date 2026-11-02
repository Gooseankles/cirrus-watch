// EXCLUDED_SUBSCRIPTIONS: subscriptions no scan reads. The per-subscription list
// leaves them out, a Resource Graph query with every subscription excluded asks
// Azure nothing, and the setting only takes subscription IDs. No Azure.
const { test, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const settings = require("../src/settings");
const { subscriptionIdsToScan, resourceGraphQuery, excludedSubscriptionIds } = require("../src/armClient");

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";

after(env.cleanup);
afterEach(() => {
  delete process.env.AZURE_SUBSCRIPTION_IDS;
  delete process.env.EXCLUDED_SUBSCRIPTIONS;
});

test("excluded subscriptions are left out of the list to scan, whatever the case", async () => {
  process.env.AZURE_SUBSCRIPTION_IDS = `${A},${B}`;
  process.env.EXCLUDED_SUBSCRIPTIONS = ` ${B.toUpperCase()} `;
  assert.deepEqual([...excludedSubscriptionIds()], [B]);
  assert.deepEqual(await subscriptionIdsToScan("t"), [A]);
});

test("blank = nothing left out", async () => {
  process.env.AZURE_SUBSCRIPTION_IDS = `${A},${B}`;
  assert.equal(excludedSubscriptionIds().size, 0);
  assert.deepEqual(await subscriptionIdsToScan("t"), [A, B]);
});

test("every subscription excluded: a Resource Graph query returns no rows and calls nothing", async () => {
  process.env.AZURE_SUBSCRIPTION_IDS = A;
  process.env.EXCLUDED_SUBSCRIPTIONS = A;
  assert.deepEqual(await resourceGraphQuery("Resources | take 1", { toolId: "excluded-test" }), []);
});

test("the setting takes subscription IDs only", async () => {
  await assert.rejects(settings.setMany({ values: { EXCLUDED_SUBSCRIPTIONS: "Production" } }), /subscription IDs/);
  const field = settings.fields ? settings.fields().find((f) => f.key === "EXCLUDED_SUBSCRIPTIONS") : null;
  if (field) assert.equal(field.perTenant, true);
});

test("a list with spaces after the commas is accepted", async () => {
  const all = await settings.setMany({ values: { EXCLUDED_SUBSCRIPTIONS: `${A}, ${B}` } });
  assert.ok(all);
  assert.deepEqual([...excludedSubscriptionIds()].sort(), [A, B]);
  await settings.setMany({ values: { EXCLUDED_SUBSCRIPTIONS: "" } });
});
