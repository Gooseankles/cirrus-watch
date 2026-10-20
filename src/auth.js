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

const TENANT_ID = process.env.DASHBOARD_AZURE_TENANT_ID || process.env.AZURE_TENANT_ID;
const CLIENT_ID = process.env.DASHBOARD_AZURE_CLIENT_ID;
const CLIENT_SECRET = process.env.DASHBOARD_AZURE_CLIENT_SECRET;

function port() {
  return process.env.PORT || 7070;
}
function redirectUri() {
  return process.env.DASHBOARD_REDIRECT_URI || `http://localhost:${port()}/auth/callback`;
}

const SCOPES = ["openid", "profile"];

function ssoConfigured() {
  return Boolean(TENANT_ID && CLIENT_ID && CLIENT_SECRET);
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
        clientSecret: CLIENT_SECRET,
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
    const url = await client.getAuthCodeUrl({ scopes: SCOPES, redirectUri: redirectUri() });
    res.redirect(url);
  } catch (err) {
    res.status(500).send(`Could not start sign-in: ${err.message}`);
  }
}

async function handleCallback(req, res) {
  const client = getMsalClient();
  if (!client) return res.status(500).send("SSO is not configured (DASHBOARD_AZURE_* missing in .env).");
  try {
    const result = await client.acquireTokenByCode({
      code: req.query.code,
      scopes: SCOPES,
      redirectUri: redirectUri(),
    });
    const claims = result.idTokenClaims || {};
    const roles = Array.isArray(claims.roles) ? claims.roles : [];
    req.session.user = {
      name: claims.name || claims.preferred_username || "unknown",
      upn: claims.preferred_username || null,
      roles,
      via: "sso",
    };
    res.redirect("/");
  } catch (err) {
    res.status(500).send(`Sign-in failed: ${err.message}`);
  }
}

function handleLocalLogin(req, res) {
  const expected = process.env.DASHBOARD_ADMIN_PASSWORD;
  if (!expected) return res.status(500).json({ error: "local admin account is not configured" });
  const { username, password } = req.body || {};
  if (username !== "admin" || typeof password !== "string" || !timingSafeEquals(password, expected)) {
    return res.status(401).json({ error: "wrong username or password" });
  }
  req.session.user = { name: "admin", upn: null, roles: ["Admin"], via: "local" };
  res.json({ ok: true });
}

function handleLogout(req, res) {
  const user = req.session && req.session.user;
  req.session.destroy(() => {
    if (user && user.via === "sso" && ssoConfigured()) {
      const postLogout = encodeURIComponent(`http://localhost:${port()}/`);
      return res.redirect(`https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/logout?post_logout_redirect_uri=${postLogout}`);
    }
    res.redirect("/");
  });
}

const EXEMPT_PREFIXES = ["/webhook/", "/auth/", "/api/me", "/login.html"];

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
