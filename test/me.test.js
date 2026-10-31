// GET /api/me needs a session; meReply still gives nothing away without a user
// (a second guard). The app version is for signed-in people only.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const { meReply } = require("../src/me");

after(env.cleanup);

test("not signed in: how to sign in, but no version, roles or tenants", () => {
  const r = meReply(undefined, "0.64.1.0");
  assert.equal(r.signedIn, false);
  assert.equal(r.version, null);
  assert.deepEqual(r.roles, []);
  assert.deepEqual(r.tenants, []);
  assert.equal(typeof r.ssoConfigured, "boolean");
  assert.equal(typeof r.localAdminConfigured, "boolean");
  assert.equal(JSON.stringify(r).includes("0.64.1.0"), false);
});

test("signed in: the version is there for the sidebar", () => {
  const r = meReply({ name: "admin", upn: null, roles: ["Admin"], via: "local" }, "0.64.1.0");
  assert.equal(r.signedIn, true);
  assert.equal(r.version, "0.64.1.0");
  assert.equal(r.isAdmin, true);
});
