// Who looked at what and who changed what: sign-ins, scan pages, reports, cost
// history, access lookups, runs, accepts, settings and customer tenants. One
// JSON line per event in LOG_DIR/audit.jsonl, kept AUDIT_RETENTION_DAYS
// (default 365). Only Admin reads it. Setting values and secrets are never
// written, only which settings changed.
const fs = require("fs");
const path = require("path");

const { LOG_DIR } = require("./paths");
const FILE = path.join(LOG_DIR, "audit.jsonl");
const DAY = 86400000;
// The same person reading the same page again within this counts once.
const VIEW_GAP_MS = 10 * 60 * 1000;
const recentViews = new Map();
let prunedAt = 0;

const clip = (s, n = 200) => (s == null ? null : String(s).slice(0, n));

function retentionDays() {
  const n = Number(process.env.AUDIT_RETENTION_DAYS);
  return Number.isFinite(n) && n >= 30 ? Math.min(n, 3650) : 365;
}

function userOf(req) {
  const u = req && req.session && req.session.user;
  return u ? { user: u.upn || u.name || "unknown", name: u.name || null, via: u.via || null } : { user: null, name: null, via: null };
}

// Drops entries older than the retention, at most once a day.
function prune(now = Date.now()) {
  if (now - prunedAt < DAY || !fs.existsSync(FILE)) return;
  prunedAt = now;
  const cutoff = new Date(now - retentionDays() * DAY).toISOString();
  const lines = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean);
  const keep = lines.filter((l) => {
    try {
      return JSON.parse(l).time >= cutoff;
    } catch {
      return false;
    }
  });
  if (keep.length !== lines.length) fs.writeFileSync(FILE, keep.length ? keep.join("\n") + "\n" : "");
}

// fields: action plus any of target, tenant, detail, status, user (for
// sign-ins refused before there is a session).
function record(req, fields) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    prune();
    const entry = { time: new Date().toISOString(), ...userOf(req), ip: clip(req && req.ip, 64), ...fields };
    fs.appendFileSync(FILE, JSON.stringify(entry) + "\n");
  } catch (err) {
    console.error(`Audit log: could not write: ${err.message}`);
  }
}

function view(req, fields) {
  const key = [userOf(req).user, fields.action, fields.target, fields.tenant].join("|");
  const now = Date.now();
  if (now - (recentViews.get(key) || 0) < VIEW_GAP_MS) return;
  if (recentViews.size > 5000) for (const [k, t] of recentViews) if (now - t >= VIEW_GAP_MS) recentViews.delete(k);
  recentViews.set(key, now);
  record(req, fields);
}

const q = (req, k) => clip(req.query && req.query[k]);
const b = (req, k) => clip(req.body && req.body[k]);
// [method, path, what to log, view?]. Views are de-duplicated; changes never.
const RULES = [
  ["GET", /^\/api\/tools\/([\w-]+)\/history\/(.+)$/, (m) => ({ action: "view-past-run", target: m[1], detail: clip(decodeURIComponent(m[2]), 40) }), true],
  ["GET", /^\/api\/tools\/access-lookup\/run$/, (m, req) => ({ action: "access-lookup", target: q(req, "upn") }), false],
  ["GET", /^\/api\/cost\/history\/([\w-]+)$/, (m) => ({ action: "view-cost", target: m[1] }), true],
  ["POST", /^\/api\/cost\/history\/refresh$/, () => ({ action: "refresh-cost" }), false],
  ["POST", /^\/api\/tools\/([\w-]+)\/run$/, (m) => ({ action: "run-scan", target: m[1] }), false],
  ["POST", /^\/api\/tools\/([\w-]+)\/accept$/, (m, req) => ({ action: req.body && req.body.until ? "snooze-finding" : "accept-finding", target: m[1], detail: [b(req, "key"), b(req, "until"), b(req, "reason")].filter(Boolean).join(" · ") }), false],
  ["POST", /^\/api\/tools\/([\w-]+)\/unaccept$/, (m, req) => ({ action: "reopen-finding", target: m[1], detail: b(req, "key") }), false],
  ["POST", /^\/api\/settings$/, (m, req) => ({ action: "change-settings", detail: clip(Object.keys(req.body || {}).join(", "), 1000) }), false],
  ["POST", /^\/api\/settings\/test-spn$/, (m, req) => ({ action: "test-spn", target: b(req, "toolId") || "shared" }), false],
  ["POST", /^\/api\/tenants$/, (m, req) => ({ action: "save-tenant", target: b(req, "key") }), false],
  ["DELETE", /^\/api\/tenants\/([\w-]+)$/, (m) => ({ action: "delete-tenant", target: m[1] }), false],
  ["POST", /^\/api\/tenants\/([\w-]+)\/test$/, (m) => ({ action: "test-tenant", target: m[1] }), false],
];

// The page sends which page it opened (scan results load in the background
// for the overview, so a data request alone does not say someone looked).
const PAGE = /^(overview|lookup|report(\/\d{4}-\d{2})?|cost|audit|settings|scan\/[\w-]{1,60})$/;
function pageView(req, res) {
  const route = String((req.body && req.body.route) || "");
  if (!PAGE.test(route)) return res.status(400).json({ error: "unknown page" });
  view(req, { action: "view-page", target: route, ...(b(req, "tenant") && { tenant: b(req, "tenant") }) });
  res.status(204).end();
}

// Records matching requests once their response is sent, with its status, so
// refused attempts show too.
function middleware(req, res, next) {
  for (const [method, re, make, isView] of RULES) {
    if (req.method !== method) continue;
    const m = re.exec(req.path);
    if (!m) continue;
    const fields = make(m, req);
    const tenant = q(req, "tenant") || b(req, "tenant");
    res.on("finish", () => {
      const out = { ...fields, ...(tenant && { tenant }), status: res.statusCode };
      if (isView && res.statusCode < 400) view(req, out);
      else record(req, out);
    });
    break;
  }
  next();
}

function readAll({ limit = 500, user, action, since } = {}) {
  if (!fs.existsSync(FILE)) return [];
  let entries = fs
    .readFileSync(FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (user) entries = entries.filter((e) => e.user === user);
  if (action) entries = entries.filter((e) => e.action === action);
  if (since) entries = entries.filter((e) => e.time >= since);
  return entries.slice(-limit).reverse();
}

// Everyone and every action in the log, for the page's filters.
function facets() {
  const users = new Set();
  const actions = new Set();
  for (const e of readAll({ limit: Infinity })) {
    if (e.user) users.add(e.user);
    if (e.action) actions.add(e.action);
  }
  return { users: [...users].sort(), actions: [...actions].sort() };
}

module.exports = { record, middleware, pageView, readAll, facets, retentionDays, _test: { RULES, prune, FILE } };
