// Cost history per subscription, pulled from Cost Management and kept in the
// history storage (findingsStore docs), so it reaches further back than the
// API's own window once it has run for a while.
//
// Per subscription (doc cost/<subscriptionId>.json):
//   daily:            { "2026-10-19": 12.34, ... }        total per day
//   monthlyByService: { "2026-10": { "Storage": 1.2 } }   from daily rows
//   monthlyByRg:      { "2026-10": { "rg-app": 3.4 } }
//   tenant:           key of the tenant it belongs to (home when missing)
// First run: COST_HISTORY_MONTHS back (default 13), fetched a year at a time.
// Later runs: only from the start of the month 7 days ago (cost data is
// restated for a few days), replacing those months whole.
const { armPost, subscriptionIdsToScan, subscriptionNames } = require("./armClient");
const store = require("./findingsStore");
const settings = require("./settings");
const log = require("./log");
const tenants = require("./tenants");
const tenantContext = require("./tenantContext");

const TOOL_ID = "cost-anomaly"; // same identity as the cost tool (Cost Management Reader)
const CONCURRENCY = 2; // Cost Management throttles per tenant
const COST_API = "2023-11-01";
const DAY = 24 * 60 * 60 * 1000;

const docKey = (sub) => `cost/${sub}.json`;
const INDEX_KEY = "cost/index.json";

function historyMonths() {
  return Math.min(Number(settings.get("COST_HISTORY_MONTHS")) || 13, 120);
}

const isoDate = (d) => d.toISOString().slice(0, 10);
const monthOf = (day) => day.slice(0, 7);

function startOfMonth(d) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function normalizeDay(value) {
  const s = String(value);
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);
}

