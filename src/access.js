// What a signed-in person may see and do, from their app roles:
//   Admin                 everything: every tenant and area, Run now, Settings
//   User                  read every tenant and area
//   Admin-<key>           every area of tenant <key>: read and run its scans
//   User-<key>            every area of tenant <key>: read
//   <Area>.Read           read one area in every tenant
//   <Area>.Run            read one area in every tenant and run its scans
//   <Area>.Read-<key>     read one area in tenant <key>
//   <Area>.Run-<key>      read and run one area in tenant <key>
// Areas: Identity, Platform, Security, Cost. Every scan belongs to one or more
// (TOOL_AREAS). <key> is a customer tenant's key, or "home" for the tenant the
// dashboard runs in. Whoever may read a finding may also accept or snooze it.
// Role values are matched without regard to case, except Admin and User.
const tenants = require("./tenants");

const AREAS = ["identity", "platform", "security", "cost"];
const AREA_LABELS = { identity: "Identity", platform: "Platform", security: "Security", cost: "Cost" };

// The areas of each scan, page and log source. A tool missing here is seen only
// by the all-area roles (server.js warns at start-up).
const TOOL_AREAS = {
  "access-lookup": ["identity"],
  "access-review": ["identity"],
  "secret-expiry": ["identity"],
  "access-packages": ["identity"],
  "role-assignments": ["identity"],
  pim: ["identity"],
  "stale-accounts": ["identity"],
  "tenant-settings": ["identity"],
  "licence-coverage": ["identity"],
  "privileged-roles": ["identity", "security"],
  "app-permissions": ["identity", "security"],
  "conditional-access": ["identity", "security"],
  "mfa-coverage": ["identity", "security"],
  defender: ["security", "platform"],
  "internet-exposure": ["security", "platform"],
  "exposure-paths": ["security", "platform"],
  "firewall-policies": ["security", "platform"],
  "network-hygiene": ["security", "platform"],
  "key-vault": ["security", "platform"],
  "resource-settings": ["security", "platform"],
  "diagnostic-settings": ["security", "platform"],
  "change-log": ["security", "platform"],
  ipam: ["platform"],
  "tag-compliance": ["platform"],
  "end-of-support": ["platform"],
  "service-retirements": ["platform"],
  certificates: ["platform"],
  "backup-coverage": ["platform"],
  resilience: ["platform"],
  updates: ["platform"],
  "resource-health": ["platform"],
  architecture: ["platform"],
  "policy-check": ["platform"],
  "safety-nets": ["platform"],
  "azure-monitor": ["platform"],
  subscriptions: ["platform"],
  quotas: ["platform"],
  "orphaned-resources": ["platform", "cost"],
  "cost-anomaly": ["cost", "platform"],
  "cost-history": ["cost", "platform"],
};
// A tool ID or an area name, as the list of areas it stands for.
const areasOf = (id) => (AREAS.includes(id) ? [id] : TOOL_AREAS[id] || []);

const CUSTOMER_ROLE = /^(admin|user)-(.+)$/i;
const AREA_ROLE = new RegExp(`^(${AREAS.join("|")})\\.(read|run)(?:-(.+))?$`, "i");

// One role as a grant: area ("*" = all), tenant key ("*" = all), run rights.
function grantOf(role) {
  const r = String(role);
  if (r === "Admin") return { area: "*", key: "*", run: true };
  if (r === "User") return { area: "*", key: "*", run: false };
  let m = CUSTOMER_ROLE.exec(r);
  if (m) return { area: "*", key: m[2].toLowerCase(), run: m[1].toLowerCase() === "admin" };
  m = AREA_ROLE.exec(r);
  if (m) return { area: m[1].toLowerCase(), key: m[3] ? m[3].toLowerCase() : "*", run: m[2].toLowerCase() === "run" };
  return null;
}

function accessOf(user) {
  const roles = (user && Array.isArray(user.roles) ? user.roles : []).map(String);
  const grants = roles.map(grantOf).filter(Boolean);
  return { admin: roles.includes("Admin"), grants, canRun: grants.some((g) => g.run) };
}

function hasSignInRole(roles) {
  return (roles || []).some((r) => grantOf(r) !== null);
}

// Tenant keys (null = all) where the grants reach a tool or area `id` (read,
// or run when run is true). With id null only the all-area roles count.
function keysFor(acc, id, run) {
  const areas = id ? areasOf(id) : [];
  const fit = acc.grants.filter((g) => (g.area === "*" || areas.includes(g.area)) && (!run || g.run));
  if (fit.some((g) => g.key === "*")) return null;
  return [...new Set(fit.map((g) => g.key))];
}
const can = (acc, id, key, run) => {
  const keys = keysFor(acc, id, run);
  return keys === null || keys.includes(key);
};

function narrow(keys, wanted) {
  if (!wanted) return keys;
  const w = String(wanted).toLowerCase();
  if (keys && !keys.includes(w)) return [];
  return [w];
}

// Tenant keys the request may read for a tool or area (null = all), narrowed by ?tenant=.
function readScope(req, id) {
  return narrow(keysFor(accessOf(req.session && req.session.user), id, false), req.query && req.query.tenant);
}

// Tenant keys the request may run a tool's scans in (null = all), narrowed by
// ?tenant= or body.tenant; [] = none.
function runScope(req, id) {
  const wanted = (req.body && req.body.tenant) || (req.query && req.query.tenant);
  return narrow(keysFor(accessOf(req.session && req.session.user), id, true), wanted);
}

function inScope(keys, tenantKey) {
  return keys === null || keys.includes(tenantKey || tenants.HOME);
}

// Middleware: Run now rights for a tool or area in at least one tenant.
function requireRunner(id) {
  return (req, res, next) => {
    const user = req.session && req.session.user;
    if (!user) return res.status(401).json({ error: "sign in required" });
    const keys = keysFor(accessOf(user), id, true);
    if (keys !== null && !keys.length) return res.status(403).json({ error: "requires Admin, Admin-<customer> or the area's .Run role" });
    next();
  };
}

// A log line is shown when its tool may be read in its tenant. Lines with no
// tenant or no area (notifications, server load) need an all-area role.
function canReadLog(acc, entry) {
  if (!entry.tenant || !areasOf(entry.tool).length) return keysFor(acc, null, false) === null;
  return can(acc, entry.tool, entry.tenant, false);
}

// Tenants the person can see, for the page's tenant picker, with the areas
// they may read and run in each.
function visibleTenants(user) {
  const acc = accessOf(user);
  return tenants
    .all()
    .map((t) => ({ t, areas: AREAS.filter((a) => can(acc, a, t.key, false)), runAreas: AREAS.filter((a) => can(acc, a, t.key, true)) }))
    .filter((x) => x.areas.length)
    .map(({ t, areas, runAreas }) => ({ key: t.key, name: t.name, home: Boolean(t.home), enabled: t.enabled, canRun: runAreas.length > 0, areas, runAreas }));
}

module.exports = { AREAS, AREA_LABELS, TOOL_AREAS, areasOf, accessOf, hasSignInRole, readScope, runScope, inScope, requireRunner, canReadLog, visibleTenants };
