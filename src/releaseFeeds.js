// What Microsoft plans: the public release communications API behind Azure
// Updates (azure.microsoft.com/updates) and the Microsoft 365 roadmap. Used by
// tools/azureUpdates.js and tools/m365Roadmap.js. No key and no sign-in, and
// nothing about any tenant is sent: the request is the same for everyone.
// Fetched at most once a day (the first scan of the day; the other tenants and
// the pages use the kept copy) and kept in DATA_DIR/release-feeds.json; when
// the API cannot be reached the last good copy is used and the page says when
// it was fetched. RELEASE_FEEDS = off fetches neither.
const fs = require("fs");
const path = require("path");
const settings = require("./settings");
const { DATA_DIR } = require("./paths");
const { writeAtomic } = require("./jsonFile");

const BASE = "https://www.microsoft.com/releasecommunications/api/v2";
const FILE = path.join(DATA_DIR, "release-feeds.json");
// Under a day, so a daily schedule always fetches even when yesterday's run was a few seconds later.
const TTL_MS = 20 * 3600 * 1000;
const DAY = 86400000;
const PAGE = 100; // the API returns at most 100 items a page, whatever $top asks for
const MAX_PAGES = 40; // per query: 4,000 items, far more than the filters keep
const AZURE_DAYS = 180; // Azure news changed this recently are kept
const M365_LAUNCHED_DAYS = 60; // Microsoft 365 items launched (marked Launched) this recently are kept
const SUMMARY_MAX = 320;

const enabled = () => !/^(off|no|false|0)$/i.test(String(settings.get("RELEASE_FEEDS") || "").trim());

/* ---------- pure helpers (tested) ---------- */

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", trade: "™", reg: "®", copy: "©", bull: "•" };

// HTML description -> short plain text. Tags are dropped (script and style with their content), entities decoded,
// white space collapsed, cut at a word near `max` characters. The page still escapes the result.
function stripHtml(html, max = SUMMARY_MAX) {
  let s = String(html || "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, " ") // a stray bracket left from broken markup (encoded ones below are text and stay)
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") {
        const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    s = (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:.–-]+$/, "") + "…";
  }
  return s;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// "YYYY-MM" from "2026-03", or from a year and a month name or number; "" when not a date.
function ym(year, month) {
  if (month === undefined) {
    const m = /^(\d{4})-(\d{2})/.exec(String(year || ""));
    return m ? `${m[1]}-${m[2]}` : "";
  }
  const y = Number(year);
  let mo = Number(month);
  if (!Number.isInteger(mo)) mo = MONTHS.indexOf(String(month || "").toLowerCase()) + 1;
  if (!Number.isInteger(y) || y < 2000 || y > 2100 || !(mo >= 1 && mo <= 12)) return "";
  return `${y}-${String(mo).padStart(2, "0")}`;
}
const monthOf = (now) => new Date(now).toISOString().slice(0, 7);
const strs = (x, max = 40) => (Array.isArray(x) ? x : []).filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim().slice(0, 120)).slice(0, max);
const iso = (s) => (typeof s === "string" && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null);

// Azure update from the API -> what the page shows. Ids are slugs (letters, digits, dashes); anything else is dropped.
function azureItem(v) {
  const id = String((v && v.id) || "").trim();
  if (!/^[\w.-]{1,300}$/.test(id) || !v.title) return null;
  const tags = strs(v.tags);
  const dates = (Array.isArray(v.availabilities) ? v.availabilities : [])
    .map((a) => ({ ring: String((a && a.ring) || "").slice(0, 40), ym: ym(a && a.year, a && a.month) }))
    .filter((a) => a.ring && a.ym)
    .sort((a, b) => a.ym.localeCompare(b.ym));
  const retirement = dates.filter((a) => /retire/i.test(a.ring)).map((a) => a.ym).pop() || "";
  const ga = ym(v.generalAvailabilityDate) || dates.filter((a) => /general/i.test(a.ring)).map((a) => a.ym).pop() || "";
  const preview = ym(v.previewAvailabilityDate) || dates.filter((a) => /preview/i.test(a.ring)).map((a) => a.ym).pop() || "";
  return {
    id,
    title: String(v.title).trim().slice(0, 300),
    summary: stripHtml(v.description),
    products: strs(v.products),
    categories: strs(v.productCategories, 20),
    tags,
    status: typeof v.status === "string" ? v.status.slice(0, 40) : "",
    dates,
    ga,
    preview,
    retirement,
    modified: iso(v.modified),
    created: iso(v.created),
  };
}

