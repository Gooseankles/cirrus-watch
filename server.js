require("dotenv").config({ quiet: true });
const express = require("express");
const session = require("express-session");
const path = require("path");
const log = require("./src/log");
const auth = require("./src/auth");
const settings = require("./src/settings");
const secretStore = require("./src/secretStore");
const { testSpn, testTenant } = require("./src/credentials");
const tenants = require("./src/tenants");
const access = require("./src/access");
const audit = require("./src/audit");
const { needsOf } = require("./src/toolPermissions");
const { FileSessionStore } = require("./src/sessionStore");
const { registerScanTool, registerActionTool, readKeys, decorate } = require("./src/toolRegistry");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

// Security headers on every response. The pages load only their own scripts
// (no inline script); inline style attributes are used for bar widths.
app.use((req, res, next) => {
  res.set({
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; " +
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
    // rolling: every request moves the end 8 hours on, so a sign-in ends after 8 idle hours, not 8 hours after
    // signing in while someone is still using the page. The store only rewrites its file every few minutes.
    rolling: true,
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
  const acc = access.accessOf(user);
  res.json({
    ssoConfigured: auth.ssoConfigured(),
    localAdminConfigured: auth.localAdminConfigured(),
    signedIn: Boolean(user),
    name: user ? user.name : null,
    roles: user ? user.roles : [],
    isAdmin: Boolean(user && acc.admin),
    canRun: Boolean(user && acc.canRun),
    // Tenants this person may see; the page shows a tab per tenant when there is more than one.
    tenants: user ? access.visibleTenants(user) : [],
    multiTenant: Boolean(user) && tenants.isMultiTenant(),
    version: VERSION,
  });
});

// Everything below this line needs a signed-in session (auth/me routes are
// exempted inside requireAuth itself).
app.use(auth.requireAuth);
app.use(audit.middleware);
app.use(express.static(path.join(__dirname, "public")));

// ?tenant=<customer key> = that tenant's own tool settings; none or home = the
// home tenant's, which are also every customer's defaults.
function settingsTenant(req, res) {
  const key = String(req.query.tenant || "").toLowerCase();
  if (!key || key === tenants.HOME) return { key: null };
  if (!tenants.customers().some((t) => t.key === key)) {
    res.status(400).json({ error: "no such customer tenant" });
    return null;
  }
  return { key };
}
app.get("/api/settings", auth.requireRole("Admin"), (req, res) => {
  const t = settingsTenant(req, res);
  if (t) res.json(settings.getAll(t.key));
});
app.post("/api/settings", auth.requireRole("Admin"), async (req, res) => {
  const t = settingsTenant(req, res);
  if (!t) return;
  try {
    res.json(await settings.setMany(req.body || {}, t.key));
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

// Customer tenants (Settings).
const withStorage = (list) => {
  const store = require("./src/findingsStore");
  const blob = Boolean(settings.get("STORAGE_ACCOUNT_URL"));
  return list.map((t) => ({ ...t, container: blob ? store.containerName(t.key) : `tenants/${t.key}` }));
};
app.get("/api/tenants", auth.requireRole("Admin"), (req, res) => {
  res.json({ tenants: withStorage(tenants.listForSettings()) });
});
app.post("/api/tenants", auth.requireRole("Admin"), async (req, res) => {
  try {
    res.json({ tenants: withStorage(await tenants.upsert(req.body || {})) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.delete("/api/tenants/:key", auth.requireRole("Admin"), async (req, res) => {
  try {
    const list = await tenants.remove(req.params.key);
    const key = String(req.params.key).toLowerCase();
    if (!tenants.byKey(key)) await notify.drop(key).catch((err) => console.error(`Notifications: could not remove ${key}: ${err.message}`));
    res.json({ tenants: withStorage(list) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
// Notifications (Admin): each tenant's Teams or webhook link (?tenant=, blank
// = home). The link itself never comes back, only whether one is set.
const notify = require("./src/notify");
function notifyTenant(req, res) {
  const raw = Array.isArray(req.query.tenant) ? req.query.tenant[0] : req.query.tenant;
  const key = String(raw || tenants.HOME).toLowerCase();
  if (!tenants.byKey(key)) {
    res.status(400).json({ error: `no such tenant: "${key.slice(0, 60)}" (known: ${tenants.all().map((t) => t.key).join(", ")})` });
    return null;
  }
  return key;
}
app.get("/api/notify", auth.requireRole("Admin"), (req, res) => {
  const key = notifyTenant(req, res);
  if (key) res.json(notify.describe(key));
});
app.post("/api/notify", auth.requireRole("Admin"), async (req, res) => {
  const key = notifyTenant(req, res);
  if (!key) return;
  try {
    res.json(await notify.setLink(key, req.body || {}));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});
app.post("/api/notify/test", auth.requireRole("Admin"), async (req, res) => {
  const key = notifyTenant(req, res);
  if (key) res.json(await notify.sendTest(key));
});
notify.start();

app.post("/api/tenants/:key/test", auth.requireRole("Admin"), async (req, res) => {
  const t = tenants.customers().find((x) => x.key === String(req.params.key).toLowerCase());
  if (!t) return res.status(404).json({ ok: false, error: "no such tenant" });
  res.json(await testTenant(t));
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
  registerScanTool(app, require("./src/tools/internetExposure")),
  registerScanTool(app, require("./src/tools/endOfSupport")),
  registerScanTool(app, require("./src/tools/serviceRetirements")),
  registerScanTool(app, require("./src/tools/backupCoverage")),
  registerScanTool(app, require("./src/tools/resilience")),
  registerScanTool(app, require("./src/tools/resourceSettings")),
  registerScanTool(app, require("./src/tools/exposurePaths")),
  registerScanTool(app, require("./src/tools/diagnosticSettings")),
  registerScanTool(app, require("./src/tools/quotas")),
  registerScanTool(app, require("./src/tools/ipam")),
  registerScanTool(app, require("./src/tools/architecture")),
  registerScanTool(app, require("./src/tools/firewallPolicies")),
  registerScanTool(app, require("./src/tools/changeLog")),
  registerScanTool(app, require("./src/tools/privilegedRoles")),
  registerScanTool(app, require("./src/tools/pim")),
  registerScanTool(app, require("./src/tools/staleAccounts")),
  registerScanTool(app, require("./src/tools/mfaCoverage")),
  registerScanTool(app, require("./src/tools/conditionalAccess")),
  registerScanTool(app, require("./src/tools/appPermissions")),
  registerScanTool(app, require("./src/tools/licenceCoverage")),
  registerScanTool(app, require("./src/tools/defender")),
  registerScanTool(app, require("./src/tools/safetyNets")),
  registerScanTool(app, require("./src/tools/azureMonitor")),
  registerActionTool(app, require("./src/tools/accessLookup")),
];

for (const t of registeredTools) if (!needsOf(t.id)) console.warn(`[${t.id}] has no entry in src/toolPermissions.js`);
app.get("/api/tools", (req, res) => res.json(registeredTools.map((t) => ({ ...t, needs: needsOf(t.id) }))));
app.get("/api/storage", (req, res) => res.json(require("./src/findingsStore").where()));

// Monthly report over the tenants the person may see (?tenant= narrows):
// ?month=YYYY-MM, default this month.
app.get("/api/report", async (req, res) => {
  const thisMonth = new Date().toISOString().slice(0, 7);
  const month = String(req.query.month || thisMonth);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > thisMonth) return res.status(400).json({ error: "month must be YYYY-MM, not in the future" });
  try {
    const keys = readKeys(req);
    const scans = registeredTools.filter((t) => t.kind === "scan" && !t.info); // the change log is not a problem list
    const out = await require("./src/report").build(scans, month, keys, decorate);
    res.json({ ...out, tenants: keys.map((k) => ({ key: k, name: tenants.nameOf(k) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Weekly trends over the tenants the person may see (?tenant= narrows):
// ?weeks=4..52, default 12.
app.get("/api/trends", async (req, res) => {
  const weeks = Math.min(52, Math.max(4, Math.round(Number(req.query.weeks) || 12)));
  try {
    const keys = readKeys(req);
    const scans = registeredTools.filter((t) => t.kind === "scan" && !t.info);
    const out = await require("./src/trends").build(scans, keys, weeks);
    res.json({ ...out, tenants: keys.map((k) => ({ key: k, name: tenants.nameOf(k) })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.get("/api/secret-store", auth.requireRole("Admin"), (req, res) => res.json(secretStore.describe()));

// Cost history: every subscription's daily cost plus monthly by service and
// resource group, kept in each tenant's own history store. Refreshed nightly.
const costHistory = require("./src/costHistory");
app.get("/api/cost/history", async (req, res) => {
  try {
    const idx = await costHistory.index(readKeys(req));
    const multi = tenants.isMultiTenant();
    const name = (list) => (multi ? list.map((x) => ({ ...x, tenantName: tenants.nameOf(x.tenant) })) : list);
    res.json({ updatedAt: idx.updatedAt, subscriptions: name(idx.subscriptions), failures: name(idx.failures), running: costHistory.isRunning() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
app.get("/api/cost/history/:subscriptionId", async (req, res) => {
  if (!GUID.test(req.params.subscriptionId)) return res.status(400).json({ error: "not a subscription ID" });
  try {
    const doc = await costHistory.subscription(req.params.subscriptionId, readKeys(req));
    if (!doc) {
      return res.status(404).json({ error: "no cost history for that subscription yet" });
    }
    res.json({ ...doc, summary: costHistory.summarize(doc) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
app.post("/api/cost/history/refresh", access.requireRunner, (req, res) => {
  const keys = access.runScope(req);
  if (keys && !keys.length) return res.status(403).json({ error: "you cannot refresh that tenant" });
  res.status(202).json({ status: costHistory.isRunning() ? "already running" : "started" });
  costHistory.collectAll(keys).catch((err) => log.record({ tool: "cost-anomaly", level: "error", message: `cost history: ${err.message}` }));
});
require("node-cron").schedule("30 7 * * *", () => costHistory.collectAll().catch((err) =>
  log.record({ tool: "cost-anomaly", level: "error", message: `cost history: ${err.message}` })
));

app.post("/api/audit/page", audit.pageView);
// Audit log (Admin): who signed in, looked at what and changed what.
app.get("/api/audit", auth.requireRole("Admin"), (req, res) => {
  const since = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.since || "")) ? String(req.query.since) : null;
  const str = (k) => (typeof req.query[k] === "string" && req.query[k] ? req.query[k] : null);
  res.json({
    entries: audit.readAll({ limit: Math.min(Number(req.query.limit) || 500, 5000), user: str("user"), action: str("action"), since }),
    ...audit.facets(),
    retentionDays: audit.retentionDays(),
  });
});

// Server load (Admin): the dashboard's own CPU, memory and event-loop delay,
// with the scans that ran at the time, and any load alarm.
const monitor = require("./src/monitor");
monitor.setLabels(Object.fromEntries(registeredTools.map((t) => [t.id, t.label])));
monitor.start();
app.get("/api/monitor", auth.requireRole("Admin"), (req, res) => {
  res.json({ ...monitor.snapshot(), labels: Object.fromEntries(registeredTools.map((t) => [t.id, t.label]).concat([["cost-history", "Cost history"]])) });
});

app.get("/api/logs", (req, res) => {
  // Someone limited to some tenants sees only those tenants' entries. Server
  // load alarms are about the dashboard itself: global Admin only.
  const admin = access.accessOf(req.session && req.session.user).admin;
  res.json(log.readAll({ limit: Math.min(Number(req.query.limit) || 200, 1000), tenants: access.readScope(req), ...(!admin && { exclude: [monitor.TOOL] }) }));
});

// Secrets from the key vault (SECRET_VAULT_URL); any still in the JSON files
// move there once it can be read. Sign-in and the pages work meanwhile.
secretStore.onLoad(async () => {
  const moved = (await settings.moveSecretsToVault()) + (await tenants.moveSecretsToVault()) + (await notify.moveSecretsToVault());
  if (moved) console.log(`Secrets: moved ${moved} from the settings files into the key vault`);
});
secretStore.load();

app.listen(PORT, () => {
  console.log(`Azure tools dashboard: http://localhost:${PORT}`);
});
