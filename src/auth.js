// Two ways in:
//  1. "Sign in with Microsoft" — an Entra ID Enterprise App (confidential
//     client, auth code flow via MSAL). Roles come from the App Roles the
//     tenant admin assigns people to in Enterprise Applications > Users and
//     groups — this app never manages membership itself, it only reads the
//     `roles` claim off the ID token.
//  2. A single built-in local admin account, for first running this before
//     the Enterprise App exists (or as a break-glass login if Entra is
//     unreachable). Username is always "admin"; see DASHBOARD_ADMIN_PASSWORD
//     in .env.
const crypto = require("crypto");
const msal = require("@azure/msal-node");
const { ManagedIdentityCredential } = require("@azure/identity");
const { hasSignInRole } = require("./access");
const audit = require("./audit");

const TENANT_ID = process.env.DASHBOARD_AZURE_TENANT_ID || process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.DASHBOARD_AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.DASHBOARD_AZURE_CLIENT_SECRET;
// Secretless option: a user-assigned managed identity that the sign-in app
// registration trusts through a federated credential.
const FEDERATED_MI_CLIENT_ID = process.env.DASHBOARD_FEDERATED_MI_CLIENT_ID;

const cryptoProvider = new msal.CryptoProvider();

function port() {
  return process.env.PORT || 7070;
}
function redirectUri() {
  return process.env.DASHBOARD_REDIRECT_URI || `http://localhost:${port()}/auth/callback`;
}

const SCOPES = ["openid", "profile"];

function ssoConfigured() {
  return Boolean(TENANT_ID && CLIENT_ID && (FEDERATED_MI_CLIENT_ID || CLIENT_SECRET));
}

function siteOrigin() {
  return new URL(redirectUri()).origin;
}

function clientCredentialConfig() {
  if (!FEDERATED_MI_CLIENT_ID) return { clientSecret: CLIENT_SECRET };
  const mi = new ManagedIdentityCredential({ clientId: FEDERATED_MI_CLIENT_ID });
  return {
    clientAssertion: async () => {
      try {
        return (await mi.getToken("api://AzureADTokenExchange/.default")).token;
      } catch (err) {
        console.error(`SSO: managed identity ${FEDERATED_MI_CLIENT_ID} gave no token:`, err);
        throw new Error(
          `the user-assigned managed identity with client ID ${FEDERATED_MI_CLIENT_ID} (DASHBOARD_FEDERATED_MI_CLIENT_ID) gave no token. ` +
            `Check that it is attached to this web app (Identity > User assigned) and that the value is its Client ID, not its Object ID. ` +
            `Azure said: ${err.message}`
        );
      }
    },
  };
}

function localAdminConfigured() {
  return Boolean(process.env.DASHBOARD_ADMIN_PASSWORD);
}

let msalClient = null;
function getMsalClient() {
  if (!ssoConfigured()) return null;
  if (!msalClient) {
    msalClient = new msal.ConfidentialClientApplication({
      auth: {
        clientId: CLIENT_ID,
        authority: `https://login.microsoftonline.com/${TENANT_ID}`,
        ...clientCredentialConfig(),
      },
    });
  }
  return msalClient;
}

