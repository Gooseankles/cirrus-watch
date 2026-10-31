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

test("an SSO user's oid and tid go into the line next to the UPN; a local admin has none", () => {
  const sso = { upn: "renamed@example.com", name: "Pat", via: "sso", oid: "00000000-0000-4000-8000-0000000000aa", tid: "00000000-0000-4000-8000-0000000000bb" };
  audit.record({ session: { user: sso }, ip: "10.0.0.1" }, { action: "sign-in" });
  audit.record({ session: { user: { name: "admin", upn: null, via: "local" } }, ip: "10.0.0.1" }, { action: "sign-in" });
  const [local, entry] = audit.readAll({ action: "sign-in", limit: 2 });
  assert.deepEqual([entry.user, entry.oid, entry.tid], ["renamed@example.com", sso.oid, sso.tid]);
  assert.equal(local.user, "admin");
  assert.equal("oid" in local || "tid" in local, false);
});

test("notification link changes and test sends are audited, never with the link itself", () => {
  const secretLink = "https://contoso.webhook.office.com/webhookb2/abc@def/IncomingWebhook/SECRETTOKEN123/xyz";
  assert.deepEqual(matchRule("POST", "/api/notify", { query: { tenant: "Contoso" }, body: { url: secretLink } }), {
    action: "change-notify",
    target: "contoso",
    detail: "set the link to a web link on contoso.webhook.office.com",
  });
  assert.deepEqual(matchRule("POST", "/api/notify", { query: {}, body: { clear: true } }), { action: "change-notify", target: "home", detail: "removed the link" });
  assert.deepEqual(matchRule("POST", "/api/notify/test", { query: { tenant: "fabrikam" } }), { action: "test-notify", target: "fabrikam" });
  assert.equal(matchRule("GET", "/api/notify", { query: {} }), null, "reading whether a link is set is not logged");

  assert.equal(audit.notifyLinkDetail({ url: secretLink }, true), "changed the link to a web link on contoso.webhook.office.com");
  assert.equal(audit.notifyLinkDetail({ url: "a@contoso.com, b@contoso.com" }, false), "set the link to 2 email addresses");
  assert.equal(audit.notifyLinkDetail({ url: "https://exa mple" }), "set the link to something that is not a valid link");
  assert.equal(audit.notifyLinkDetail({}), "no change");

  // Through the middleware: the route adds set / changed; the written line holds the host, not the token.
  const req = { method: "POST", path: "/api/notify", body: { url: secretLink }, query: { tenant: "contoso" }, ip: "127.0.0.1", session: { user: { upn: "admin@example.com" } } };
  const res = new EventEmitter();
  res.statusCode = 200;
  audit.middleware(req, res, () => {});
  req.auditDetail = audit.notifyLinkDetail(req.body, true);
  res.emit("finish");
  const [entry] = audit.readAll({ action: "change-notify", limit: 1 });
  assert.deepEqual([entry.target, entry.tenant, entry.status, entry.user], ["contoso", "contoso", 200, "admin@example.com"]);
  assert.equal(entry.detail, "changed the link to a web link on contoso.webhook.office.com");
  assert.equal(require("fs").readFileSync(audit._test.FILE, "utf8").includes("SECRETTOKEN123"), false);
});