// The chip an Azure update falls under: "retiring" (tagged Retirements or with a retirement date), "preview" (in
// preview, or its latest step is a preview) or "new" (generally available, launched, and everything else).
function azureKind(item) {
  if (item.retirement || item.tags.some((t) => /retire/i.test(t))) return "retiring";
  const last = item.dates[item.dates.length - 1];
  if (/preview/i.test(item.status) || (last && /preview/i.test(last.ring) && !(item.ga && item.ga >= last.ym))) return "preview";
  return "new";
}

// Kept: changed in the last AZURE_DAYS days, or with an availability or retirement date this month or later.
function keepAzure(item, now = Date.now()) {
  if (item.modified && Date.parse(item.modified) >= now - AZURE_DAYS * DAY) return true;
  const month = monthOf(now);
  return [item.ga, item.preview, item.retirement, ...item.dates.map((d) => d.ym)].some((d) => d && d >= month);
}

// Microsoft 365 roadmap item from the API -> what the page shows. Ids are numbers.
function m365Item(v) {
  const id = Number(v && v.id);
  if (!Number.isSafeInteger(id) || id <= 0 || !v.title) return null;
  return {
    id,
    title: String(v.title).trim().slice(0, 300),
    summary: stripHtml(v.description),
    products: strs(v.products),
    platforms: strs(v.platforms, 20),
    clouds: strs(v.cloudInstances, 20),
    rings: strs(v.releaseRings, 10),
    status: typeof v.status === "string" ? v.status.slice(0, 40) : "",
    ga: ym(v.generalAvailabilityDate),
    preview: ym(v.previewAvailabilityDate),
    modified: iso(v.modified),
    created: iso(v.created),
  };
}

// Kept: In development and Rolling out, and Launched when that last change is under M365_LAUNCHED_DAYS days old
// (the roadmap marks an item Launched when it has rolled out, so its last change is the launch).
function keepM365(item, now = Date.now()) {
  if (/^(in development|rolling out)$/i.test(item.status)) return true;
  return /^launched$/i.test(item.status) && Boolean(item.modified) && Date.parse(item.modified) >= now - M365_LAUNCHED_DAYS * DAY;
}

// OData filters for the requests; only dates, no tenant data.
function azureQueries(now = Date.now()) {
  const since = new Date(now - AZURE_DAYS * DAY).toISOString().slice(0, 10);
  const year = new Date(now).getUTCFullYear();
  return [
    `modified ge ${since}T00:00:00Z`,
    // Older posts that announce something still to come (a retirement next year, a GA date ahead).
    `modified lt ${since}T00:00:00Z and availabilities/any(a: a/year ge ${year})`,
  ];
}
function m365Queries(now = Date.now()) {
  const since = new Date(now - M365_LAUNCHED_DAYS * DAY).toISOString().slice(0, 10);
  return [`status eq 'In development' or status eq 'Rolling out' or (status eq 'Launched' and modified ge ${since}T00:00:00Z)`];
}