function timingSafeEquals(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function startLogin(req, res) {
  const client = getMsalClient();
  if (!client) return res.status(500).send("SSO is not configured (DASHBOARD_AZURE_* missing in .env).");
  try {
    // state ties the callback to this browser's session; PKCE ties the code to it.
    const state = cryptoProvider.createNewGuid();
    const { verifier, challenge } = await cryptoProvider.generatePkceCodes();
    req.session.authFlow = { state, verifier };
    const url = await client.getAuthCodeUrl({
      scopes: SCOPES,
      redirectUri: redirectUri(),
      state,
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
    });
    req.session.save(() => res.redirect(url));
  } catch (err) {
    signInError(req, res, "Could not start sign-in", err);
  }
}

// What MSAL or Entra said can name the tenant, the app or how the secret is set up; it goes to the server log
// under a short reference, and the browser gets a plain sentence with that reference.
function signInError(req, res, what, err) {
  const ref = crypto.randomBytes(4).toString("hex");
  // The header comes from the request, so only id characters go into the log, and never as the format string.
  const upstream = String((req.get && (req.get("x-arr-log-id") || req.get("x-ms-request-id"))) || "").replace(/[^\w.-]/g, "").slice(0, 64);
  console.error("%s", `SSO: ${what.toLowerCase()} (ref ${ref}${upstream ? `, request ${upstream}` : ""}${err && err.correlationId ? `, correlation ${err.correlationId}` : ""}):`, err);
  res.status(500).type("text/plain").send(`${what}. Try again; if it keeps failing, ask an admin to look for reference ${ref} in the server log.`);
}

// Only people assigned an app role get in: Admin, User, a per-customer
// Admin-<key> / User-<key>, or an area role such as Security.Read (access.js). A token without one means the
// Enterprise App does not require assignment; refuse it rather than letting
// the whole tenant read the dashboard.

// The ID token's oid and tid claims, when they are strings.
function idsOf(claims) {
  const pick = (v) => (typeof v === "string" && v ? v.slice(0, 64) : undefined);
  const out = {};
  if (pick(claims.oid)) out.oid = pick(claims.oid);
  if (pick(claims.tid)) out.tid = pick(claims.tid);
  return out;
}

async function handleCallback(req, res) {
  const client = getMsalClient();
  if (!client) return res.status(500).send("SSO is not configured (DASHBOARD_AZURE_* missing in .env).");
  const flow = req.session.authFlow;
  delete req.session.authFlow;
  if (req.query.error) {
    // Plain text: the description comes from the query string.
    return res.status(403).type("text/plain").send(`Sign-in was refused: ${String(req.query.error_description || req.query.error).slice(0, 300)}`);
  }
  if (!flow || typeof req.query.state !== "string" || !timingSafeEquals(req.query.state, flow.state)) {
    return res.redirect("/login.html");
  }
  try {
    const result = await client.acquireTokenByCode({
      code: req.query.code,
      scopes: SCOPES,
      redirectUri: redirectUri(),
      codeVerifier: flow.verifier,
    });
    const claims = result.idTokenClaims || {};
    const roles = Array.isArray(claims.roles) ? claims.roles : [];
    if (!hasSignInRole(roles)) {
      console.warn(`SSO: refused ${claims.preferred_username || "unknown"}: no dashboard app role in the token`);
      audit.record(req, { action: "sign-in-refused", user: claims.preferred_username || "unknown", ...idsOf(claims), detail: "no dashboard app role" });
      return res.redirect("/login.html?error=no-role");
    }
    req.session.regenerate((err) => {
      if (err) return res.status(500).type("text/plain").send("Sign-in failed: could not start a session");
      req.session.user = {
        name: claims.name || claims.preferred_username || "unknown",
        upn: claims.preferred_username || null,
        // Entra object and tenant ID: for audit lines only (a UPN can be renamed); access still comes from roles.
        oid: idsOf(claims).oid || null,
        tid: idsOf(claims).tid || null,
        roles,
        via: "sso",
        signedInAt: Date.now(),
      };
      audit.record(req, { action: "sign-in" });
      res.redirect("/");
    });
  } catch (err) {
    signInError(req, res, "Sign-in failed", err);
  }
}

// Wrong local passwords per client address: after LOGIN_MAX_FAILURES in
// LOGIN_WINDOW_MS that address must wait until the window ends.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
// At most this many addresses are remembered (a guess from very many addresses); the oldest is forgotten first.
const LOGIN_MAX_ADDRESSES = 10000;
const loginFailures = new Map();
// And across all addresses, against a guess spread over many addresses that each stay under their own limit:
// after LOGIN_GLOBAL_MAX_FAILURES wrong passwords in one LOGIN_WINDOW_MS from all addresses together, every
// address that sent a wrong password in that window is refused until the window ends, even with the right
// password, and a new address gets one try before it is refused too. An address with no wrong password in the
// window still signs in, so the break-glass login stays usable from the admin's own machine while someone else
// is guessing; closing it for every address would let anyone keep it closed with 50 requests every 15 minutes.
// Further failures do not extend the window. Sign in with Microsoft is not affected.
const LOGIN_GLOBAL_MAX_FAILURES = 50;
let globalFailures = { count: 0, resetAt: 0 };

// Milliseconds the cap across all addresses still holds, or 0.
function globalLockFor(now = Date.now()) {
  if (globalFailures.resetAt <= now) return 0;
  return globalFailures.count >= LOGIN_GLOBAL_MAX_FAILURES ? globalFailures.resetAt - now : 0;
}

// This address's wrong passwords in the current window, or null.
function failuresOf(ip, now = Date.now()) {
  const entry = loginFailures.get(ip);
  return entry && entry.resetAt > now ? entry : null;
}

function loginBlockedFor(ip) {
  const entry = failuresOf(ip);
  return entry && entry.count >= LOGIN_MAX_FAILURES ? entry.resetAt - Date.now() : 0;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  if (loginFailures.size >= LOGIN_MAX_ADDRESSES && !loginFailures.has(ip)) {
    for (const [key, e] of loginFailures) if (e.resetAt <= now) loginFailures.delete(key);
    // Still full (that many addresses in one window): forget the oldest; a Map keeps insertion order.
    while (loginFailures.size >= LOGIN_MAX_ADDRESSES) loginFailures.delete(loginFailures.keys().next().value);
  }
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else entry.count++;
  if (globalFailures.resetAt <= now) globalFailures = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  globalFailures.count++;
  // true once, on the failure that reaches the cap (audited by the caller).
  return globalFailures.count === LOGIN_GLOBAL_MAX_FAILURES;
}

// App Service's front end puts "ip:port" in X-Forwarded-For, and the port
// changes with every connection; without stripping it each try would count
// as a new address and the limit would never bite.
function clientIp(req) {
  const ip = String(req.ip || "");
  const v6 = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (v6) return v6[1];
  return /^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(ip) ? ip.replace(/:\d+$/, "") : ip;
}

function handleLocalLogin(req, res) {
  const expected = process.env.DASHBOARD_ADMIN_PASSWORD;
  if (!expected) return res.status(500).json({ error: "local admin account is not configured" });
  const ip = clientIp(req);
  const wait = loginBlockedFor(ip);
  if (wait) {
    res.set("Retry-After", String(Math.ceil(wait / 1000)));
    return res.status(429).json({ error: `too many wrong passwords; try again in ${Math.ceil(wait / 60000)} minute(s)` });
  }
  const locked = globalLockFor();
  if (locked && failuresOf(ip)) {
    res.set("Retry-After", String(Math.ceil(locked / 1000)));
    return res.status(429).json({ error: `the local admin login is closed for this address for ${Math.ceil(locked / 60000)} minute(s): too many wrong passwords from many addresses; use Sign in with Microsoft or try again later` });
  }
  const { username, password } = req.body || {};
  if (username !== "admin" || typeof password !== "string" || !timingSafeEquals(password, expected)) {
    const capped = recordLoginFailure(ip);
    audit.record(req, { action: "sign-in-failed", user: String(username || "").slice(0, 100) || "unknown", detail: "local admin: wrong username or password" });
    if (capped) {
      const until = new Date(globalFailures.resetAt).toISOString();
      console.warn(`Local admin login: ${LOGIN_GLOBAL_MAX_FAILURES} wrong passwords from all addresses in ${LOGIN_WINDOW_MS / 60000} minutes; every address with a wrong password is refused until ${until}`);
      audit.record(req, { action: "sign-in-locked", user: "admin", detail: `local admin login closed until ${until} for every address with a wrong password: ${LOGIN_GLOBAL_MAX_FAILURES} wrong passwords in ${LOGIN_WINDOW_MS / 60000} minutes from all addresses` });
    }
    return res.status(401).json({ error: "wrong username or password" });
  }
  loginFailures.delete(ip);
  // A fresh session ID on sign-in, so an ID planted before it is worth nothing.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "could not start a session" });
    req.session.user = { name: "admin", upn: null, roles: ["Admin"], via: "local", signedInAt: Date.now() };
    audit.record(req, { action: "sign-in" });
    res.json({ ok: true });
  });
}