// One Cost Management query, following nextLink pages.
async function costQuery(subscriptionId, from, to, groupBy) {
  const body = {
    type: "ActualCost",
    timeframe: "Custom",
    timePeriod: { from: isoDate(from), to: isoDate(to) },
    dataset: {
      granularity: "Daily",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [{ type: "Dimension", name: groupBy }],
    },
  };
  let url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=${COST_API}`;
  const rows = [];
  let columns = [];
  while (url) {
    const data = await armPost(url, body, TOOL_ID);
    const p = data.properties || {};
    columns = (p.columns || columns).map((c) => c.name || c);
    rows.push(...(p.rows || []));
    url = p.nextLink || null;
  }
  const col = (n) => columns.indexOf(n);
  const [dayI, costI, groupI, curI] = [col("UsageDate"), col("Cost"), col(groupBy), col("Currency")];
  return rows.map((r) => ({
    day: normalizeDay(r[dayI]),
    cost: Number(r[costI]) || 0,
    group: r[groupI] || "(none)",
    currency: curI >= 0 ? r[curI] : null,
  }));
}

// Year-sized windows from `from` to `to` (the API caps a custom range at a year).
function windows(from, to) {
  const out = [];
  let start = new Date(from);
  while (start <= to) {
    const end = new Date(Math.min(to.getTime(), start.getTime() + 364 * DAY));
    out.push([new Date(start), end]);
    start = new Date(end.getTime() + DAY);
  }
  return out;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

async function collectSubscription(subscriptionId, today) {
  const doc = (await store.getDoc(docKey(subscriptionId))) || { subscriptionId, daily: {}, monthlyByService: {}, monthlyByRg: {} };
  const backfill = !doc.updatedAt;
  const from = backfill
    ? startOfMonth(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - historyMonths() + 1, 1)))
    : startOfMonth(new Date(today.getTime() - 7 * DAY));

  const byService = [];
  const byRg = [];
  let oldestOk = null;
  // Newest window first: if the oldest one is out of reach, the rest still lands.
  for (const [a, b] of windows(from, today).reverse()) {
    try {
      byService.push(...(await costQuery(subscriptionId, a, b, "ServiceName")));
      byRg.push(...(await costQuery(subscriptionId, a, b, "ResourceGroupName")));
      oldestOk = a;
    } catch (err) {
      if (!oldestOk) throw err; // even the newest window failed
      log.record({ tool: TOOL_ID, level: "info", message: `cost history for ${subscriptionId} stops at ${isoDate(oldestOk)}: ${err.message.slice(0, 200)}` });
      break;
    }
  }

  // Replace every month the fetched range covers whole. Year windows after
  // the first start mid-month, so when an older one failed the month the
  // oldest good window starts in is only partly fetched: it is left out
  // instead of being kept as a too-low month.
  const oldestDay = isoDate(oldestOk);
  const fromMonth = oldestDay.endsWith("-01")
    ? monthOf(oldestDay)
    : monthOf(isoDate(new Date(Date.UTC(oldestOk.getUTCFullYear(), oldestOk.getUTCMonth() + 1, 1))));
  for (const day of Object.keys(doc.daily)) if (monthOf(day) >= fromMonth) delete doc.daily[day];
  for (const m of Object.keys(doc.monthlyByService)) if (m >= fromMonth) delete doc.monthlyByService[m];
  for (const m of Object.keys(doc.monthlyByRg)) if (m >= fromMonth) delete doc.monthlyByRg[m];

  for (const r of byService) {
    if (monthOf(r.day) < fromMonth) continue;
    doc.daily[r.day] = (doc.daily[r.day] || 0) + r.cost;
    const m = (doc.monthlyByService[monthOf(r.day)] ||= {});
    m[r.group] = (m[r.group] || 0) + r.cost;
    if (r.currency) doc.currency = r.currency;
  }
  for (const r of byRg) {
    if (monthOf(r.day) < fromMonth) continue;
    const m = (doc.monthlyByRg[monthOf(r.day)] ||= {});
    m[r.group] = (m[r.group] || 0) + r.cost;
  }
  for (const k of Object.keys(doc.daily)) doc.daily[k] = round(doc.daily[k]);
  for (const map of [doc.monthlyByService, doc.monthlyByRg]) {
    for (const m of Object.values(map)) for (const k of Object.keys(m)) m[k] = round(m[k]);
  }
  const t = tenantContext.current();
  doc.tenant = t ? t.key : tenants.HOME;
  doc.updatedAt = new Date().toISOString();
  doc.firstDay = Object.keys(doc.daily).sort()[0] || null;
  await store.putDoc(docKey(subscriptionId), doc);
  return doc;
}

// --- Summaries (what the page lists) ---

function sumDays(daily, from, to) {
  let total = 0;
  for (const [d, c] of Object.entries(daily)) if (d >= from && d <= to) total += c;
  return total;
}

function monthlyTotals(daily) {
  const out = {};
  for (const [d, c] of Object.entries(daily)) out[monthOf(d)] = (out[monthOf(d)] || 0) + c;
  for (const k of Object.keys(out)) out[k] = round(out[k]);
  return out;
}

function summarize(doc, now = new Date()) {
  const today = isoDate(now);
  const day = (n) => isoDate(new Date(now.getTime() - n * DAY));
  const thisMonth = today.slice(0, 7);
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonth = isoDate(lastMonthDate).slice(0, 7);
  const monthly = monthlyTotals(doc.daily);
  const mtd = monthly[thisMonth] || 0;
  // Data lags about a day: forecast from complete days only.
  const daysDone = Math.max(1, now.getUTCDate() - 1);
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const last30 = sumDays(doc.daily, day(30), day(1));
  const prev30 = sumDays(doc.daily, day(60), day(31));
  const services = doc.monthlyByService[lastMonth] || doc.monthlyByService[thisMonth] || {};
  const topService = Object.entries(services).sort((a, b) => b[1] - a[1])[0];
  return {
    subscriptionId: doc.subscriptionId,
    tenant: doc.tenant || tenants.HOME,
    currency: doc.currency || null,
    updatedAt: doc.updatedAt,
    firstDay: doc.firstDay,
    monthToDate: round(mtd),
    forecast: round(now.getUTCDate() > 1 ? (sumDays(doc.daily, `${thisMonth}-01`, day(1)) / daysDone) * daysInMonth : monthly[lastMonth] || 0),
    lastMonth: round(monthly[lastMonth] || 0),
    last30: round(last30),
    prev30: round(prev30),
    change30Pct: prev30 > 0 ? Math.round(((last30 - prev30) / prev30) * 100) : null,
    last12Months: round(Object.entries(monthly).filter(([m]) => m > isoDate(new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), 1))).slice(0, 7)).reduce((s, [, c]) => s + c, 0)),
    topService: topService ? { name: topService[0], cost: topService[1] } : null,
    monthly,
  };
}

// --- Run (nightly and from the button) ---

let running = null;

// One tenant's subscriptions; throws only when the list itself is out of reach.
async function collectTenant(tenant, today) {
  return tenantContext.runIn(tenant, async () => {
    const subs = await subscriptionIdsToScan(TOOL_ID);
    const names = await subscriptionNames(TOOL_ID).catch(() => new Map());
    const summaries = [];
    const failures = [];
    const queue = [...subs];
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length) {
          const sub = queue.shift();
          try {
            const doc = await collectSubscription(sub, today);
            summaries.push({ ...summarize(doc, today), subscriptionName: names.get(sub) || null });
          } catch (err) {
            failures.push({ subscriptionId: sub, tenant: tenant.key, subscriptionName: names.get(sub) || null, error: String(err.message || err).slice(0, 300) });
          }
        }
      })
    );
    return { summaries, failures };
  });
}

// only: tenant keys to refresh (null = every enabled tenant); the index keeps
// the other tenants' rows as they were.
async function collectAll(only = null) {
  if (running) return running;
  running = (async () => {
    const today = new Date();
    const targets = tenants.scanTargets().filter((t) => !only || only.includes(t.key));
    const multi = tenants.isMultiTenant();
    const summaries = [];
    const failures = [];
    // Each tenant's index lives in its own store; one whose subscription list
    // failed keeps its last rows and notes the failure.
    for (const t of targets) {
      let idx;
      try {
        const r = await collectTenant(t, today);
        summaries.push(...r.summaries);
        failures.push(...r.failures);
        idx = { updatedAt: new Date().toISOString(), subscriptions: r.summaries.sort((a, b) => b.last30 - a.last30), failures: r.failures };
      } catch (err) {
        const failure = { tenant: t.key, subscriptionId: null, subscriptionName: multi ? t.name : null, error: String(err.message || err).slice(0, 300) };
        failures.push(failure);
        idx = { ...(await tenantIndex(t.key).catch(() => EMPTY_INDEX())), failures: [failure] };
      }
      try {
        await store.putDoc(INDEX_KEY, idx, t.key);
      } catch (err) {
        failures.push({ tenant: t.key, subscriptionId: null, subscriptionName: multi ? t.name : null, error: `could not save: ${err.message}`.slice(0, 300) });
      }
    }
    log.record({
      tool: TOOL_ID,
      ...(targets.length === 1 && { tenant: targets[0].key }),
      level: failures.length && !summaries.length ? "error" : "success",
      message: `cost history: ${summaries.length} subscription(s) updated${failures.length ? `, ${failures.length} failed (e.g. ${failures[0].error})` : ""}`,
    });
    return { summaries, failures };
  })();
  try {
    return await running;
  } finally {
    running = null;
  }
}

const EMPTY_INDEX = () => ({ updatedAt: null, subscriptions: [], failures: [] });

async function tenantIndex(tenantKey) {
  const idx = (await store.getDoc(INDEX_KEY, tenantKey)) || EMPTY_INDEX();
  // Rows belong to the store they are in, whatever they say themselves.
  for (const x of [...(idx.subscriptions || []), ...(idx.failures || [])]) x.tenant = tenantKey;
  return idx;
}

// These tenants' indexes together (default: the home tenant). updatedAt is
// the newest; a tenant whose store cannot be read shows as a failure.
async function index(keys = [tenants.HOME]) {
  const parts = await Promise.all(
    keys.map((k) =>
      tenantIndex(k).catch((err) => ({ ...EMPTY_INDEX(), failures: [{ tenant: k, subscriptionId: null, error: `could not read stored cost history: ${err.message}` }] }))
    )
  );
  const out = EMPTY_INDEX();
  for (const p of parts) {
    if (p.updatedAt && (!out.updatedAt || p.updatedAt > out.updatedAt)) out.updatedAt = p.updatedAt;
    out.subscriptions.push(...(p.subscriptions || []));
    out.failures.push(...(p.failures || []));
  }
  out.subscriptions.sort((a, b) => b.last30 - a.last30);
  return out;
}

// One subscription's document, looked for in these tenants' stores.
async function subscription(subscriptionId, keys = [tenants.HOME]) {
  for (const k of keys) {
    const doc = await store.getDoc(docKey(subscriptionId), k).catch(() => null);
    if (doc) return { ...doc, tenant: doc.tenant || k };
  }
  return null;
}

function isRunning() {
  return Boolean(running);
}

module.exports = { collectAll, index, subscription, isRunning, summarize, collectSubscription, windows };
