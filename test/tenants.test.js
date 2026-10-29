// The customer tenant list: what Settings adds, what Terraform sets, and the
// removed list that hides a Terraform tenant until Terraform drops it too.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const env = require("./_env");
env.useTerraformTenants();
const tenants = require("../src/tenants");

const keys = () => tenants.customers().map((t) => t.key);
after(env.cleanup);

test("Terraform tenants are listed, with a Settings one beside them", async () => {
  assert.deepEqual(keys(), ["contoso", "fabrikam"]);
  await tenants.upsert({ key: "acme", name: "Acme", tenantId: "aaaaaaaa-0000-4000-8000-000000000003", clientSecret: "s3cret" });
  assert.deepEqual(keys(), ["acme", "contoso", "fabrikam"]);
  assert.equal(tenants.byKey("acme").source, "settings");
  assert.equal(tenants.byKey("contoso").source, "terraform");
});

test("forget: a Settings tenant goes from the file, and nothing waits for Terraform", () => {
  const r = tenants.forget("acme", "admin");
  assert.deepEqual(r, { key: "acme", name: "Acme", source: "settings", terraform: false, fileSecret: true });
  assert.deepEqual(keys(), ["contoso", "fabrikam"]);
  assert.equal(tenants.byKey("acme"), null);
  assert.equal(fs.existsSync(tenants._test.REMOVED_FILE), false);
  assert.deepEqual(tenants.removedForSettings(), []);
});

test("forget: a Terraform tenant is hidden and put on the removed list", () => {
  const r = tenants.forget("contoso", "admin@example.com");
  assert.equal(r.terraform, true);
  assert.equal(r.fileSecret, false);
  assert.deepEqual(keys(), ["fabrikam"]);
  assert.equal(tenants.byKey("contoso"), null);
  assert.equal(tenants.isRemoved("contoso"), true);
  assert.deepEqual(tenants.scanTargets().map((t) => t.key), ["home", "fabrikam"]);
  const removed = tenants.removedForSettings();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].key, "contoso");
  assert.equal(removed[0].name, "Contoso");
  assert.equal(removed[0].by, "admin@example.com");
  assert.ok(removed[0].at);
  assert.deepEqual(Object.keys(env.readJson(tenants._test.REMOVED_FILE)), ["contoso"]);
});

test("a removed tenant cannot be saved again until it is restored", async () => {
  await assert.rejects(tenants.upsert({ key: "contoso", name: "Contoso again" }), /was removed and waits for Terraform/);
});

test("restore brings a removed Terraform tenant back; the removed file goes when empty", () => {
  const list = tenants.restore("contoso");
  assert.ok(list.some((t) => t.key === "contoso"));
  assert.deepEqual(keys(), ["contoso", "fabrikam"]);
  assert.equal(fs.existsSync(tenants._test.REMOVED_FILE), false);
  assert.throws(() => tenants.restore("contoso"), /no such removed tenant/);
});

test("pruneRemoved clears entries whose key Terraform no longer sets", () => {
  tenants.forget("fabrikam", null);
  fs.writeFileSync(tenants._test.REMOVED_FILE, JSON.stringify({ ...env.readJson(tenants._test.REMOVED_FILE), oldco: { at: "2026-01-01T00:00:00.000Z", by: null, name: "Old Co" } }));
  assert.deepEqual(tenants.removedForSettings().map((r) => r.key), ["fabrikam"]); // oldco is not shown: Terraform does not set it
  assert.deepEqual(tenants.pruneRemoved(), ["oldco"]);
  assert.deepEqual(Object.keys(env.readJson(tenants._test.REMOVED_FILE)), ["fabrikam"]);
  assert.deepEqual(tenants.pruneRemoved(), []);
  tenants.restore("fabrikam");
});

test("the home tenant and unknown keys are refused", () => {
  assert.throws(() => tenants.forget("home"), /home tenant cannot be removed/);
  assert.throws(() => tenants.forget("nobody"), /no such tenant/);
  assert.throws(() => tenants.forget(""), /no such tenant/);
  assert.throws(() => tenants.restore("nobody"), /no such removed tenant/);
});

test("reset only applies to a Terraform tenant changed in Settings", async () => {
  await assert.rejects(tenants.reset("contoso"), /no Settings changes to reset/);
  await tenants.upsert({ key: "contoso", name: "Contoso (renamed)" });
  assert.equal(tenants.byKey("contoso").source, "terraform + settings");
  await tenants.reset("contoso");
  assert.equal(tenants.byKey("contoso").name, "Contoso");
  await tenants.upsert({ key: "acme", name: "Acme", tenantId: "aaaaaaaa-0000-4000-8000-000000000003" });
  await assert.rejects(tenants.reset("acme"), /added in Settings; Remove deletes it/);
  await assert.rejects(tenants.reset("nobody"), /no such tenant/);
});