function handleLogout(req, res) {
  const user = req.session && req.session.user;
  if (user) audit.record(req, { action: "sign-out" });
  req.session.destroy(() => {
    if (user && user.via === "sso" && ssoConfigured()) {
      const postLogout = encodeURIComponent(`${siteOrigin()}/`);
      return res.redirect(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${postLogout}`);
    }
    res.redirect("/");
  });
}

// Exact paths only, and nothing under /api/: a prefix would also let a later
// route that starts the same through without a sign-in.
const EXEMPT_PATHS = new Set(["/auth/login", "/auth/callback", "/auth/local-login", "/auth/logout", "/auth/methods", "/login.html", "/login.js"]);

// A sign-in ends after 8 idle hours (the rolling cookie in server.js) and at the latest this long after signing in,
// so a tab left open (it polls) does not stay signed in for ever.
const MAX_SIGN_IN_MS = 24 * 60 * 60 * 1000;

function signInExpired(req) {
  const u = req.session.user;
  if (!u.signedInAt) u.signedInAt = Date.now(); // signed in before this rule: counts from now
  return Date.now() - u.signedInAt > MAX_SIGN_IN_MS;
}

function requireAuth(req, res, next) {
  if (EXEMPT_PATHS.has(req.path)) return next();
  if (!ssoConfigured() && !localAdminConfigured()) {
    const message = "No sign-in configured yet. Set DASHBOARD_ADMIN_PASSWORD (quick local admin login) and/or DASHBOARD_AZURE_* (SSO) in .env.";
    if (req.path.startsWith("/api/")) return res.status(503).json({ error: message });
    return res.status(503).send(message);
  }
  if (req.session && req.session.user) {
    if (!signInExpired(req)) return next();
    return req.session.destroy(() => (req.path.startsWith("/api/") ? res.status(401).json({ error: "sign in again (signed in over 24 hours ago)" }) : res.redirect("/login.html")));
  }
  if (req.path.startsWith("/api/")) return res.status(401).json({ error: "sign in required" });
  return res.redirect("/login.html");
}

function requireRole(role) {
  return (req, res, next) => {
    const user = req.session && req.session.user;
    if (!user) return res.status(401).json({ error: "sign in required" });
    if (!user.roles.includes(role)) return res.status(403).json({ error: `requires the ${role} role` });
    next();
  };
}

module.exports = {
  ssoConfigured,
  localAdminConfigured,
  startLogin,
  handleCallback,
  handleLocalLogin,
  handleLogout,
  requireAuth,
  requireRole,
  _test: {
    EXEMPT_PATHS,
    LOGIN_MAX_FAILURES,
    LOGIN_GLOBAL_MAX_FAILURES,
    LOGIN_MAX_ADDRESSES,
    LOGIN_WINDOW_MS,
    signInError,
    recordLoginFailure,
    addressCount: () => loginFailures.size,
    resetLoginLimits() {
      loginFailures.clear();
      globalFailures = { count: 0, resetAt: 0 };
    },
  },
};
