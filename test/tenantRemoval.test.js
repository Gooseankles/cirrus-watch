// Removing a customer tenant deletes everything, step by step, and a step that
// fails does not stop the others. Real modules on the file backend (no Azure),
// then stand-ins for the steps that need a vault or a storage account.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const env = require("./_env");
env.useTerraformTenants();
const tenants = require("../src/tenants");
const findingsStore = require("../src/findingsStore");
const settings = require("../src/settings");
const notify = require("../src/notify");
const log = require("../src/log");
const { removeEverything, summary, LABELS } = require("../src/tenantRemoval");

after(env.cleanup);

const tenantDir = (key) => path.join(env.DATA_DIR, "tenants", key);
const notifyFile = path.join(env.DATA_DIR, "notify.json");
const queueFile = path.join(env.DATA_DIR, "notify-queue.json");
const tenantSettingsFile = path.join(env.DATA_DIR, "tenant-settings.json");
const runsLog = path.join(env.LOG_DIR, "runs.jsonl");

// A tenant with something in every place the dashboard keeps per-tenant data.
async function fillTenant(key) {
  await findingsStore.write("orphaned-resources", [{ tenant: key, kind: "disk", id: `${key}-1`, name: "d1" }], { tenants: [key] });
  await findingsStore.putDoc("cost/index.json", { months: ["2026-09"] }, key);
  fs.writeFileSync(notifyFile, JSON.stringify({ ...(fs.existsSync(notifyFile) ? env.readJson(notifyFile) : {}), [key]: `https://hooks.example/${key}` }));
  fs.writeFileSync(queueFile, JSON.stringify({ ...(fs.existsSync(queueFile) ? env.readJson(queueFile) : {}), [key]: [{ kind: "finding", name: "d1" }] }));
  fs.writeFileSync(tenantSettingsFile, JSON.stringify({ ...(fs.existsSync(tenantSettingsFile) ? env.readJson(tenantSettingsFile) : {}), [key]: { ORPHAN_MIN_AGE_DAYS: "3" } }));
  log.record({ tool: "orphaned-resources", tenant: key, message: `scan of ${key}` });
}

test("a Settings tenant: entry, secret, store, notify, settings and log lines all go", async () => {
  await tenants.upsert({ key: "acme", name: "Acme", tenantId: "aaaaaaaa-0000-4000-8000-000000000003", clientId: "bbbbbbbb-0000-4000-8000-000000000003", clientSecret: "s3cret" });
  await fillTenant("acme");
  await fillTenant("contoso");
  log.record({ tool: "orphaned-resources", message: "scan of everything" });
  assert.ok(fs.existsSync(path.join(tenantDir("acme"), "findings", "orphaned-resources.json")));
  assert.ok(fs.existsSync(path.join(tenantDir("acme"), "cost", "index.json")));

  const r = await removeEverything("acme", { by: "admin" });

  assert.deepEqual(r.failed, []);
  assert.equal(r.terraform, false);
  assert.equal(r.name, "Acme");
  assert.deepEqual(r.kept, []);
  assert.equal(r.message, "Removed from Cirrus Watch.");
  assert.deepEqual(r.deleted.map((d) => d.step), ["tenant", "secret", "notify", "store", "settings", "caches", "log"]);
  const detail = Object.fromEntries(r.deleted.map((d) => [d.step, d.detail]));
  assert.equal(detail.tenant, "removed from the list");
  assert.equal(detail.secret, "went with the tenant entry (tenants.json)");
  assert.equal(detail.store, `folder ${tenantDir("acme")} deleted`);
  assert.equal(detail.settings, "removed");
  assert.equal(detail.log, "1 line(s) removed");

  // Gone, and the other customer's data is untouched.
  assert.equal(tenants.byKey("acme"), null);
  assert.equal(JSON.stringify(env.readJson(tenants._test.FILE)).includes("s3cret"), false);
  assert.equal(fs.existsSync(tenantDir("acme")), false);
  assert.ok(fs.existsSync(tenantDir("contoso")));
  assert.deepEqual(Object.keys(env.readJson(notifyFile)), ["contoso"]);
  assert.deepEqual(Object.keys(env.readJson(queueFile)), ["contoso"]);
  assert.deepEqual(Object.keys(env.readJson(tenantSettingsFile)), ["contoso"]);
  const lines = fs.readFileSync(runsLog, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.tenant !== "acme"));
  assert.ok(lines.some((l) => l.message === "scan of everything"), "a line for every tenant stays");
  assert.equal(fs.existsSync(tenants._test.REMOVED_FILE), false);

  // Nothing is written for it afterwards: a scan that was still running cannot bring the folder back.
  await assert.rejects(findingsStore.putDoc("cost/index.json", {}, "acme"), /no longer exists, nothing written/);
  await findingsStore.write("orphaned-resources", [{ tenant: "acme", kind: "disk", id: "late" }], { tenants: ["acme"] });
  assert.equal(fs.existsSync(tenantDir("acme")), false);
  assert.ok(summary(r).startsWith("tenant entry: removed from the list | client secret: went with the tenant entry"));
  assert.equal(summary(r).includes("FAILED"), false);
});

