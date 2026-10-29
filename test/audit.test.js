// The audit log keeps who removed, reset or restored which tenant, with what
// the removal did (req.auditDetail) and the response status.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("events");

const env = require("./_env");
const audit = require("../src/audit");

after(env.cleanup);

function matchRule(method, path, req = {}) {
  for (const [m, re, make] of audit._test.RULES) {
    if (m !== method) continue;
    const match = re.exec(path);
    if (match) return make(match, req);
  }
  return null;
}

test("the tenant routes have audit rules", () => {
  assert.deepEqual(matchRule("POST", "/api/tenants/acme/remove"), { action: "remove-tenant", target: "acme" });
  assert.deepEqual(matchRule("POST", "/api/tenants/acme/restore"), { action: "restore-tenant", target: "acme" });
  assert.deepEqual(matchRule("DELETE", "/api/tenants/acme"), { action: "reset-tenant", target: "acme" });
  assert.deepEqual(matchRule("POST", "/api/tenants/acme/test"), { action: "test-tenant", target: "acme" });
  assert.deepEqual(matchRule("POST", "/api/tenants", { body: { key: "acme" } }), { action: "save-tenant", target: "acme" });
  assert.equal(matchRule("GET", "/api/tenants"), null, "reading the list is not logged");
});

// A request through the middleware, with the response finishing at `status`.
function send(method, path, { user, status = 200, detail, body } = {}) {
  const req = { method, path, body: body || {}, query: {}, ip: "127.0.0.1", session: user ? { user } : {} };
  const res = new EventEmitter();
  res.statusCode = status;
  let passed = false;
  audit.middleware(req, res, () => { passed = true; });
  assert.equal(passed, true);
  if (detail !== undefined) req.auditDetail = detail; // the route sets it after running
  res.emit("finish");
}

test("a removal is recorded with who, what and the detail the route adds", () => {
  const admin = { upn: "admin@example.com", name: "Admin", via: "sso" };
  send("POST", "/api/tenants/acme/remove", { user: admin, detail: "tenant entry: removed from the list | client secret: deleted and purged from the key vault" });
  send("POST", "/api/tenants/acme/remove", { user: { upn: "c@contoso.com", roles: ["Admin-contoso"] }, status: 403 });
  send("POST", "/api/tenants/contoso/restore", { user: admin });
  send("DELETE", "/api/tenants/fabrikam", { user: admin });
  send("POST", "/api/tenants/acme/remove", { user: admin, status: 500, detail: "x".repeat(1500) });
  const entries = audit.readAll({ limit: 10 }).reverse(); // oldest first
  assert.equal(entries.length, 5);
  assert.equal(entries[0].action, "remove-tenant");
  assert.equal(entries[0].target, "acme");
  assert.equal(entries[0].user, "admin@example.com");
  assert.equal(entries[0].status, 200);
  assert.match(entries[0].detail, /^tenant entry: removed from the list \| client secret: deleted and purged/);
  assert.equal(entries[0].tenant, undefined, "the key is the target, not a tenant filter");
  assert.deepEqual([entries[1].action, entries[1].status, entries[1].user], ["remove-tenant", 403, "c@contoso.com"]);
  assert.deepEqual([entries[2].action, entries[2].target], ["restore-tenant", "contoso"]);
  assert.deepEqual([entries[3].action, entries[3].target], ["reset-tenant", "fabrikam"]);
  const long = entries[4];
  assert.equal(long.status, 500);
  assert.equal(long.detail.length, 1000, "the detail is clipped");
  assert.ok(audit.readAll({ action: "remove-tenant" }).every((e) => e.action === "remove-tenant"));
});
