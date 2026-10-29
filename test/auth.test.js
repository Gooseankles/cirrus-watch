// Who may remove a tenant: the global Admin role, not a customer's own
// Admin-<key> role, and not someone who is not signed in.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const auth = require("../src/auth");

after(env.cleanup);

function run(middleware, user) {
  const req = { session: user ? { user } : {} };
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
  let passed = false;
  middleware(req, res, () => { passed = true; });
  return { passed, status: res.statusCode, body: res.body };
}

test("requireRole('Admin') lets the global Admin through", () => {
  const r = run(auth.requireRole("Admin"), { upn: "a@example.com", roles: ["Admin"] });
  assert.equal(r.passed, true);
});

test("a customer's own Admin-<key> role is not the Admin role", () => {
  const r = run(auth.requireRole("Admin"), { upn: "a@contoso.com", roles: ["Admin-contoso", "User-contoso"] });
  assert.equal(r.passed, false);
  assert.equal(r.status, 403);
  assert.deepEqual(r.body, { error: "requires the Admin role" });
});

test("no roles, or not signed in, is refused", () => {
  assert.equal(run(auth.requireRole("Admin"), { upn: "u@example.com", roles: ["User"] }).status, 403);
  const anon = run(auth.requireRole("Admin"), null);
  assert.equal(anon.passed, false);
  assert.equal(anon.status, 401);
});
