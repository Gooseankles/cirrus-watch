"use strict";
/* Azure ops dashboard front end: shell, routing, overview, logs, lookup, scan pages and run history.
   Every string that comes from the API goes through esc() before it is put into HTML. */

/* ---------- helpers ---------- */
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ICON_PATHS = {
  home: '<path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>',
  tag: '<path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/>',
  trend: '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  key: '<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>',
  box: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  policy: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><polyline points="9 14 11 16 15 12"/>',
  settings: '<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>',
  cost: '<rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/>',
  menu: '<line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
  play: '<polygon points="5 3 19 12 5 21 5 3"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>',
  loader: '<line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  app: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/>',
  arrow: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  alert: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  chevron: '<polyline points="9 18 15 12 9 6"/>',
};
function icon(name, cls) {
  return `<svg class="${cls || ""}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ""}</svg>`;
}

const fmt = {
  int: (n) => (Number(n) || 0).toLocaleString("en-US"),
  compact: (n) => Charts.compact(n),
  signed: (n) => (n > 0 ? "+" : "") + fmt.int(n),
  pct: (n, digits) => (n == null || !isFinite(n) ? "–" : (n > 0 ? "+" : "") + Number(n).toFixed(digits || 0) + "%"),
  // Full figures up to a million so a column reads the same in every row; compact ("€1.2M") only above that.
  money(n, currency, compact) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    const big = compact && a >= 1e6;
    const digits = big ? 1 : a >= 100 ? 0 : 2;
    const opts = big ? { notation: "compact", maximumFractionDigits: 1 } : { maximumFractionDigits: digits, minimumFractionDigits: digits };
    try {
      if (currency) return new Intl.NumberFormat("en-US", { style: "currency", currency, ...opts }).format(n);
    } catch (e) { /* unknown currency code: fall through */ }
    return n.toLocaleString("en-US", opts) + (currency ? " " + currency : "");
  },
  date: (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { year: "numeric", month: "short", day: "numeric" }) : ""),
  dateShort: (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { month: "short", day: "numeric" }) : ""),
  dateTime: (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : ""),
  rel(iso) {
    if (!iso) return "";
    const ms = Date.now() - new Date(iso).getTime();
    if (!isFinite(ms)) return "";
    const s = Math.round(ms / 1000);
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 30) return `${d} d ago`;
    return fmt.date(iso);
  },
  month(ym) {
    const [y, m] = String(ym || "").split("-");
    if (!y || !m) return String(ym || "");
    return new Date(Date.UTC(+y, +m - 1, 1)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" });
  },
  monthShort(ym) {
    const [y, m] = String(ym || "").split("-");
    if (!y || !m) return String(ym || "");
    const s = new Date(Date.UTC(+y, +m - 1, 1)).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    return m === "01" ? `${s} ${y.slice(2)}` : s;
  },
  humanize: (s) => String(s || "").replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
};

/* ---------- static knowledge about the tools ---------- */
const TOOLS = [
  { id: "orphaned-resources", label: "Orphaned resources", icon: "trash", schedule: "Daily at 03:00", sub: "Unattached disks, NICs, unused public IPs and empty resource groups that still cost money or clutter the tenant." },
  { id: "tag-compliance", label: "Tag compliance", icon: "tag", schedule: "Daily at 04:00", sub: "Resources that are missing the tags the organisation requires." },
  { id: "cost-anomaly", label: "Cost anomalies", icon: "trend", schedule: "Daily at 07:00", sub: "Subscriptions whose spend jumped against their own recent baseline." },
  { id: "access-review", label: "Access review", icon: "shield", schedule: "Weekly, Monday at 05:00", sub: "Long-standing Owner, Contributor and User Access Administrator assignments, direct and via groups, with the people behind each group." },
  { id: "secret-expiry", label: "Expiring app credentials", icon: "key", schedule: "Daily at 06:00", sub: "App registration secrets and certificates that expire soon." },
  { id: "key-vault", label: "Key Vault", icon: "shield", schedule: "Daily at 05:45", sub: "Vault settings (soft delete, purge protection, open networks, access policies), secrets, keys and certificates that expired, expire soon or never expire, who can read secrets, and vaults with no logging, no owner or no use." },
  { id: "access-packages", label: "Access packages", icon: "box", schedule: "Daily at 05:00", sub: "Entitlement management packages that expire soon, auto-approve without an end date, go unused or have weak approval." },
  { id: "role-assignments", label: "Role assignments", icon: "users", schedule: "Daily at 04:15", sub: "Assignments whose user, group or app was deleted (\"Identity not found\": safe to remove), and subscriptions getting close to Azure's limit of 4,000 role assignments." },
  { id: "policy-check", label: "Policy check", icon: "policy", schedule: "Daily at 05:30", sub: "Probes ask Azure whether risky resources (public storage, plain HTTP, public IPs, open SQL, untagged, blocked regions) would be allowed in each subscription; nothing is created. Health checks find policy assignments that cannot work." },
];
const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t]));

// kind -> [label, severity]; anything unknown is humanised and neutral
const KINDS = {
  "unattached-disk": ["Unattached disk", "warn"],
  "orphaned-nic": ["Orphaned NIC", "warn"],
  "unused-public-ip": ["Unused public IP", "warn"],
  "empty-resource-group": ["Empty resource group", ""],
  "missing-tags": ["Missing tags", "warn"],
  "cost-jump": ["Cost jump", "crit"],
  "scan-error": ["Scan error", "warn"],
  "stale-direct-assignment": ["Direct assignment", "warn"],
  "stale-group-assignment": ["Group assignment", ""],
  "app-credential-expiring": ["App credential expiring", "warn"],
  "keyvault-cert-expiring": ["Key Vault cert expiring", "warn"],
  "kv-soft-delete-off": ["Soft delete off", "crit"],
  "kv-purge-protection-off": ["Purge protection off", "warn"],
  "kv-public-network": ["Open to all networks", "warn"],
  "kv-access-policies": ["Access policy model", ""],
  "kv-expired": ["Expired", "crit"],
  "kv-expiring": ["Expiring", "warn"],
  "kv-no-expiry": ["No expiry date", ""],
  "kv-no-data-access": ["Items not checked", ""],
  "kv-broad-secret-access": ["Broad secret access", "crit"],
  "kv-many-readers": ["Many secret readers", "warn"],
  "kv-guest-access": ["Guest can read secrets", "warn"],
  "kv-deleted-principal": ["Policy for deleted identity", "warn"],
  "kv-no-diagnostics": ["No audit log", "warn"],
  "kv-no-owner-tag": ["No owner tag", ""],
  "kv-empty": ["Empty vault", ""],
  "kv-unused": ["Unused vault", ""],
  "access-package-expiring": ["Package expiring", "warn"],
  "access-package-auto-approved-no-expiry": ["Auto-approved, no expiry", "crit"],
  "access-package-duplicate-name": ["Duplicate name", ""],
  "access-package-pending-too-long": ["Request pending too long", "warn"],
  "access-package-single-approver": ["Single approver", "warn"],
  "access-package-unused": ["Unused package", ""],
  "orphaned-assignment": ["Identity not found", "warn"],
  "assignment-limit": ["Near assignment limit", "crit"],
  "probe-not-blocked": ["Not blocked", "crit"],
  "probe-only-audited": ["Only audited", "warn"],
  "enforcement-off": ["Enforcement off", "crit"],
  "effect-disabled": ["Effect disabled", "warn"],
  "definition-missing": ["Definition missing", "crit"],
  "identity-missing": ["Identity missing", "crit"],
  "identity-lacks-roles": ["Identity lacks roles", "crit"],
  "remediation-failed": ["Remediation failed", "crit"],
  "remediation-not-run": ["Remediation never run", "warn"],
  "evaluates-nothing": ["Evaluates nothing", "warn"],
  "exemption-no-expiry": ["Exemption without end date", "warn"],
  "exemption-expired": ["Exemption expired", "warn"],
  "exemption-expiring": ["Exemption expiring", ""],
};
const kindLabel = (k) => (KINDS[k] ? KINDS[k][0] : fmt.humanize(k));
const kindSev = (k) => (KINDS[k] ? KINDS[k][1] : "");
const kindBadge = (k) => `<span class="kind${kindSev(k) ? " k-" + kindSev(k) : ""}">${esc(kindLabel(k))}</span>`;

