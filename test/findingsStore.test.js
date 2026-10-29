// The per-tenant store on the file backend: a tenant that no longer exists
// gets nothing written (so a removed tenant's store never comes back), and
// deleteTenantStore takes a customer's whole folder, never the home tenant's.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const env = require("./_env");
env.useTerraformTenants();
const findingsStore = require("../src/findingsStore");
require("../src/tenants"); // exists() looks tenants up late

after(env.cleanup);
const tenantDir = (key) => path.join(env.DATA_DIR, "tenants", key);

test("write: findings of a tenant that does not exist are dropped, the others are kept", async () => {
  const findings = [
    { kind: "disk", id: "h1", name: "home disk" },
    { tenant: "contoso", kind: "disk", id: "c1", name: "contoso disk" },
    { tenant: "ghost", kind: "disk", id: "g1", name: "removed tenant's disk" },
  ];
  const r = await findingsStore.write("orphaned-resources", findings, { tenants: ["home", "contoso", "ghost"] });
  assert.ok(r.ranAt);
  assert.ok(fs.existsSync(path.join(env.DATA_DIR, "findings", "orphaned-resources.json")), "the home store is DATA_DIR itself");
  assert.ok(fs.existsSync(path.join(tenantDir("contoso"), "findings", "orphaned-resources.json")));
  assert.equal(fs.existsSync(tenantDir("ghost")), false);
  const read = await findingsStore.read("orphaned-resources", ["home", "contoso", "ghost"]);
  assert.deepEqual(read.findings.map((f) => f.id).sort(), ["c1", "h1"]);
});

test("writeTenantError and putDoc refuse a tenant that does not exist", async () => {
  await findingsStore.writeTenantError("orphaned-resources", "ghost", new Date().toISOString(), "boom");
  assert.equal(fs.existsSync(tenantDir("ghost")), false);
  await assert.rejects(findingsStore.putDoc("cost/index.json", { a: 1 }, "ghost"), /tenant "ghost" no longer exists, nothing written/);
  await findingsStore.putDoc("cost/index.json", { a: 1 }, "contoso");
  assert.deepEqual(await findingsStore.getDoc("cost/index.json", "contoso"), { a: 1 });
  await findingsStore.putDoc("cost/index.json", { home: true });
  assert.deepEqual(await findingsStore.getDoc("cost/index.json"), { home: true });
});

test("deleteTenantStore removes the whole folder and says whether there was one", async () => {
  await assert.rejects(findingsStore.deleteTenantStore("home"), /home tenant's store is never deleted/);
  await assert.rejects(findingsStore.deleteTenantStore(""), /home tenant's store is never deleted/);
  await assert.rejects(findingsStore.deleteTenantStore("../etc"), /invalid tenant key/);
  await assert.rejects(findingsStore.deleteTenantStore("Bad Key"), /invalid tenant key/);

  const first = await findingsStore.deleteTenantStore("contoso");
  assert.deepEqual(first, { backend: "file", where: tenantDir("contoso"), existed: true });
  assert.equal(fs.existsSync(tenantDir("contoso")), false);
  assert.ok(fs.existsSync(path.join(env.DATA_DIR, "findings", "orphaned-resources.json")), "the home store stays");

  const again = await findingsStore.deleteTenantStore("contoso");
  assert.deepEqual(again, { backend: "file", where: tenantDir("contoso"), existed: false });
});

test("containerName follows the blob naming rules Terraform uses", () => {
  assert.equal(findingsStore.containerName("home"), "dashboard");
  assert.equal(findingsStore.containerName("contoso"), "dashboard-contoso");
  assert.equal(findingsStore.containerName("acme_corp"), "dashboard-acme-corp");
});
