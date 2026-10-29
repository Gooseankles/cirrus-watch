// The activity log: a removed tenant's own lines go, lines about every tenant
// (no `tenant` field) and lines that do not parse stay.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");

const env = require("./_env");
const log = require("../src/log");

after(env.cleanup);

test("dropTenant removes only that tenant's lines", () => {
  assert.equal(log.dropTenant("acme"), 0, "no log yet");
  log.record({ tool: "orphaned-resources", tenant: "acme", message: "acme 1" });
  log.record({ tool: "orphaned-resources", tenant: "contoso", message: "contoso 1" });
  log.record({ tool: "orphaned-resources", message: "all tenants" });
  log.record({ tool: "notifications", tenant: "acme", message: "acme 2" });
  fs.appendFileSync(log._test.LOG_FILE, "{not json\n");
  assert.equal(log.dropTenant("acme"), 2);
  const text = fs.readFileSync(log._test.LOG_FILE, "utf8");
  const lines = text.split("\n").filter(Boolean);
  assert.deepEqual(lines.slice(0, 2).map((l) => JSON.parse(l).message), ["contoso 1", "all tenants"]);
  assert.equal(lines[2], "{not json");
  assert.ok(text.endsWith("\n"));
  assert.equal(log.dropTenant("acme"), 0);
  assert.equal(log.dropTenant(""), 0);
  assert.deepEqual(log.readAll({ tenants: ["acme"] }), []);
  assert.equal(log.readAll({ tenants: ["contoso"] }).length, 1);
});
