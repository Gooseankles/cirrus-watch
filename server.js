require("dotenv").config();
const express = require("express");
const session = require("express-session");
const path = require("path");
const log = require("./src/log");
const auth = require("./src/auth");
const settings = require("./src/settings");
const { testSpn } = require("./src/credentials");
const { FileSessionStore } = require("./src/sessionStore");
const { registerScanTool, registerActionTool } = require("./src/toolRegistry");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

// Security headers on every response. The pages load only their own scripts
// (no inline script); inline style attributes are used for bar widths.
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
      "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  if (req.secure) res.set("Strict-Transport-Security", "max-age=31536000");
  next();
});
// App Service ends HTTPS at its front end and forwards plain HTTP, so trust
// its X-Forwarded-Proto to allow Secure cookies.
function sessionStore() {
  try {
    return new FileSessionStore();
  } catch (err) {
    console.warn(`Sign-ins kept in memory only (lost on restart): cannot use the sessions folder: ${err.message}`);
    return undefined;
  }
}

const httpsSite =(process.env.DASHBOARD_REDIRECT_URI || "").startsWith("https://");
if (httpsSite) app.set("trust proxy", 1);
app.use(
  session({
    store: sessionStore(),
    secret: process.env.SESSION_SECRET || "dev-only-change-me",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 8 * 60 * 60 * 1000, httpOnly: true, sameSite: "lax", secure: httpsSite },
  })
);

const PORT = process.env.PORT || 7070;
// Shown bottom-left in the sidebar; bump VERSION by hand (major.minor.revision.package).
const VERSION = (() => {
  try {
    return require("fs").readFileSync(path.join(__dirname, "VERSION"), "utf8").trim();
  } catch {
    return "dev";
  }
})();

// Sign-in routes (exempt from requireAuth below) and whoami.
app.get("/auth/login", auth.startLogin);
app.get("/auth/callback", auth.handleCallback);
app.post("/auth/local-login", auth.handleLocalLogin);
app.get("/auth/logout", auth.handleLogout);
app.get("/api/me", (req, res) => {
  const user = req.session && req.session.user;
  res.json({
    ssoConfigured: auth.ssoConfigured(),
    localAdminConfigured: auth.localAdminConfigured(),
    signedIn: Boolean(user),
    name: user ? user.name : null,
    roles: user ? user.roles : [],
    isAdmin: Boolean(user && user.roles.includes("Admin")),
    version: VERSION,
  });
});

// Everything below this line needs a signed-in session (auth/me routes are
// exempted inside requireAuth itself).
app.use(auth.requireAuth);
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/settings", auth.requireRole("Admin"), (req, res) => {
  res.json(settings.getAll());
});
app.post("/api/settings", auth.requireRole("Admin"), (req, res) => {
  try {
    res.json(settings.setMany(req.body || {}));
  } catch (err) {
    console.error(`Saving settings failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/settings/test-spn", auth.requireRole("Admin"), async (req, res) => {
  const toolId = (req.body && req.body.toolId) || null;
  if (toolId && !settings.TOOL_SPNS.some((t) => t.id === toolId)) {
    return res.status(400).json({ ok: false, error: "unknown tool" });
  }
  res.json(await testSpn(toolId));
});

const registeredTools = [
  registerScanTool(app, require("./src/tools/orphanedResources")),
  registerScanTool(app, require("./src/tools/tagCompliance")),
  registerScanTool(app, require("./src/tools/costAnomaly")),
  registerScanTool(app, require("./src/tools/accessReview")),
  registerScanTool(app, require("./src/tools/secretExpiry")),
  registerScanTool(app, require("./src/tools/keyVault")),
  registerScanTool(app, require("./src/tools/accessPackages")),
  registerScanTool(app, require("./src/tools/roleAssignments")),
  registerScanTool(app, require("./src/tools/policyCheck")),
  registerActionTool(app, require("./src/tools/accessLookup")),
];

app.get("/api/tools", (req, res) => res.json(registeredTools));
app.get("/api/storage", (req, res) => res.json(require("./src/findingsStore").where()));

// Cost history: every subscription's daily cost plus monthly by service and
// resource group, kept in the history storage. Refreshed nightly.
const costHistory = require("./src/costHistory");
app.get("/api/cost/history", async (req, res) => {
  try {
    res.json({ ...(await costHistory.index()), running: costHistory.isRunning() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.get("/api/cost/history/:subscriptionId", async (req, res) => {
  if (!GUID.test(req.params.subscriptionId)) return res.status(400).json({ error: "not a subscription ID" });
  try {
    const doc = await costHistory.subscription(req.params.subscriptionId);
    if (!doc) return res.status(404).json({ error: "no cost history for that subscription yet" });
    res.json({ ...doc, summary: costHistory.summarize(doc) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/cost/history/refresh", auth.requireRole("Admin"), (req, res) => {
  res.status(202).json({ status: costHistory.isRunning() ? "already running" : "started" });
  costHistory.collectAll().catch((err) => log.record({ tool: "cost-anomaly", level: "error", message: `cost history: ${err.message}` }));
});
require("node-cron").schedule("30 7 * * *", () => costHistory.collectAll().catch((err) =>
  log.record({ tool: "cost-anomaly", level: "error", message: `cost history: ${err.message}` })
));

app.get("/api/logs", (req, res) => {
  res.json(log.readAll({ limit: Number(req.query.limit) || 200 }));
});

app.listen(PORT, () => {
  console.log(`Azure tools dashboard: http://localhost:${PORT}`);
});
