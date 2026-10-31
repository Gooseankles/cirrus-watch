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

// requireAuth with a request for `path` and no session.
function anon(path) {
  const req = { path, session: {} };
  const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json() { return this; }, send() { return this; }, redirect() { this.statusCode = 302; return this; } };
  let passed = false;
  auth.requireAuth(req, res, () => { passed = true; });
  return { passed, status: res.statusCode };
}

function withPassword(value, fn) {
  const prev = process.env.DASHBOARD_ADMIN_PASSWORD;
  process.env.DASHBOARD_ADMIN_PASSWORD = value;
  const restore = () => {
    if (prev === undefined) delete process.env.DASHBOARD_ADMIN_PASSWORD;
    else process.env.DASHBOARD_ADMIN_PASSWORD = prev;
  };
  let out;
  try {
    out = fn();
  } catch (err) {
    restore();
    throw err;
  }
  return Promise.resolve(out).finally(restore);
}

test("only the exact sign-in paths skip the sign-in check, not paths that start the same", () =>
  withPassword("a-long-test-password-123", () => {
    for (const p of ["/auth/methods", "/auth/login", "/auth/callback", "/auth/local-login", "/auth/logout", "/login.html", "/login.js"]) {
      assert.equal(anon(p).passed, true, `${p} is exempt`);
    }
    for (const p of ["/api/me", "/api/metrics", "/api/members", "/api/me/tokens", "/auth/methods2", "/auth/anything-new", "/login.json"]) {
      const r = anon(p);
      assert.equal(r.passed, false, `${p} needs a sign-in`);
      assert.ok(r.status === 401 || r.status === 302, `${p} is refused (${r.status})`);
    }
  }));

// A local login attempt from `ip`; resolves with the status, body and headers.
function login(ip, password) {
  return new Promise((resolve) => {
    const req = { ip, body: { username: "admin", password }, session: { regenerate(cb) { cb(); } } };
    const res = {
      statusCode: 200,
      headers: {},
      set(k, v) { this.headers[k] = v; return this; },
      status(c) { this.statusCode = c; return this; },
      json(b) { resolve({ status: this.statusCode, body: b, headers: this.headers }); return this; },
    };
    auth.handleLocalLogin(req, res);
  });
}

test("after many wrong passwords from many addresses the guessing addresses are refused even with the right password; a clean address still gets in", () =>
  withPassword("the-right-password-1234", async () => {
    const audit = require("../src/audit");
    const { LOGIN_GLOBAL_MAX_FAILURES, LOGIN_MAX_FAILURES, resetLoginLimits } = auth._test;
    assert.ok(LOGIN_GLOBAL_MAX_FAILURES > LOGIN_MAX_FAILURES);
    resetLoginLimits();
    try {
      // One wrong try from each of many addresses: no address reaches its own limit.
      const guessers = [];
      for (let i = 0; i < LOGIN_GLOBAL_MAX_FAILURES; i++) {
        guessers.push(`10.1.${Math.floor(i / 250)}.${i % 250}`);
        assert.equal((await login(guessers[i], "wrong")).status, 401);
      }
      assert.equal(audit.readAll({ action: "sign-in-locked" }).length, 1, "the cap is audited once");
      // An address that guessed is refused now, even with the right password, with a plain message.
      const refused = await login(guessers[0], "the-right-password-1234");
      assert.equal(refused.status, 429);
      assert.match(refused.body.error, /closed for this address for \d+ minute\(s\)/);
      assert.ok(Number(refused.headers["Retry-After"]) > 0);
      // A new address gets one try: wrong, and it is refused like the others (no second audit line).
      assert.equal((await login("192.0.2.78", "wrong")).status, 401);
      assert.equal((await login("192.0.2.78", "the-right-password-1234")).status, 429);
      assert.equal(audit.readAll({ action: "sign-in-locked" }).length, 1);
      // Right, and the break-glass login works from an address that did not guess.
      assert.equal((await login("192.0.2.77", "the-right-password-1234")).status, 200);

      // A fresh window; the per-address limit still holds on its own.
      resetLoginLimits();
      assert.equal((await login("192.0.2.77", "the-right-password-1234")).status, 200);
      for (let i = 0; i < LOGIN_MAX_FAILURES; i++) await login("198.51.100.9", "wrong");
      const perIp = await login("198.51.100.9", "the-right-password-1234");
      assert.equal(perIp.status, 429);
      assert.match(perIp.body.error, /too many wrong passwords/);
      assert.equal((await login("198.51.100.10", "the-right-password-1234")).status, 200, "one address's limit does not hold the others");
    } finally {
      resetLoginLimits();
    }
  }));

test("the table of addresses with wrong passwords is bounded; the oldest go first", () => {
  const { recordLoginFailure, addressCount, LOGIN_MAX_ADDRESSES, resetLoginLimits } = auth._test;
  resetLoginLimits();
  try {
    for (let i = 0; i < LOGIN_MAX_ADDRESSES + 500; i++) recordLoginFailure(`2001:db8::${i.toString(16)}`);
    assert.equal(addressCount(), LOGIN_MAX_ADDRESSES);
    recordLoginFailure("2001:db8::0"); // forgotten by now: counted afresh, no growth
    assert.equal(addressCount(), LOGIN_MAX_ADDRESSES);
  } finally {
    resetLoginLimits();
  }
});

test("an SSO error's detail goes to the server log, the browser gets a plain sentence", () => {
  const logged = [];
  const orig = console.error;
  console.error = (...a) => logged.push(a.map(String).join(" "));
  let sent = null;
  let code = 0;
  const res = { status(c) { code = c; return this; }, type() { return this; }, send(t) { sent = t; return this; } };
  try {
    const err = Object.assign(new Error("invalid_client: AADSTS7000215 secret for app 1234 in tenant contoso.onmicrosoft.com"), { correlationId: "corr-1" });
    auth._test.signInError({ get: (h) => (h === "x-arr-log-id" ? "arr-42" : undefined) }, res, "Sign-in failed", err);
  } finally {
    console.error = orig;
  }
  assert.equal(code, 500);
  assert.equal(sent.includes("AADSTS"), false);
  assert.equal(sent.includes("contoso"), false);
  const ref = /reference ([0-9a-f]{8})/.exec(sent);
  assert.ok(ref, sent);
  assert.match(sent, /^Sign-in failed\. /);
  assert.equal(logged.length, 1);
  assert.match(logged[0], new RegExp(`ref ${ref[1]}, request arr-42, correlation corr-1`));
  assert.match(logged[0], /AADSTS7000215/);
});