test("a Terraform tenant: the same, plus the removed list and the Terraform step in the message", async () => {
  const r = await removeEverything("contoso", { by: "admin@example.com" });
  assert.deepEqual(r.failed, []);
  assert.equal(r.terraform, true);
  assert.equal(r.message, 'Removed from Cirrus Watch. Also remove "contoso" from customers in Terraform and apply: that deletes its roles and groups.');
  assert.equal(r.deleted.find((d) => d.step === "tenant").detail, "removed from the list; ignored until Terraform drops it too");
  assert.equal(r.deleted.find((d) => d.step === "secret").detail, "none was stored");
  assert.equal(tenants.byKey("contoso"), null);
  assert.equal(fs.existsSync(tenantDir("contoso")), false);
  assert.deepEqual(tenants.removedForSettings().map((x) => x.key), ["contoso"]);
  assert.equal(fs.existsSync(notifyFile) ? Object.keys(env.readJson(notifyFile)).length : 0, 0);
  assert.equal(fs.readFileSync(runsLog, "utf8").trim().split("\n").length, 1);
  // Undo lists it again, with nothing of its data.
  tenants.restore("contoso");
  assert.ok(tenants.byKey("contoso"));
  assert.equal(fs.existsSync(tenantDir("contoso")), false);
  assert.equal(settings.dropTenant("contoso"), false);
});

test("the home tenant and an unknown key are refused before anything is touched", async () => {
  await assert.rejects(removeEverything("home"), /home tenant cannot be removed/);
  await assert.rejects(removeEverything(""), /home tenant cannot be removed/);
  await assert.rejects(removeEverything("nobody"), /no such tenant/);
  await assert.rejects(removeEverything("acme"), /no such tenant/); // already removed
});

// Stand-ins: every step answers, so what each one did can be checked.
function fakeDeps(overrides = {}) {
  const calls = [];
  const note = (name) => (...args) => (calls.push([name, ...args]), undefined);
  const deps = {
    tenants: { byKey: (k) => (k === "acme" ? { key: "acme", name: "Acme", tenantId: "t-1", clientId: "c-1", source: "terraform" } : null), forget: (k, by) => (calls.push(["forget", k, by]), { key: k, name: "Acme", source: "terraform", terraform: true, fileSecret: false }) },
    secretStore: { enabled: () => true, purge: async (kind, k) => (calls.push(["purge", kind, k]), { deleted: true, purged: true, keptDays: null, reason: null }) },
    notify: { drop: async (k, o) => (calls.push(["notify.drop", k, o]), { deleted: false, purged: false, keptDays: null, reason: "no secret was stored" }) },
    findingsStore: { deleteTenantStore: async (k) => (calls.push(["deleteTenantStore", k]), { backend: "blob", where: "dashboard-acme", existed: true }) },
    settings: { dropTenant: (k) => (calls.push(["settings.dropTenant", k]), true) },
    armClient: { forgetTenant: (k) => (calls.push(["forgetTenant", k]), 2) },
    credentials: { forget: (t, c) => (calls.push(["credentials.forget", t, c]), 1) },
    log: { dropTenant: (k) => (calls.push(["log.dropTenant", k]), 4) },
    ...overrides,
  };
  deps.note = note;
  return { deps, calls };
}

