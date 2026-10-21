// What a signed-in person may see and do, from their app roles:
//   Admin           everything: every tenant, Run now, Settings
//   User            read every tenant
//   Admin-<key>     read tenant <key> and run its scans
//   User-<key>      read tenant <key>
// <key> is a customer tenant's key, or "home" for the tenant the dashboard
// runs in. Role values are matched without regard to case.
const tenants = require("./tenants");

const CUSTOMER_ROLE = /^(admin|user)-(.+)$/i;

function accessOf(user) {
  const roles = (user && Array.isArray(user.roles) ? user.roles : []).map(String);
  const admin = roles.includes("Admin");
  const readAll = admin || roles.includes("User");
  const readKeys = new Set();
  const adminKeys = new Set();
  for (const r of roles) {
    const m = CUSTOMER_ROLE.exec(r);
    if (!m) continue;
    const key = m[2].toLowerCase();
    readKeys.add(key);
    if (m[1].toLowerCase() === "admin") adminKeys.add(key);
  }
  return { admin, readAll, readKeys, adminKeys, canRun: admin || adminKeys.size > 0 };
}

function hasSignInRole(roles) {
  return (roles || []).some((r) => r === "Admin" || r === "User" || CUSTOMER_ROLE.test(String(r)));
}

function narrow(keys, wanted) {
  if (!wanted) return keys;
  const w = String(wanted).toLowerCase();
  if (keys && !keys.includes(w)) return [];
  return [w];
}

// Tenant keys the request may read (null = all), narrowed by ?tenant=.
function readScope(req) {
  const acc = accessOf(req.session && req.session.user);
  return narrow(acc.readAll ? null : [...acc.readKeys], req.query && req.query.tenant);
}

// Tenant keys the request may run scans in (null = all), narrowed by
// ?tenant= or body.tenant; [] = none.
function runScope(req) {
  const acc = accessOf(req.session && req.session.user);
  const wanted = (req.body && req.body.tenant) || (req.query && req.query.tenant);
  return narrow(acc.admin ? null : [...acc.adminKeys], wanted);
}

function inScope(keys, tenantKey) {
  return keys === null || keys.includes(tenantKey || tenants.HOME);
}

// Middleware: some Run now right (global Admin or Admin-<key>).
function requireRunner(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return res.status(401).json({ error: "sign in required" });
  if (!accessOf(user).canRun) return res.status(403).json({ error: "requires the Admin role (or Admin-<customer>)" });
  next();
}

// Tenants the person can see, for the page's tenant picker.
function visibleTenants(user) {
  const acc = accessOf(user);
  return tenants
    .all()
    .filter((t) => acc.readAll || acc.readKeys.has(t.key))
    .map((t) => ({ key: t.key, name: t.name, home: Boolean(t.home), enabled: t.enabled, canRun: acc.admin || acc.adminKeys.has(t.key) }));
}

module.exports = { accessOf, hasSignInRole, readScope, runScope, inScope, requireRunner, visibleTenants };
