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
    res.status(500).type("text/plain").send(`Could not start sign-in: ${err.message}`);
  }
}

// Only people assigned an app role get in: Admin, User, or a per-customer
// Admin-<key> / User-<key> (access.js). A token without one means the
// Enterprise App does not require assignment; refuse it rather than letting
// the whole tenant read the dashboard.

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
      audit.record(req, { action: "sign-in-refused", user: claims.preferred_username || "unknown", detail: "no dashboard app role" });
      return res.redirect("/login.html?error=no-role");
    }
    req.session.regenerate((err) => {
      if (err) return res.status(500).type("text/plain").send("Sign-in failed: could not start a session");
      req.session.user = {
        name: claims.name || claims.preferred_username || "unknown",
        upn: claims.preferred_username || null,
        roles,
        via: "sso",
      };
      audit.record(req, { action: "sign-in" });
      res.redirect("/");
    });
  } catch (err) {
    console.error("SSO: sign-in failed:", err);
    res.status(500).type("text/plain").send(`Sign-in failed: ${err.message}`);
  }
}

// Wrong local passwords per client address: after LOGIN_MAX_FAILURES in
// LOGIN_WINDOW_MS that address must wait until the window ends.
const LOGIN_MAX_FAILURES = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map();

function loginBlockedFor(ip) {
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= Date.now()) return 0;
  return entry.count >= LOGIN_MAX_FAILURES ? entry.resetAt - Date.now() : 0;
}

function recordLoginFailure(ip) {
  const now = Date.now();
  if (loginFailures.size > 10000) {
    for (const [key, e] of loginFailures) if (e.resetAt <= now) loginFailures.delete(key);
  }
  const entry = loginFailures.get(ip);
  if (!entry || entry.resetAt <= now) loginFailures.set(ip, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  else entry.count++;
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
  const { username, password } = req.body || {};
  if (username !== "admin" || typeof password !== "string" || !timingSafeEquals(password, expected)) {
    recordLoginFailure(ip);
    audit.record(req, { action: "sign-in-failed", user: String(username || "").slice(0, 100) || "unknown", detail: "local admin: wrong username or password" });
    return res.status(401).json({ error: "wrong username or password" });
  }
  loginFailures.delete(ip);
  // A fresh session ID on sign-in, so an ID planted before it is worth nothing.
  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: "could not start a session" });
    req.session.user = { name: "admin", upn: null, roles: ["Admin"], via: "local" };
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

const EXEMPT_PREFIXES = ["/auth/", "/api/me", "/login.html", "/login.js"];

function requireAuth(req, res, next) {
  if (EXEMPT_PREFIXES.some((p) => req.path.startsWith(p))) return next();
  if (!ssoConfigured() && !localAdminConfigured()) {
    const message = "No sign-in configured yet. Set DASHBOARD_ADMIN_PASSWORD (quick local admin login) and/or DASHBOARD_AZURE_* (SSO) in .env.";
    if (req.path.startsWith("/api/")) return res.status(503).json({ error: message });
    return res.status(503).send(message);
  }
  if (req.session && req.session.user) return next();
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
};