test("with a vault and a storage account every place is asked, in order", async () => {
  const { deps, calls } = fakeDeps();
  const r = await removeEverything("acme", { by: "admin" }, deps);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["forget", "purge", "notify.drop", "deleteTenantStore", "settings.dropTenant", "forgetTenant", "credentials.forget", "log.dropTenant"]
  );
  assert.deepEqual(calls[0], ["forget", "acme", "admin"]);
  assert.deepEqual(calls[1], ["purge", "tenant", "acme"]);
  assert.deepEqual(calls[2], ["notify.drop", "acme", { purge: true }]);
  assert.deepEqual(calls[6], ["credentials.forget", "t-1", "c-1"]);
  const detail = Object.fromEntries(r.deleted.map((d) => [d.step, d.detail]));
  assert.equal(detail.secret, "deleted and purged from the key vault");
  assert.equal(detail.notify, "no secret was stored");
  assert.equal(detail.store, "container dashboard-acme deleted");
  assert.equal(detail.caches, "2 cached name list(s), 1 cached sign-in(s)");
  assert.equal(detail.log, "4 line(s) removed");
  assert.deepEqual(r.kept, []);
});

test("a step that fails is reported and the rest still run", async () => {
  const { deps, calls } = fakeDeps({
    findingsStore: { deleteTenantStore: async () => { throw new Error("history storage: delete container dashboard-acme failed: AuthorizationFailure (give the dashboard's identity Storage Blob Data Contributor on the storage account)"); } },
    log: { dropTenant: () => { throw new Error("EACCES: read-only"); } },
  });
  const r = await removeEverything("acme", {}, deps);
  assert.deepEqual(r.failed.map((f) => f.step), ["store", "log"]);
  assert.equal(r.failed[0].label, LABELS.store);
  assert.match(r.failed[0].error, /AuthorizationFailure/);
  assert.deepEqual(r.deleted.map((d) => d.step), ["tenant", "secret", "notify", "settings", "caches"]);
  assert.ok(calls.some((c) => c[0] === "settings.dropTenant"), "the steps after the failed one still ran");
  assert.match(r.message, /^Removed from Cirrus Watch, but not everything could be deleted: results, history, accepted findings and cost history \(history storage: delete container dashboard-acme failed.*\); activity log lines \(EACCES: read-only\)\. Finish that by hand\. Also remove "acme" from customers in Terraform/);
  assert.match(summary(r), /results, history, accepted findings and cost history FAILED: history storage/);
  assert.match(summary(r), /activity log lines FAILED: EACCES/);
});

test("a purge the vault refuses is said plainly, with how long it keeps the secret", async () => {
  const { deps } = fakeDeps({
    secretStore: { enabled: () => true, purge: async () => ({ deleted: true, purged: false, keptDays: 90, reason: "the vault's purge protection keeps it" }) },
    notify: { drop: async () => ({ deleted: true, purged: false, keptDays: 1, reason: "the dashboard's identity may not purge (it needs Key Vault Secrets Officer on the vault); the vault keeps it" }) },
  });
  const r = await removeEverything("acme", {}, deps);
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.kept, [
    "The client secret is deleted; the vault's purge protection keeps it for 90 days.",
    "The notification link is deleted; the dashboard's identity may not purge (it needs Key Vault Secrets Officer on the vault); the vault keeps it for 1 day.",
  ]);
  assert.match(r.message, /^Removed from Cirrus Watch\. The client secret is deleted; the vault's purge protection keeps it for 90 days\. The notification link is deleted; .* for 1 day\. Also remove "acme"/);
  assert.equal(r.deleted.find((d) => d.step === "secret").detail, "deleted; the vault's purge protection keeps it for 90 days");
});

test("a tenant that disappears between the check and the first step counts as a failed step, not a crash", async () => {
  const { deps } = fakeDeps({ tenants: { byKey: () => ({ key: "acme", name: "Acme", source: "settings" }), forget: () => { throw new Error("no such tenant"); } } });
  const r = await removeEverything("acme", {}, deps);
  assert.deepEqual(r.failed.map((f) => f.step), ["tenant"]);
  assert.equal(r.terraform, false);
  assert.equal(r.deleted.length, 6);
});