// Parsed, kept and sorted (newest change first) items from the API's pages. Duplicates (an item on two pages or in
// two queries) are kept once.
function parseFeed(kind, pages, now = Date.now()) {
  const shape = kind === "azure" ? azureItem : m365Item;
  const keep = kind === "azure" ? keepAzure : keepM365;
  const byId = new Map();
  for (const page of pages) {
    for (const v of (page && Array.isArray(page.value) && page.value) || []) {
      const item = shape(v);
      if (item && keep(item, now) && !byId.has(item.id)) byId.set(item.id, kind === "azure" ? { ...item, kind: azureKind(item) } : item);
    }
  }
  return [...byId.values()].sort((a, b) => String(b.modified || "").localeCompare(String(a.modified || "")));
}

/* ---------- fetching and the kept copy ---------- */

function readKept() {
  try {
    const kept = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return kept && typeof kept === "object" ? kept : {};
  } catch {
    return {};
  }
}

function save(kept) {
  try {
    writeAtomic(FILE, kept);
  } catch {
    // still usable for this run
  }
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Every page of one query. Paged with $skip on www.microsoft.com (the API's own nextLink points at another host).
async function allPages(kind, filter) {
  const pages = [];
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams({ $filter: filter, $orderby: "modified desc", $top: String(PAGE), $skip: String(i * PAGE) });
    const page = await getJson(`${BASE}/${kind}?${q}`);
    pages.push(page);
    if (!Array.isArray(page && page.value) || page.value.length < PAGE) break;
  }
  return pages;
}

const pending = {};

// { items, source, fetchedAt, note } for "azure" or "m365"; source "Microsoft", "kept copy" or "none".
// Fetches when the kept copy is older than TTL_MS, unless the feeds are off.
async function load(kind) {
  const kept = readKept()[kind] || null;
  if (!enabled()) {
    return kept && kept.items
      ? { items: kept.items, source: "kept copy", fetchedAt: kept.at, note: `Fetching is turned off (RELEASE_FEEDS); showing the copy from ${String(kept.at).slice(0, 10)}` }
      : { items: [], source: "none", fetchedAt: null, note: "Fetching is turned off (RELEASE_FEEDS)" };
  }
  if (kept && kept.items && Date.now() - Date.parse(kept.at) < TTL_MS) return { items: kept.items, source: "Microsoft", fetchedAt: kept.at, note: "" };
  if (!pending[kind]) {
    const queries = kind === "azure" ? azureQueries() : m365Queries();
    pending[kind] = (async () => {
      const pages = [];
      for (const f of queries) pages.push(...(await allPages(kind, f)));
      return { items: parseFeed(kind, pages) };
    })()
      .catch((err) => ({ error: err.message }))
      .finally(() => {
        pending[kind] = null;
      });
  }
  const got = await pending[kind];
  const now = new Date().toISOString();
  if (got.items && got.items.length) {
    save({ ...readKept(), [kind]: { items: got.items, at: now } });
    return { items: got.items, source: "Microsoft", fetchedAt: now, note: "" };
  }
  const why = got.error || "no items";
  save({ ...readKept(), [kind]: { ...(kept || {}), failedAt: now, error: why } });
  if (kept && kept.items) return { items: kept.items, source: "kept copy", fetchedAt: kept.at, note: `Microsoft's feed unreachable (${why}); showing the copy from ${String(kept.at).slice(0, 10)}` };
  return { items: [], source: "none", fetchedAt: null, note: `Microsoft's feed unreachable (${why}); nothing kept yet` };
}

// The kept copy only, never a request: what the pages read.
function kept(kind) {
  const k = readKept()[kind] || {};
  const note = !enabled() ? "Fetching is turned off (RELEASE_FEEDS)" : k.error && k.failedAt > (k.at || "") ? `The last fetch failed (${k.error}, ${String(k.failedAt).slice(0, 16).replace("T", " ")} UTC); showing the copy fetched before` : "";
  return { items: Array.isArray(k.items) ? k.items : [], fetchedAt: k.at || null, note };
}

module.exports = {
  load,
  kept,
  AZURE_DAYS,
  M365_LAUNCHED_DAYS,
  _test: { stripHtml, ym, azureItem, azureKind, keepAzure, m365Item, keepM365, azureQueries, m365Queries, parseFeed },
};