const PROBE_ORDER = ["storage-public-blob", "storage-http", "storage-old-tls", "public-ip", "keyvault-no-purge-protection", "sql-public-network", "untagged-resource", "denied-region"];
const PROBE_SHORT = {
  "storage-public-blob": "Public blob",
  "storage-http": "Plain HTTP",
  "storage-old-tls": "TLS 1.0",
  "public-ip": "Public IP",
  "keyvault-no-purge-protection": "KV purge off",
  "sql-public-network": "SQL public",
  "untagged-resource": "Untagged",
  "denied-region": "Denied region",
};
const LOG_TOOLS = {
  "subscription-create": "Subscription creation",
  "subscription-decommission": "Subscription decommission",
  "access-lookup": "Access lookup",
  "cost-history": "Cost history",
};

/* ---------- state and API ---------- */
const state = { me: null, tools: {}, logs: [], logsAt: null, route: null, timers: { logs: null } };

function toolState(id) {
  if (!state.tools[id]) {
    state.tools[id] = {
      id, loaded: false, loading: null, data: { ranAt: null, findings: [] }, history: [], snapshots: {}, selectedRun: null,
      filters: { q: "", kind: "", sub: "", newOnly: false, role: "", ptype: "", view: "probes" },
      shown: 150, open: new Set(), running: false, runError: null, runStarted: null, runFinished: null, error: null,
    };
  }
  return state.tools[id];
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("sign in required");
  }
  return res;
}
async function apiJson(path, opts) {
  const res = await api(path, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || (res.status === 403 ? "Admin role required" : `HTTP ${res.status}`));
    err.status = res.status;
    throw err;
  }
  return body;
}
const postJson = (path, body) => apiJson(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

function loadTool(id) {
  const t = toolState(id);
  if (t.loading) return t.loading;
  t.loading = (async () => {
    try {
      const [data, history] = await Promise.all([apiJson(`/api/tools/${id}/findings`), apiJson(`/api/tools/${id}/history`)]);
      t.data = { ranAt: data.ranAt || null, findings: Array.isArray(data.findings) ? data.findings : [] };
      t.history = Array.isArray(history) ? history : [];
      t.error = null;
    } catch (err) {
      t.error = err.message;
    }
    t.loaded = true;
    t.loading = null;
    setNavCount(id, t.data.findings.length);
    return t;
  })();
  return t.loading;
}
async function loadLogs() {
  try {
    const logs = await apiJson("/api/logs?limit=300");
    state.logs = Array.isArray(logs) ? logs : [];
    state.logsAt = new Date();
  } catch (err) {
    /* keep what we have */
  }
  return state.logs;
}

/* ---------- small renderers ---------- */
function setStatus(el, msg, cls) {
  if (!el) return;
  el.className = `status-msg${cls ? " " + cls : ""}`;
  el.textContent = msg || "";
}
function statTile(o) {
  return `<div class="stat"><div class="label">${esc(o.label)}</div><div class="value${o.small ? " sm" : ""}">${esc(o.value)}</div>${o.delta != null && o.delta !== "" ? `<div class="delta ${o.deltaCls || ""}">${esc(o.delta)}</div>` : ""}${o.sub ? `<div class="sub" title="${esc(o.sub)}">${esc(o.sub)}</div>` : ""}</div>`;
}
function subCell(f) {
  const name = f.subscriptionName || f.subscriptionId || "Tenant";
  const showId = Boolean(f.subscriptionName && f.subscriptionId);
  return `<div class="sub-cell"><div class="primary">${esc(name)}</div>${showId ? `<div class="secondary">${esc(f.subscriptionId)}</div>` : ""}</div>`;
}
const isNew = (f, ranAt) => Boolean(ranAt && f.firstSeen === ranAt);
function nameCell(f, ranAt, secondary) {
  const sec = secondary != null ? secondary : f.resourceGroup ? `rg ${f.resourceGroup}` : "";
  return `<div class="name-cell"><div class="primary">${esc(f.name || f.id || "")}${isNew(f, ranAt) ? '<span class="new-badge">NEW</span>' : ""}</div>${sec ? `<div class="secondary">${esc(sec)}</div>` : ""}</div>`;
}
function tableHtml(cols, rows, opts) {
  const o = opts || {};
  const head = cols.map((c) => `<th class="${c.cls || ""}">${esc(c.label)}</th>`).join("");
  const body = rows
    .map((r) => {
      const cells = Array.isArray(r) ? r : r.cells;
      const attrs = Array.isArray(r) ? "" : r.attrs || "";
      return `<tr ${attrs}>${cells.map((c, i) => `<td class="${(cols[i] && cols[i].cls) || ""}">${c}</td>`).join("")}</tr>`;
    })
    .join("");
  return `<div class="table-wrap${o.scroll ? " scroll-y" : ""}"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}
function moreButton(shown, total, t) {
  if (shown >= total) return "";
  return `<div class="load-more"><button class="btn small ghost" data-more="1">Show more (${fmt.int(total - shown)} left)</button></div>`;
}
function countKinds(findings) {
  const out = {};
  for (const f of findings) out[f.kind] = (out[f.kind] || 0) + 1;
  return out;
}
function kindChips(counts, active) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length < 2 && !active) return "";
  return entries.map(([k, n]) => `<button class="chip${active === k ? " active" : ""}" data-kind="${esc(k)}">${esc(kindLabel(k))} <span class="n">${fmt.int(n)}</span></button>`).join("");
}
function fillSubSelect(all, t) {
  const sel = $("#scan-sub");
  if (!sel) return;
  const key = `${t.data.ranAt}|${all.length}`;
  if (sel.dataset.key !== key) {
    const subs = new Map();
    for (const f of all) if (f.subscriptionId) subs.set(f.subscriptionId, f.subscriptionName || f.subscriptionId);
    const list = [...subs].sort((a, b) => a[1].localeCompare(b[1]));
    sel.innerHTML = `<option value="">All subscriptions</option>` + list.map(([id, name]) => `<option value="${esc(id)}">${esc(name)}</option>`).join("");
    sel.classList.toggle("hidden", list.length === 0);
    sel.dataset.key = key;
    if (t.filters.sub && !subs.has(t.filters.sub)) t.filters.sub = "";
  }
  sel.value = t.filters.sub;
}
function searchText(f) {
  const parts = [f.name, f.id, f.detail, f.resourceGroup, f.subscriptionName, f.subscriptionId, f.kind, f.upn, f.principalId, f.scope, f.scopeText, f.role, f.probe];
  if (Array.isArray(f.members)) for (const m of f.members) parts.push(m.name, m.upn);
  return parts.filter(Boolean).join(" ").toLowerCase();
}
function baseFilter(f, t) {
  const fl = t.filters;
  if (fl.kind && f.kind !== fl.kind) return false;
  if (fl.sub && (f.subscriptionId || "") !== fl.sub) return false;
  if (fl.newOnly && !isNew(f, t.data.ranAt)) return false;
  if (fl.q && !searchText(f).includes(fl.q)) return false;
  return true;
}
// The subscription is its own column; show the scope below it, readable.
function shortScope(scope) {
  const s = scope || "";
  if (/^\/subscriptions\/[^/]+\/?$/i.test(s)) return "whole subscription";
  const mg = s.match(/\/managementGroups\/([^/]+)$/i);
  if (mg) return `management group ${mg[1]}`;
  if (s === "/") return "tenant root";
  return s.replace(/^\/subscriptions\/[^/]+/i, "").replace(/^\/resourceGroups\//i, "rg ").replace(/\/providers\//i, " / ");
}
function roleClass(role) {
  const r = String(role || "").toLowerCase();
  if (r.startsWith("owner")) return "role-owner";
  if (r.startsWith("user access")) return "role-user";
  if (r.startsWith("contributor")) return "role-contributor";
  return "";
}
const roleBadge = (role) => `<span class="role-badge ${roleClass(role)}">${esc(role || "")}</span>`;
function initials(name) {
  const parts = String(name || "").trim().split(/[\s.@_-]+/).filter(Boolean);
  if (!parts.length) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/* ---------- routing ---------- */
function parseRoute() {
  const h = (window.location.hash || "#/overview").replace(/^#\/?/, "");
  const [page, ...rest] = h.split("/");
  return { page: page || "overview", arg: rest.join("/") };
}
function navigate(key) {
  window.location.hash = "#/" + key;
}
function render() {
  const r = parseRoute();
  clearInterval(state.timers.logs);
  state.timers.logs = null;
  let pageId = null;
  let key = r.page;
  let show = null;
  if (r.page === "overview") {
    pageId = "page-overview";
    show = () => showOverview();
  } else if (r.page === "logs" && LOG_TOOLS[r.arg]) {
    pageId = "page-logs";
    key = `logs/${r.arg}`;
    show = () => showLogs(r.arg);
  } else if (r.page === "lookup") {
    pageId = "page-lookup";
  } else if (r.page === "scan" && TOOL_BY_ID[r.arg]) {
    pageId = "page-scan";
    key = `scan/${r.arg}`;
    show = () => showScan(r.arg);
  } else if (r.page === "cost") {
    pageId = "page-cost";
    show = () => Cost.show();
  } else if (r.page === "settings" && state.me && state.me.isAdmin) {
    pageId = "page-settings";
    show = () => Settings.show();
  }
  if (!pageId) {
    window.location.replace("#/overview");
    return;
  }
  $$(".page").forEach((p) => p.classList.toggle("active", p.id === pageId));
  $$(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.route === key));
  document.body.classList.remove("nav-open");
  if (state.route !== key) window.scrollTo(0, 0);
  state.route = key;
  Charts.hideTip();
  if (show) show();
}

/* ---------- shell ---------- */
function buildNav() {
  const me = state.me || {};
  const groups = [
    { label: "", items: [{ route: "overview", label: "Overview", icon: "home" }] },
    { label: "ServiceNow", items: [{ route: "logs/subscription-create", label: "Subscription creation", icon: "plus" }, { route: "logs/subscription-decommission", label: "Subscription decommission", icon: "minus" }] },
    { label: "Access", items: [{ route: "lookup", label: "Access lookup", icon: "search" }] },
    { label: "Scans", items: TOOLS.map((t) => ({ route: `scan/${t.id}`, label: t.label, icon: t.icon, count: true })) },
    { label: "Cost", items: [{ route: "cost", label: "Cost history", icon: "cost" }] },
  ];
  if (me.isAdmin) groups.push({ label: "Admin", items: [{ route: "settings", label: "Settings", icon: "settings" }] });
  $("#nav").innerHTML = groups
    .map(
      (g) =>
        (g.label ? `<div class="nav-group">${esc(g.label)}</div>` : "") +
        g.items.map((it) => `<a class="nav-item" href="#/${esc(it.route)}" data-route="${esc(it.route)}">${icon(it.icon)}<span>${esc(it.label)}</span>${it.count ? '<span class="nav-count"></span>' : ""}</a>`).join("")
    )
    .join("");
}
function setNavCount(id, n) {
  const el = $(`.nav-item[data-route="scan/${id}"] .nav-count`);
  if (el) el.textContent = fmt.int(n);
}
function renderMe() {
  const me = state.me || {};
  $("#me-name").textContent = me.name || "Signed in";
  $("#me-role").textContent = me.isAdmin ? "Admin" : (me.roles || []).join(", ") || "Reader";
  $("#me-avatar").textContent = initials(me.name || "?");
  $("#me-version").textContent = me.version ? `v${me.version}` : "";
}
function wireShell() {
  const open = (on) => document.body.classList.toggle("nav-open", on);
  $("#menu-btn").addEventListener("click", () => open(!document.body.classList.contains("nav-open")));
  $("#scrim").addEventListener("click", () => open(false));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") open(false);
  });
}

/* ---------- overview ---------- */
function showOverview() {
  const page = $("#page-overview");
  if (!page.dataset.built) {
    page.innerHTML = `
      <div class="page-head">
        <div><h1>Overview</h1><p class="page-sub">The latest result of every scan, tenant spend and what the ServiceNow flows did recently.</p></div>
        <div class="page-actions"><div class="last-run" id="ov-updated"></div></div>
      </div>
      <div class="stat-row" id="ov-stats"></div>
      <div class="section-title"><h2>Scans</h2><span class="muted small">Click a card to open the scan</span></div>
      <div class="tool-grid" id="ov-tools"></div>
      <div class="overview-grid">
        <div class="card" id="ov-cost"></div>
        <div class="card" id="ov-activity"></div>
      </div>`;
    page.dataset.built = "1";
  }
  renderOverview();
  Promise.all([...TOOLS.map((t) => loadTool(t.id)), loadLogs(), Cost.loadIndex().catch(() => null)]).then(() => {
    if (state.route === "overview") renderOverview();
  });
}
function renderOverview() {
  const loaded = TOOLS.filter((t) => toolState(t.id).loaded);
  let open = 0, added = 0, resolved = 0, errors = 0, neverRan = 0;
  for (const tool of TOOLS) {
    const t = toolState(tool.id);
    open += t.data.findings.length;
    const last = t.history[t.history.length - 1];
    if (last) {
      added += last.added || 0;
      resolved += last.resolved || 0;
    }
    if (t.error) errors++;
    else if (t.loaded && !t.data.ranAt) neverRan++;
  }
  $("#ov-updated").innerHTML = loaded.length ? `<b>${loaded.length} of ${TOOLS.length}</b> scans loaded` : "Loading…";
  $("#ov-stats").innerHTML =
    statTile({ label: "Open findings", value: fmt.int(open), delta: "across all scans" }) +
    statTile({ label: "New in latest runs", value: fmt.int(added), deltaCls: added ? "bad" : "", delta: added ? "need a look" : "nothing new" }) +
    statTile({ label: "Resolved in latest runs", value: fmt.int(resolved), deltaCls: resolved ? "good" : "", delta: resolved ? "gone since the run before" : "no change" }) +
    statTile({ label: "Scan health", value: `${TOOLS.length - errors - neverRan} / ${TOOLS.length}`, deltaCls: errors ? "bad" : "", delta: errors ? `${errors} failed to load` : neverRan ? `${neverRan} never run` : "all scans have results" });
  $("#ov-tools").innerHTML = TOOLS.map(toolCard).join("");
  for (const el of $$("#ov-tools [data-spark]")) {
    const t = toolState(el.dataset.spark);
    Charts.sparkline(el, t.history.slice(-12).map((h) => h.count));
  }
  renderOverviewCost();
  renderActivity();
}
function toolCard(tool) {
  const t = toolState(tool.id);
  const n = t.data.findings.length;
  const last = t.history[t.history.length - 1];
  const kinds = Object.entries(countKinds(t.data.findings)).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const delta = last
    ? `<span class="${last.added ? "bad" : ""}">+${fmt.int(last.added)} new</span><span class="${last.resolved ? "good" : ""}">−${fmt.int(last.resolved)} resolved</span>`
    : `<span>No runs yet</span>`;
  const foot = t.error
    ? `<span class="err">${esc(t.error)}</span>`
    : `<span>${t.data.ranAt ? "Ran " + esc(fmt.rel(t.data.ranAt)) : "Never run"}</span><span>${t.history.length ? fmt.int(t.history.length) + " runs" : ""}</span>`;
  return `<a class="tool-card" href="#/scan/${esc(tool.id)}">
    <div class="tc-head">${icon(tool.icon)}<span>${esc(tool.label)}</span></div>
    <div class="tc-count"><span class="${n ? "" : "zero"}">${t.loaded ? fmt.int(n) : "…"}</span><small>open finding${n === 1 ? "" : "s"}</small></div>
    <div class="tc-delta">${delta}</div>
    <div class="tc-spark" data-spark="${esc(tool.id)}"></div>
    <div class="tc-kinds">${kinds.map(([k, c]) => `${kindBadge(k).replace("</span>", ` ${fmt.int(c)}</span>`)}`).join("")}</div>
    <div class="tc-foot">${foot}</div>
  </a>`;
}
function renderOverviewCost() {
  const el = $("#ov-cost");
  const s = Cost.summary();
  if (!s || !s.subs.length) {
    el.innerHTML = `<div class="card-head"><h2>${icon("cost")} Tenant spend</h2><a href="#/cost">Open cost history ${icon("arrow")}</a></div><div class="empty-state">No cost data yet.${state.me && state.me.isAdmin ? " Refresh it from the cost history page." : ""}</div>`;
    return;
  }
  el.innerHTML = `
    <div class="card-head"><h2>${icon("cost")} Tenant spend</h2><span class="meta">${fmt.int(s.subs.length)} subscription${s.subs.length === 1 ? "" : "s"} · updated ${esc(fmt.rel(s.updatedAt))}</span><a href="#/cost">Open cost history ${icon("arrow")}</a></div>
    <div class="cost-strip">
      ${statTile({ label: "Month to date", value: fmt.money(s.mtd, s.currency, true), small: true })}
      ${statTile({ label: "Forecast this month", value: fmt.money(s.forecast, s.currency, true), small: true })}
      ${statTile({ label: "Last month", value: fmt.money(s.lastMonth, s.currency, true), small: true })}
      ${statTile({ label: "30-day change", value: fmt.pct(s.change30), small: true, deltaCls: s.change30 > 0 ? "bad" : s.change30 < 0 ? "good" : "", delta: s.change30 == null ? "not enough data" : "vs the 30 days before" })}
    </div>
    ${s.currencyNote ? `<div class="note">${esc(s.currencyNote)}</div>` : ""}
    <div class="chart trend-chart" id="ov-cost-chart" style="margin-top:12px"></div>
    <div class="chart-foot"><span>Monthly total, last 13 months</span><span>Current month is in progress</span></div>`;
  Charts.columns($("#ov-cost-chart"), {
    data: s.months.map((m) => ({ label: fmt.monthShort(m.month), value: m.total, partial: m.partial, month: m.month })),
    yFormat: Charts.compact,
    emptyText: "No monthly totals yet",
    tooltip: (d) => ({ title: fmt.month(d.month), rows: [{ label: "Total", value: fmt.money(d.value, s.currency) }], note: d.partial ? "Month in progress" : undefined }),
  });
}
function renderActivity() {
  const el = $("#ov-activity");
  const logs = state.logs.slice(0, 12);
  el.innerHTML = `<div class="card-head"><h2>${icon("list")} Recent activity</h2><span class="meta">${state.logsAt ? "updated " + esc(fmt.rel(state.logsAt)) : ""}</span></div>` +
    (logs.length
      ? `<ul class="activity">${logs
          .map(
            (l) => `<li><span class="dot ${esc(l.level || "info")}"></span><div><div class="act-meta"><span>${esc(fmt.rel(l.time))}</span><span>${esc(LOG_TOOLS[l.tool] || (TOOL_BY_ID[l.tool] ? TOOL_BY_ID[l.tool].label : l.tool))}</span>${l.ticketNumber ? `<span class="mono">${esc(l.ticketNumber)}</span>` : ""}</div><div class="act-msg">${esc(l.message)}</div></div></li>`
          )
          .join("")}</ul>`
      : `<div class="empty-state">Nothing logged yet.</div>`);
}

/* ---------- logs (ServiceNow flows) ---------- */
function showLogs(kind) {
  const page = $("#page-logs");
  const label = LOG_TOOLS[kind] || kind;
  if (page.dataset.kind !== kind) {
    page.innerHTML = `
      <div class="page-head">
        <div><h1>${esc(label)}</h1><p class="page-sub">Every ${esc(label.toLowerCase())} request the ServiceNow flow sent, newest first. Refreshes every 5 seconds.</p></div>
        <div class="page-actions"><div class="last-run" id="logs-updated"></div></div>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-tools">
            <input class="input search" id="logs-q" type="search" placeholder="Search message or ticket" />
            <select class="select" id="logs-level"><option value="">All levels</option><option value="info">Info</option><option value="success">Success</option><option value="error">Error</option></select>
          </div>
          <span class="meta" id="logs-count"></span>
        </div>
        <div id="logs-body"></div>
      </div>`;
    page.dataset.kind = kind;
    $("#logs-q").addEventListener("input", () => renderLogs(kind));
    $("#logs-level").addEventListener("change", () => renderLogs(kind));
  }
  renderLogs(kind);
  loadLogs().then(() => state.route === `logs/${kind}` && renderLogs(kind));
  state.timers.logs = setInterval(async () => {
    await loadLogs();
    if (state.route === `logs/${kind}`) renderLogs(kind);
  }, 5000);
}
function renderLogs(kind) {
  const q = ($("#logs-q").value || "").trim().toLowerCase();
  const level = $("#logs-level").value;
  const all = state.logs.filter((l) => l.tool === kind);
  const shown = all.filter((l) => (!level || l.level === level) && (!q || `${l.message || ""} ${l.ticketNumber || ""}`.toLowerCase().includes(q))).slice(0, 300);
  const errors = all.filter((l) => l.level === "error").length;
  $("#logs-updated").innerHTML = state.logsAt ? `Updated <b>${esc(fmt.rel(state.logsAt))}</b><br>${fmt.int(all.length)} entries · ${fmt.int(errors)} error${errors === 1 ? "" : "s"}` : "Loading…";
  $("#logs-count").textContent = all.length ? `${fmt.int(shown.length)} of ${fmt.int(all.length)}` : "";
  $("#logs-body").innerHTML = shown.length
    ? tableHtml(
        [{ label: "Time", cls: "nowrap" }, { label: "Level" }, { label: "Ticket" }, { label: "Message" }],
        shown.map((l) => [
          `<span title="${esc(l.time)}">${esc(fmt.dateTime(l.time))}</span>`,
          `<span class="level"><span class="dot ${esc(l.level || "info")}"></span>${esc(l.level || "info")}</span>`,
          l.ticketNumber ? `<code>${esc(l.ticketNumber)}</code>` : '<span class="muted">–</span>',
          `<span class="detail-cell wide">${esc(l.message)}</span>`,
        ])
      )
    : `<div class="empty-state">${all.length ? "No entries match." : "No runs logged yet. Entries appear here when ServiceNow calls the webhook."}</div>`;
}

/* ---------- access lookup ---------- */
function wireLookup() {
  const form = $("#lookup-form");
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const upn = $("#lookup-upn").value.trim();
    const btn = $("#lookup-btn");
    const status = $("#lookup-status");
    const out = $("#lookup-result");
    if (!upn) return;
    btn.disabled = true;
    setStatus(status, "Looking up…");
    try {
      const r = await apiJson(`/api/tools/access-lookup/run?upn=${encodeURIComponent(upn)}`);
      setStatus(status, "");
      out.innerHTML = lookupHtml(r);
    } catch (err) {
      setStatus(status, err.message, "error");
      out.innerHTML = "";
    }
    btn.disabled = false;
  });
}
function lookupHtml(r) {
  const user = r.user || {};
  const a = Array.isArray(r.assignments) ? r.assignments : [];
  const groups = Array.isArray(r.groups) ? r.groups : [];
  const direct = a.filter((x) => x.via === "direct").length;
  const subs = new Set(a.map((x) => x.subscriptionId).filter(Boolean)).size;
  const owners = a.filter((x) => /^owner/i.test(x.role || "")).length;
  return `
    <div class="person"><div class="avatar">${esc(initials(user.displayName || user.upn))}</div><div><div class="p-name">${esc(user.displayName || "")}</div><div class="p-upn">${esc(user.upn || "")}</div></div></div>
    <div class="stat-row">
      ${statTile({ label: "Role assignments", value: fmt.int(a.length) })}
      ${statTile({ label: "Direct", value: fmt.int(direct) })}
      ${statTile({ label: "Via groups", value: fmt.int(a.length - direct) })}
      ${statTile({ label: "Owner", value: fmt.int(owners), deltaCls: owners ? "bad" : "", delta: owners ? "highest privilege" : "" })}
      ${statTile({ label: "Subscriptions", value: fmt.int(subs) })}
    </div>
    <div class="card">
      <div class="card-head"><h2>Role assignments</h2><span class="meta">${fmt.int(a.length)}</span></div>
      ${
        a.length
          ? tableHtml(
              [{ label: "Role" }, { label: "Via" }, { label: "Subscription" }, { label: "Scope" }],
              a.map((x) => [roleBadge(x.role), x.via === "direct" ? '<span class="text-2">direct</span>' : `<span class="text-2">${esc(x.via)}</span>`, subCell(x), `<span class="detail-cell">${esc(shortScope(x.scope))}</span>`])
            )
          : `<div class="empty-state">No role assignments found for this person.</div>`
      }
    </div>
    <div class="card">
      <div class="card-head"><h2>Group memberships</h2><span class="meta">${fmt.int(groups.length)}</span></div>
      ${groups.length ? `<div class="inline-list">${groups.map((g) => `<span class="tag">${esc(g)}</span>`).join("")}</div>` : `<div class="empty-state">Not a member of any group.</div>`}
    </div>`;
}

/* ---------- scan pages ---------- */
function scanSkeleton(tool) {
  return `
    <div class="page-head">
      <div><h1>${esc(tool.label)}</h1><p class="page-sub">${esc(tool.sub)}</p></div>
      <div class="page-actions"><div class="last-run" id="scan-lastrun"></div><button class="btn primary" id="scan-run">${icon("play")} Run now</button></div>
    </div>
    <div class="status-msg" id="scan-status"></div>
    <div class="stat-row" id="scan-stats"></div>
    <div class="card">
      <div class="card-head">
        <h2>Findings <span class="meta" id="scan-count"></span></h2>
        <div class="card-tools">
          <input class="input search" id="scan-q" type="search" placeholder="Search name, detail, subscription" />
          <select class="select" id="scan-sub"><option value="">All subscriptions</option></select>
          <span id="scan-extra" class="card-tools"></span>
          <button class="chip" id="scan-new" data-filter="newOnly">${icon("alert")} New this run</button>
        </div>
      </div>
      <div class="inline-list" id="scan-kinds"></div>
      <div id="scan-body"></div>
    </div>
    <div class="card">
      <div class="card-head"><h2>${icon("trend")} History</h2><span class="meta" id="scan-hist-meta"></span></div>
      <div class="hist-grid">
        <div><div class="chart hist-chart" id="scan-chart"></div><div class="chart-foot" id="scan-chart-note"></div></div>
        <div class="hist-runs" id="scan-runs"></div>
      </div>
      <div class="hist-detail" id="scan-run-detail"></div>
    </div>`;
}
function wireScan() {
  const page = $("#page-scan");
  const cur = () => toolState(page.dataset.tool);
  page.addEventListener("input", (e) => {
    if (e.target.id === "scan-q") {
      cur().filters.q = e.target.value.trim().toLowerCase();
      cur().shown = 150;
      renderFindings(page.dataset.tool);
    }
  });
  page.addEventListener("change", (e) => {
    const t = cur();
    if (e.target.id === "scan-sub") t.filters.sub = e.target.value;
    else if (e.target.dataset.filter) t.filters[e.target.dataset.filter] = e.target.value;
    else return;
    t.shown = 150;
    renderFindings(page.dataset.tool);
  });
  page.addEventListener("click", (e) => {
    const t = cur();
    const id = page.dataset.tool;
    const el = e.target.closest("[data-kind],[data-filter],[data-view],[data-ranat],[data-more],[data-toggle],#scan-run");
    if (!el) return;
    if (el.id === "scan-run") return runTool(id);
    if (el.dataset.kind !== undefined) {
      t.filters.kind = t.filters.kind === el.dataset.kind ? "" : el.dataset.kind;
    } else if (el.dataset.filter === "newOnly") {
      t.filters.newOnly = !t.filters.newOnly;
    } else if (el.dataset.view) {
      t.filters.view = el.dataset.view;
      t.filters.kind = "";
    } else if (el.dataset.ranat) {
      return selectRun(id, el.dataset.ranat);
    } else if (el.dataset.more) {
      t.shown += 150;
    } else if (el.dataset.toggle) {
      const key = el.dataset.toggle;
      const row = page.querySelector(`tr[data-members="${CSS.escape(key)}"]`);
      const open = t.open.has(key);
      if (open) t.open.delete(key);
      else t.open.add(key);
      if (row) row.classList.toggle("hidden", open);
      el.classList.toggle("active", !open);
      return;
    } else return;
    t.shown = el.dataset.more ? t.shown : 150;
    renderFindings(id);
  });
}
function showScan(id) {
  const page = $("#page-scan");
  const tool = TOOL_BY_ID[id];
  const t = toolState(id);
  if (page.dataset.tool !== id) {
    page.innerHTML = scanSkeleton(tool);
    page.dataset.tool = id;
    $("#scan-q").value = t.filters.q;
  }
  renderScan(id);
  loadTool(id).then(() => {
    if (state.route === `scan/${id}`) {
      if (!t.selectedRun && t.history.length) t.selectedRun = t.history[t.history.length - 1].ranAt;
      renderScan(id);
    }
  });
}
function renderScan(id) {
  renderFindings(id);
  renderHistory(id);
}
function renderFindings(id) {
  const t = toolState(id);
  const tool = TOOL_BY_ID[id];
  const view = VIEWS[id] || GENERIC;
  const isAdmin = Boolean(state.me && state.me.isAdmin);
  renderRunState(id);
  $("#scan-lastrun").innerHTML = t.data.ranAt
    ? `Last run <b title="${esc(t.data.ranAt)}">${esc(fmt.rel(t.data.ranAt))}</b><br>${esc(tool.schedule)}`
    : `<b>Never run</b><br>${esc(tool.schedule)}`;
  const all = t.data.findings;
  if (!t.loaded) {
    $("#scan-body").innerHTML = `<div class="empty-state">Loading…</div>`;
    return;
  }
  if (t.error) {
    $("#scan-stats").innerHTML = "";
    $("#scan-body").innerHTML = `<div class="empty-state big"><h3>Could not load this scan</h3><p class="muted">${esc(t.error)}</p></div>`;
    return;
  }
  if (!t.data.ranAt) {
    $("#scan-stats").innerHTML = "";
    $("#scan-kinds").innerHTML = "";
    $("#scan-extra").innerHTML = "";
    $("#scan-count").textContent = "";
    $("#scan-body").innerHTML = `<div class="empty-state big"><h3>No results yet</h3><p>This scan has not run on this server.${isAdmin ? " Run it now, or wait for the schedule (" + esc(tool.schedule.toLowerCase()) + ")." : " It runs on schedule: " + esc(tool.schedule.toLowerCase()) + "."}</p></div>`;
    return;
  }
  $("#scan-stats").innerHTML = view.stats(all, t);
  fillSubSelect(all, t);
  const scoped = view.scope ? all.filter((f) => view.scope(f, t)) : all;
  const showKinds = view.showKinds ? view.showKinds(t) : true;
  $("#scan-kinds").innerHTML = showKinds ? kindChips(countKinds(scoped), t.filters.kind) : "";
  $("#scan-extra").innerHTML = view.extra ? view.extra(all, t) : "";
  $("#scan-new").classList.toggle("active", t.filters.newOnly);
  const shown = scoped.filter((f) => baseFilter(f, t));
  $("#scan-count").textContent = all.length ? `${fmt.int(shown.length)} of ${fmt.int(all.length)}` : "";
  $("#scan-body").innerHTML = all.length
    ? shown.length
      ? view.body(shown, t)
      : `<div class="empty-state">No findings match these filters.</div>`
    : `<div class="empty-state big"><h3>All clear</h3><p>The last run found nothing.</p></div>`;
}

/* generic view */
function genericStats(all, t) {
  const last = t.history[t.history.length - 1];
  const subs = new Set(all.map((f) => f.subscriptionId).filter(Boolean)).size;
  const kinds = Object.keys(countKinds(all)).length;
  const fresh = all.filter((f) => isNew(f, t.data.ranAt)).length;
  const oldest = all.reduce((m, f) => (f.firstSeen && new Date(f.firstSeen) < m ? new Date(f.firstSeen) : m), new Date());
  const oldestDays = Math.floor((Date.now() - oldest.getTime()) / 86400000);
  return (
    statTile({ label: "Open findings", value: fmt.int(all.length), delta: last ? `+${fmt.int(last.added)} new · −${fmt.int(last.resolved)} resolved in this run` : "" }) +
    statTile({ label: "New this run", value: fmt.int(fresh), deltaCls: fresh ? "bad" : "", delta: fresh ? "first seen in the last run" : "nothing new" }) +
    statTile({ label: "Subscriptions affected", value: fmt.int(subs), delta: subs ? "" : "tenant-level only" }) +
    statTile({ label: "Kinds", value: fmt.int(kinds) }) +
    statTile({ label: "Oldest open", value: all.length ? `${fmt.int(oldestDays)} d` : "–", delta: all.length ? "first seen " + fmt.date(oldest) : "" })
  );
}
function genericColumns(ranAt, hasSubs, hasExpiry) {
  const cols = [{ label: "Kind" }, { label: "Name" }];
  if (hasSubs) cols.push({ label: "Subscription" });
  if (hasExpiry) cols.push({ label: "Expiry", cls: "nowrap" });
  cols.push({ label: "Detail" }, { label: "First seen", cls: "nowrap" });
  return cols;
}
// "Expired <date>" (red) or "Expires <date>", with how long ago / how long left.
function expiryCell(f) {
  if (!f.expires) return f.kind === "kv-no-expiry" ? `<span class="muted">No expiry</span>` : "";
  const at = new Date(f.expires);
  const days = Math.round((at.getTime() - Date.now()) / 86400000);
  const past = days < 0 || at.getTime() <= Date.now();
  const when = past ? (days === 0 ? "today" : `${fmt.int(-days)} day${days === -1 ? "" : "s"} ago`) : days === 0 ? "today" : `in ${fmt.int(days)} day${days === 1 ? "" : "s"}`;
  return `<div class="nowrap${past ? " bad" : ""}" title="${esc(f.expires)}">${past ? "Expired" : "Expires"} ${esc(fmt.date(f.expires))}</div><div class="secondary">${esc(when)}</div>`;
}
function genericRow(f, ranAt, hasSubs, hasExpiry) {
  const sec = f.role ? `${f.role} · ${shortScope(f.scope)}` : f.resourceGroup ? `rg ${f.resourceGroup}` : f.count != null ? `${fmt.int(f.count)} assignments` : "";
  const row = [kindBadge(f.kind), nameCell(f, ranAt, sec)];
  if (hasSubs) row.push(subCell(f));
  if (hasExpiry) row.push(expiryCell(f));
  row.push(`<span class="detail-cell">${esc(f.detail || "")}</span>`, `<span class="muted" title="${esc(f.firstSeen || "")}">${esc(fmt.date(f.firstSeen))}</span>`);
  return row;
}
function genericBody(shown, t) {
  const hasSubs = shown.some((f) => f.subscriptionId);
  const hasExpiry = shown.some((f) => f.expires || f.kind === "kv-no-expiry");
  const slice = shown.slice(0, t.shown);
  return tableHtml(genericColumns(t.data.ranAt, hasSubs, hasExpiry), slice.map((f) => genericRow(f, t.data.ranAt, hasSubs, hasExpiry))) + moreButton(slice.length, shown.length, t);
}
const GENERIC = { stats: genericStats, body: genericBody };

/* access review view */
function arStats(all, t) {
  const direct = all.filter((f) => f.principalType !== "Group");
  const groups = all.filter((f) => f.principalType === "Group");
  const viaGroups = new Set(groups.flatMap((g) => (g.members || []).filter((m) => m.type === "User").map((m) => m.id)));
  const oldest = all.reduce((max, f) => Math.max(max, f.ageDays || 0), 0);
  const owners = all.filter((f) => /^owner/i.test(f.role || "")).length;
  const missing = all.filter((f) => f.missing).length;
  const fresh = all.filter((f) => isNew(f, t.data.ranAt)).length;
  return (
    statTile({ label: "Direct user assignments", value: fmt.int(direct.length) }) +
    statTile({ label: "Group assignments", value: fmt.int(groups.length), delta: `${fmt.int(viaGroups.size)} people get access through them` }) +
    statTile({ label: "Owner role", value: fmt.int(owners), deltaCls: owners ? "bad" : "" }) +
    statTile({ label: "Principal not found", value: fmt.int(missing), deltaCls: missing ? "bad" : "", delta: missing ? "deleted in Entra, safe to remove" : "" }) +
    statTile({ label: "Oldest assignment", value: all.length ? `${Math.floor(oldest / 365)}y ${oldest % 365}d` : "–" }) +
    statTile({ label: "New this run", value: fmt.int(fresh), deltaCls: fresh ? "bad" : "" })
  );
}
function arExtra(all, t) {
  const roles = [...new Set(all.map((f) => f.role).filter(Boolean))].sort();
  return `
    <select class="select" data-filter="ptype">
      <option value=""${t.filters.ptype === "" ? " selected" : ""}>Direct and groups</option>
      <option value="User"${t.filters.ptype === "User" ? " selected" : ""}>Direct (users)</option>
      <option value="Group"${t.filters.ptype === "Group" ? " selected" : ""}>Groups</option>
    </select>
    <select class="select" data-filter="role">
      <option value="">All roles</option>
      ${roles.map((r) => `<option value="${esc(r)}"${t.filters.role === r ? " selected" : ""}>${esc(r)}</option>`).join("")}
    </select>`;
}
function arScope(f, t) {
  const type = t.filters.ptype;
  if (type && (type === "Group" ? f.principalType !== "Group" : f.principalType === "Group")) return false;
  if (t.filters.role && f.role !== t.filters.role) return false;
  return true;
}
function arMembers(f) {
  const members = Array.isArray(f.members) ? f.members : [];
  const glyph = (m) => (m.type === "Group" ? icon("users") : m.type === "App" ? icon("app") : icon("user"));
  const list = members
    .map(
      (m) => `<div class="ar-member${m.enabled ? "" : " disabled"}" title="${esc(m.type || "")}${m.enabled ? "" : " (disabled)"}"><span class="m-ico">${glyph(m)}</span><div><div>${esc(m.name)}${m.enabled ? "" : ' <span class="muted">(disabled)</span>'}</div>${m.upn ? `<div class="secondary">${esc(m.upn)}</div>` : ""}</div></div>`
    )
    .join("");
  const total = f.memberTotal != null ? f.memberTotal : members.length;
  const more = total > members.length ? `<div class="note">+${fmt.int(total - members.length)} more not listed.</div>` : "";
  return `<div class="ar-members">${list || '<span class="muted">No members.</span>'}</div>${more}`;
}
function arBody(shown, t) {
  const ranAt = t.data.ranAt;
  const slice = shown.slice(0, t.shown);
  const rows = slice.map((f) => {
    const isGroup = f.principalType === "Group";
    const total = f.memberTotal != null ? f.memberTotal : null;
    const key = String(f.id || "");
    const who = `<div class="ar-who"><span class="ar-ico${isGroup ? " group" : ""}">${icon(isGroup ? "users" : "user")}</span><div class="name-cell"><div class="primary">${esc(f.name || f.principalId || "")}${isNew(f, ranAt) ? '<span class="new-badge">NEW</span>' : ""}</div>${f.upn ? `<div class="secondary">${esc(f.upn)}</div>` : ""}${f.missing ? `<div class="secondary bad">not found in Entra (deleted?) · ${esc(f.principalId || "")}</div>` : ""}</div></div>`;
    const where = `<div class="sub-cell"><div class="primary">${esc(f.subscriptionName || f.subscriptionId || "Tenant")}</div><div class="secondary" style="font-family:inherit">${esc(f.scopeLevel || "")}${f.scopeTarget && f.scopeLevel !== "Subscription" ? " · " + esc(f.scopeTarget) : ""}</div></div>`;
    const assigned = `<div>${esc(f.createdOn ? fmt.date(f.createdOn) : "")}</div><div class="secondary">${f.ageDays != null ? `${fmt.int(f.ageDays)} days ago` : ""}</div>`;
    const toggle = isGroup
      ? total == null
        ? `<span class="muted small">members unknown</span>`
        : `<button type="button" class="chip${t.open.has(key) ? " active" : ""}" data-toggle="${esc(key)}">${icon("chevron")} ${fmt.int(total)} member${total === 1 ? "" : "s"}</button>`
      : "";
    const main = `<tr>${[who, roleBadge(f.role), where, assigned, `<div class="ar-actions">${toggle}</div>`].map((c) => `<td>${c}</td>`).join("")}</tr>`;
    const members = isGroup && total != null ? `<tr class="ar-members-row${t.open.has(key) ? "" : " hidden"}" data-members="${esc(key)}"><td colspan="5">${arMembers(f)}</td></tr>` : "";
    return main + members;
  });
  return `<div class="table-wrap"><table class="data"><thead><tr><th>Who</th><th>Role</th><th>Where</th><th>Assigned</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` + moreButton(slice.length, shown.length, t);
}

/* policy check view */
const isProbe = (f) => String(f.kind || "").startsWith("probe-");
function pcStats(all, t) {
  const probes = all.filter(isProbe);
  const open = probes.filter((f) => f.kind === "probe-not-blocked");
  const audit = probes.filter((f) => f.kind === "probe-only-audited");
  const health = all.filter((f) => !isProbe(f));
  const subs = new Set(open.map((f) => f.subscriptionId).filter(Boolean)).size;
  const fresh = all.filter((f) => isNew(f, t.data.ranAt)).length;
  return (
    statTile({ label: "Probes not blocked", value: fmt.int(open.length), deltaCls: open.length ? "bad" : "good", delta: open.length ? `in ${fmt.int(subs)} subscription${subs === 1 ? "" : "s"}` : "every probe was denied" }) +
    statTile({ label: "Only audited", value: fmt.int(audit.length), deltaCls: audit.length ? "" : "", delta: "allowed, but logged" }) +
    statTile({ label: "Assignment health issues", value: fmt.int(health.length), deltaCls: health.length ? "bad" : "" }) +
    statTile({ label: "New this run", value: fmt.int(fresh), deltaCls: fresh ? "bad" : "" })
  );
}
function pcExtra(all, t) {
  const nProbes = all.filter(isProbe).length;
  const nHealth = all.length - nProbes;
  const v = t.filters.view;
  return `<div class="seg"><button type="button" data-view="probes" class="${v === "probes" ? "active" : ""}">Probes <span class="n">${fmt.int(nProbes)}</span></button><button type="button" data-view="health" class="${v === "health" ? "active" : ""}">Assignment health <span class="n">${fmt.int(nHealth)}</span></button></div>`;
}
const pcScope = (f, t) => (t.filters.view === "health" ? !isProbe(f) : isProbe(f));
function pcMatrix(shown, t) {
  const ranAt = t.data.ranAt;
  const subs = new Map();
  const probesSeen = new Set();
  for (const f of shown) {
    const key = f.subscriptionId || "";
    if (!subs.has(key)) subs.set(key, { id: key, name: f.subscriptionName || f.subscriptionId || "Tenant", cells: {} });
    subs.get(key).cells[f.probe] = f;
    probesSeen.add(f.probe);
  }
  const probes = PROBE_ORDER.filter((p) => probesSeen.has(p)).concat([...probesSeen].filter((p) => !PROBE_ORDER.includes(p)).sort());
  const rows = [...subs.values()].sort((a, b) => a.name.localeCompare(b.name));
  const cell = (f) => {
    if (!f) return `<span class="verdict ok">blocked</span>`;
    const dot = isNew(f, ranAt) ? '<span class="nd" title="New this run"></span>' : "";
    return f.kind === "probe-not-blocked"
      ? `<span class="verdict open" title="${esc(f.detail || "")}">${dot}Open</span>`
      : `<span class="verdict audit" title="${esc(f.detail || "")}">${dot}Audit</span>`;
  };
  return `
    <div class="matrix-wrap"><table class="matrix">
      <thead><tr><th>Subscription</th>${probes.map((p) => `<th title="${esc(p)}">${esc(PROBE_SHORT[p] || fmt.humanize(p))}</th>`).join("")}</tr></thead>
      <tbody>${rows
        .map((r) => `<tr><td><div class="sub-cell"><div class="primary">${esc(r.name)}</div>${r.id && r.name !== r.id ? `<div class="secondary">${esc(r.id)}</div>` : ""}</div></td>${probes.map((p) => `<td class="cell">${cell(r.cells[p])}</td>`).join("")}</tr>`)
        .join("")}</tbody>
    </table></div>
    <div class="matrix-legend">
      <span><span class="verdict open">Open</span> the resource would be created</span>
      <span><span class="verdict audit">Audit</span> allowed, only logged</span>
      <span><span class="verdict ok">blocked</span> denied by policy</span>
      <span><span class="verdict open"><span class="nd"></span></span> new this run</span>
    </div>
    <div class="note">Subscriptions where every probe was blocked are not listed. Hover a verdict for the policy detail.</div>`;
}
function pcHealth(shown, t) {
  const ranAt = t.data.ranAt;
  const groups = new Map();
  for (const f of shown) {
    if (!groups.has(f.kind)) groups.set(f.kind, []);
    groups.get(f.kind).push(f);
  }
  const order = [...groups.keys()].sort((a, b) => (kindSev(b) === "crit") - (kindSev(a) === "crit") || groups.get(b).length - groups.get(a).length);
  let n = 0;
  let html = "";
  for (const kind of order) {
    const list = groups.get(kind);
    html += `<tr class="kind-group-head"><td colspan="4">${kindBadge(kind)} <span class="muted">${fmt.int(list.length)}</span></td></tr>`;
    for (const f of list) {
      if (n++ >= t.shown) break;
      const roles = Array.isArray(f.missingRoles) && f.missingRoles.length ? `<div class="inline-list" style="margin-top:4px">${f.missingRoles.map((r) => `<span class="tag">${esc(r)}</span>`).join("")}</div>` : "";
      html += `<tr><td>${nameCell(f, ranAt, f.scopeText || shortScope(f.scope) || (f.resourceGroup ? "rg " + f.resourceGroup : ""))}</td><td>${subCell(f)}</td><td><span class="detail-cell">${esc(f.detail || "")}</span>${roles}</td><td class="nowrap"><span class="muted">${esc(fmt.date(f.firstSeen))}</span></td></tr>`;
    }
    if (n >= t.shown) break;
  }
  return `<div class="table-wrap"><table class="data"><thead><tr><th>Assignment</th><th>Subscription</th><th>Detail</th><th>First seen</th></tr></thead><tbody>${html}</tbody></table></div>` + moreButton(Math.min(n, t.shown), shown.length, t);
}
/* key vault view */
const KV_AREAS = [
  ["all", "All"],
  ["settings", "Settings"],
  ["expiry", "Expiry"],
  ["access", "Access"],
  ["logging", "Logging"],
];
const kvArea = (t) => (KV_AREAS.some(([a]) => a === t.filters.view) ? t.filters.view : "all");
function kvStats(all, t) {
  const vaults = new Set(all.map((f) => f.vault).filter(Boolean)).size;
  const n = (k) => all.filter((f) => f.kind === k).length;
  const expired = n("kv-expired");
  const expiring = n("kv-expiring");
  const access = all.filter((f) => f.area === "access").length;
  const unchecked = n("kv-no-data-access");
  const fresh = all.filter((f) => isNew(f, t.data.ranAt)).length;
  return (
    statTile({ label: "Vaults with findings", value: fmt.int(vaults) }) +
    statTile({ label: "Expired", value: fmt.int(expired), deltaCls: expired ? "bad" : "good", delta: expired ? "secrets, keys or certs" : "nothing expired" }) +
    statTile({ label: "Expiring soon", value: fmt.int(expiring), deltaCls: expiring ? "bad" : "" }) +
    statTile({ label: "Access issues", value: fmt.int(access), deltaCls: access ? "bad" : "" }) +
    statTile({ label: "Vaults not checked", value: fmt.int(unchecked), delta: unchecked ? "no permission or firewall" : "" }) +
    statTile({ label: "New this run", value: fmt.int(fresh), deltaCls: fresh ? "bad" : "" })
  );
}
function kvExtra(all, t) {
  const v = kvArea(t);
  return `<div class="seg">${KV_AREAS.map(([a, label]) => `<button type="button" data-view="${a}" class="${v === a ? "active" : ""}">${label} <span class="n">${fmt.int(a === "all" ? all.length : all.filter((f) => f.area === a).length)}</span></button>`).join("")}</div>`;
}
const kvScope = (f, t) => kvArea(t) === "all" || f.area === kvArea(t);
function kvBody(shown, t) {
  // Expiry view: soonest (most overdue) first.
  if (kvArea(t) === "expiry") shown = [...shown].sort((a, b) => (a.expires ? Date.parse(a.expires) : Infinity) - (b.expires ? Date.parse(b.expires) : Infinity));
  return genericBody(shown, t);
}

const VIEWS = {
  "key-vault": { stats: kvStats, extra: kvExtra, scope: kvScope, body: kvBody },
  "access-review": { stats: arStats, extra: arExtra, scope: arScope, body: arBody },
  "policy-check": { stats: pcStats, extra: pcExtra, scope: pcScope, showKinds: (t) => t.filters.view === "health", body: (shown, t) => (t.filters.view === "health" ? pcHealth(shown, t) : pcMatrix(shown, t)) },
};

/* history */
function renderHistory(id) {
  const t = toolState(id);
  const h = t.history;
  const chartEl = $("#scan-chart");
  if (!chartEl) return;
  $("#scan-hist-meta").textContent = h.length ? `${fmt.int(h.length)} run${h.length === 1 ? "" : "s"} kept · since ${fmt.date(h[0].ranAt)}` : "";
  if (!h.length) {
    Charts.columns(chartEl, { data: [], emptyText: t.loaded ? "No runs yet" : "Loading…" });
    $("#scan-chart-note").innerHTML = "";
    $("#scan-runs").innerHTML = `<div class="empty-state">${t.loaded ? "No runs recorded yet." : "Loading…"}</div>`;
    $("#scan-run-detail").innerHTML = "";
    return;
  }
  if (!t.selectedRun || !h.some((r) => r.ranAt === t.selectedRun)) t.selectedRun = h[h.length - 1].ranAt;
  const recent = h.slice(-40);
  const selIdx = recent.findIndex((r) => r.ranAt === t.selectedRun);
  Charts.columns(chartEl, {
    data: recent.map((r) => ({ label: fmt.dateShort(r.ranAt), value: r.count, ranAt: r.ranAt, added: r.added, resolved: r.resolved })),
    integer: true,
    selected: selIdx,
    valueLabel: "Findings",
    tooltip: (d) => ({ title: fmt.dateTime(d.ranAt), rows: [{ label: "Findings", value: fmt.int(d.value) }, { label: "New", value: "+" + fmt.int(d.added) }, { label: "Resolved", value: "−" + fmt.int(d.resolved) }], note: "Click to inspect this run" }),
    onSelect: (i, d) => selectRun(id, d.ranAt),
    emptyText: "No runs yet",
  });
  $("#scan-chart-note").innerHTML = `<span>Findings per run${h.length > 40 ? `, last 40 of ${fmt.int(h.length)}` : ""}</span><span>Click a bar or a row to see what changed</span>`;
  const rows = h
    .slice()
    .reverse()
    .map((r) => ({
      attrs: `class="clickable${r.ranAt === t.selectedRun ? " sel" : ""}" data-ranat="${esc(r.ranAt)}"`,
      cells: [
        `<span title="${esc(r.ranAt)}">${esc(fmt.dateTime(r.ranAt))}</span>`,
        fmt.int(r.count),
        `<span class="${r.added ? "delta-up" : "muted"}">+${fmt.int(r.added)}</span>`,
        `<span class="${r.resolved ? "delta-down" : "muted"}">−${fmt.int(r.resolved)}</span>`,
      ],
    }));
  $("#scan-runs").innerHTML = tableHtml([{ label: "Run" }, { label: "Findings", cls: "num" }, { label: "New", cls: "num" }, { label: "Resolved", cls: "num" }], rows);
  renderRunDetail(id);
}
function selectRun(id, ranAt) {
  toolState(id).selectedRun = ranAt;
  renderHistory(id);
}
function runDetailTable(list, ranAt) {
  const hasSubs = list.some((f) => f.subscriptionId);
  const slice = list.slice(0, 50);
  const cols = [{ label: "Kind" }, { label: "Name" }];
  if (hasSubs) cols.push({ label: "Subscription" });
  cols.push({ label: "Detail" });
  const rows = slice.map((f) => {
    const r = [kindBadge(f.kind), nameCell(f, null, f.upn || (f.resourceGroup ? "rg " + f.resourceGroup : ""))];
    if (hasSubs) r.push(subCell(f));
    r.push(`<span class="detail-cell">${esc(f.detail || "")}</span>`);
    return r;
  });
  return tableHtml(cols, rows, { scroll: true }) + (list.length > 50 ? `<div class="note">Showing 50 of ${fmt.int(list.length)}.</div>` : "");
}
function renderRunDetail(id) {
  const t = toolState(id);
  const ranAt = t.selectedRun;
  const el = $("#scan-run-detail");
  if (!el) return;
  if (!ranAt) {
    el.innerHTML = "";
    return;
  }
  const entry = t.history.find((r) => r.ranAt === ranAt) || {};
  const snap = t.snapshots[ranAt];
  const byKind = Object.entries(entry.byKind || {}).sort((a, b) => b[1] - a[1]);
  const head = `<h4>Run ${esc(fmt.dateTime(ranAt))} <span class="n">${fmt.int(entry.count || 0)} findings · +${fmt.int(entry.added || 0)} new · −${fmt.int(entry.resolved || 0)} resolved${ranAt === t.data.ranAt ? " · latest" : ""}</span></h4>` +
    (byKind.length ? `<div class="inline-list">${byKind.map(([k, n]) => `<span class="tag">${esc(kindLabel(k))} <b>${fmt.int(n)}</b></span>`).join("")}</div>` : "");
  let body;
  if (!snap) body = `<div class="empty-state">Loading what changed…</div>`;
  else if (snap.error) body = `<div class="status-msg error">${esc(snap.error)}</div>`;
  else {
    const added = Array.isArray(snap.added) ? snap.added : [];
    const resolved = Array.isArray(snap.resolved) ? snap.resolved : [];
    body = "";
    if (!snap.previousRanAt) body += `<div class="note">First recorded run: every finding counted as new.</div>`;
    if (added.length) body += `<h4><span class="delta-up">Added</span> <span class="n">${fmt.int(added.length)}</span></h4>${runDetailTable(added, ranAt)}`;
    if (resolved.length) body += `<h4><span class="delta-down">Resolved</span> <span class="n">${fmt.int(resolved.length)}</span></h4>${runDetailTable(resolved, ranAt)}`;
    if (!added.length && !resolved.length) body += `<div class="empty-state">Nothing changed in this run compared with the one before.</div>`;
  }
  el.innerHTML = head + body;
  if (!snap) {
    apiJson(`/api/tools/${id}/history/${encodeURIComponent(ranAt)}`)
      .then((s) => {
        t.snapshots[ranAt] = s;
      })
      .catch((err) => {
        t.snapshots[ranAt] = { error: err.message };
      })
      .then(() => {
        if (state.route === `scan/${id}` && t.selectedRun === ranAt) renderRunDetail(id);
      });
  }
}

/* run loop */
async function runTool(id) {
  const t = toolState(id);
  if (t.running) return;
  t.running = true;
  t.runError = null;
  t.runStarted = Date.now();
  t.runFinished = null;
  const prevRanAt = t.data.ranAt;
  renderRunState(id);
  try {
    await postJson(`/api/tools/${id}/run`, {});
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(2500);
      const data = await apiJson(`/api/tools/${id}/findings`);
      if (data.ranAt && data.ranAt !== prevRanAt) {
        await loadTool(id);
        t.runFinished = Date.now();
        break;
      }
      const logs = await apiJson("/api/logs?limit=30").catch(() => []);
      const failed = (Array.isArray(logs) ? logs : []).find((l) => l.tool === id && l.level === "error" && new Date(l.time).getTime() >= t.runStarted - 2000);
      if (failed) throw new Error(failed.message || "the run failed");
    }
    if (!t.runFinished) throw new Error("timed out waiting for the run to finish");
  } catch (err) {
    t.runError = err.message;
  }
  t.running = false;
  if (state.route === `scan/${id}`) {
    if (t.runFinished) t.selectedRun = t.data.ranAt;
    renderScan(id);
  }
}
function renderRunState(id) {
  const t = toolState(id);
  const btn = $("#scan-run");
  const st = $("#scan-status");
  if (!btn || $("#page-scan").dataset.tool !== id) return;
  const isAdmin = Boolean(state.me && state.me.isAdmin);
  btn.classList.toggle("hidden", !isAdmin);
  if (t.running) {
    const secs = Math.max(0, Math.round((Date.now() - t.runStarted) / 1000));
    btn.disabled = true;
    btn.classList.add("running");
    btn.innerHTML = `${icon("loader", "spin")} Running… ${secs}s`;
    setStatus(st, "Scanning. The results and the history update as soon as the run finishes.");
  } else {
    btn.disabled = false;
    btn.classList.remove("running");
    btn.innerHTML = `${icon("play")} Run now`;
    if (t.runError) setStatus(st, `Run failed: ${t.runError}`, "error");
    else if (t.runFinished && Date.now() - t.runFinished < 60000) {
      const last = t.history[t.history.length - 1] || {};
      setStatus(st, `Run finished: ${fmt.int(t.data.findings.length)} findings (+${fmt.int(last.added || 0)} new, −${fmt.int(last.resolved || 0)} resolved).`, "ok");
    } else setStatus(st, "");
  }
}
function tickRunning() {
  const id = $("#page-scan").dataset.tool;
  if (id && toolState(id).running && state.route === `scan/${id}`) renderRunState(id);
}

/* ---------- boot ---------- */
async function init() {
  try {
    state.me = await apiJson("/api/me");
  } catch (err) {
    window.location.href = "/login.html";
    return;
  }
  if (!state.me.signedIn) {
    window.location.href = "/login.html";
    return;
  }
  renderMe();
  buildNav();
  wireShell();
  wireLookup();
  wireScan();
  window.addEventListener("hashchange", render);
  render();
  setInterval(tickRunning, 1000);
  for (const t of TOOLS) if (!toolState(t.id).loaded) loadTool(t.id);
}
document.addEventListener("DOMContentLoaded", init);
