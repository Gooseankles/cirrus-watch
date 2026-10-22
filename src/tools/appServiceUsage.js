// App Service plans: how hard their CPU and memory work. Reads the plans'
// CpuPercentage and MemoryPercentage metrics (hourly, last 7 days) and flags
// plans that run hot, plans far bigger than their load and plans with no apps
// that are still paid for. Each run also saves every plan's usage
// (app-service/usage.json in the tenant's history storage) for the Plans view.
// Free, Shared and Consumption plans have no such metrics and are skipped.
// Reader is enough.
const store = require("../findingsStore");
const tenants = require("../tenants");
const { resourceGraphQuery, armGet } = require("../armClient");
const { numberSetting, mapLimit, itemErrors } = require("./util");

const TOOL_ID = "app-service-usage";
const DAYS = 7;
const CONCURRENCY = 6;
const MAX_PLANS = 1000;
const MAX_APPS = 50; // app names kept per plan
const USAGE_KEY = "app-service/usage.json";
const METRICS_API = "api-version=2018-01-01";
const NO_METRICS = /^(free|shared|dynamic|flexconsumption)$/i;
const IDLE_CPU_PCT = 10; // p95 below this...
const IDLE_MEMORY_PCT = 50; // ...and this, on a plan that could be smaller

async function readPlans() {
  const [plans, sites] = await Promise.all([
    resourceGraphQuery(
      `Resources
      | where type =~ 'microsoft.web/serverfarms'
      | project id, name, subscriptionId, resourceGroup, location, kind,
          sku = tostring(sku.name), tier = tostring(sku.tier),
          workers = toint(properties.numberOfWorkers), sites = toint(properties.numberOfSites),
          zoneRedundant = tobool(properties.zoneRedundant)`,
      { toolId: TOOL_ID }
    ),
    resourceGraphQuery(
      `Resources
      | where type =~ 'microsoft.web/sites'
      | project name, plan = tolower(tostring(properties.serverFarmId)), state = tostring(properties.state)`,
      { toolId: TOOL_ID }
    ),
  ]);
  const apps = new Map();
  for (const s of sites) {
    if (!apps.has(s.plan)) apps.set(s.plan, []);
    apps.get(s.plan).push(s.state && s.state !== "Running" ? `${s.name} (${s.state.toLowerCase()})` : s.name);
  }
  return plans.slice(0, MAX_PLANS).map((p) => {
    const list = (apps.get(p.id.toLowerCase()) || []).sort();
    return {
      id: p.id,
      name: p.name,
      subscriptionId: p.subscriptionId,
      resourceGroup: p.resourceGroup,
      location: p.location,
      os: /linux/i.test(p.kind || "") ? "Linux" : "Windows",
      sku: p.sku,
      tier: p.tier,
      workers: p.workers || 1,
      apps: list.length || p.sites || 0,
      appNames: list.slice(0, MAX_APPS),
      zoneRedundant: Boolean(p.zoneRedundant),
    };
  });
}

// Average, 95th percentile and peak of one metric, plus its hourly averages.
function summarizeSeries(points) {
  const hourly = points.map((d) => (typeof d.average === "number" ? d.average : null));
  const values = hourly.filter((v) => v != null);
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const maxes = points.map((d) => d.maximum).filter((v) => typeof v === "number");
  const round = (v) => Math.round(v * 10) / 10;
  return {
    avg: round(values.reduce((a, b) => a + b, 0) / values.length),
    p95: round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]),
    peak: round(maxes.length ? Math.max(...maxes) : sorted[sorted.length - 1]),
    hours: values.length,
    hourly: hourly.map((v) => (v == null ? null : Math.round(v))),
  };
}

async function readMetrics(plan) {
  const end = new Date();
  const start = new Date(end.getTime() - DAYS * 86400000);
  const url =
    `https://management.azure.com${plan.id}/providers/Microsoft.Insights/metrics?${METRICS_API}` +
    `&metricnames=CpuPercentage,MemoryPercentage&aggregation=Average,Maximum&interval=PT1H` +
    `&timespan=${start.toISOString()}/${end.toISOString()}`;
  const data = await armGet(url, TOOL_ID);
  for (const m of data.value || []) {
    const points = (m.timeseries || [])[0]?.data || [];
    const s = summarizeSeries(points);
    if (/^cpupercentage$/i.test(m.name?.value || "")) plan.cpu = s;
    else if (/^memorypercentage$/i.test(m.name?.value || "")) plan.memory = s;
  }
}

// A smaller size or fewer instances exist: more than one instance, or a size
// number above 1 (S2, P2v3, B3 and so on).
const canShrink = (p) => p.workers > 1 || /^[a-z]+[2-9]/i.test(p.sku || "");
const sizeText = (p) => `${p.workers > 1 ? `${p.workers} × ` : ""}${p.sku || p.tier}`;
const appsText = (p) => `${p.apps} app${p.apps === 1 ? "" : "s"}`;

function planFindings(plans, { cpuWarn, memoryWarn }) {
  const out = [];
  for (const p of plans) {
    const base = { name: p.name, resourceGroup: p.resourceGroup, subscriptionId: p.subscriptionId };
    if (NO_METRICS.test(p.tier || "")) continue;
    if (!p.apps) {
      out.push({ ...base, kind: "appservice-plan-empty", id: `${p.id}#empty`, detail: `No apps on this plan, but its ${sizeText(p)} (${p.tier}) is still paid for. Delete it or move an app onto it` });
      continue;
    }
    const hot = (metric, label, warn, kind, advice) => {
      const s = p[metric];
      if (!s || s.p95 < warn) return false;
      const above = s.hourly.filter((v) => v != null && v >= warn).length;
      out.push({
        ...base,
        kind,
        id: `${p.id}#${metric}`,
        usedPct: s.p95,
        detail: `${label} above ${warn}% in ${above} of the last ${s.hours} hours (average ${Math.round(s.avg)}%, peak ${Math.round(s.peak)}%) on ${sizeText(p)} running ${appsText(p)}. ${advice}`,
      });
      return true;
    };
    const cpuHot = hot("cpu", "CPU", cpuWarn, "appservice-cpu-high", "Scale up or out, or find the app that uses it");
    const memHot = hot("memory", "Memory", memoryWarn, "appservice-memory-high", "Apps may restart or slow down; scale up or move an app to another plan");
    if (!cpuHot && !memHot && p.cpu && p.memory && p.cpu.p95 < IDLE_CPU_PCT && p.memory.p95 < IDLE_MEMORY_PCT && canShrink(p)) {
      out.push({
        ...base,
        kind: "appservice-plan-oversized",
        id: `${p.id}#oversized`,
        detail: `CPU at most ${Math.round(p.cpu.p95)}% and memory at most ${Math.round(p.memory.p95)}% in 95% of hours over ${DAYS} days on ${sizeText(p)}. A smaller size${p.workers > 1 ? " or fewer instances" : ""} would likely do`,
      });
    }
  }
  return out;
}

async function run() {
  const cpuWarn = numberSetting("APPSERVICE_CPU_WARN_PCT", 80, { min: 1, max: 100 });
  const memoryWarn = numberSetting("APPSERVICE_MEMORY_WARN_PCT", 85, { min: 1, max: 100 });
  const plans = await readPlans();
  const measured = plans.filter((p) => p.apps && !NO_METRICS.test(p.tier || ""));
  const failures = await mapLimit(measured, CONCURRENCY, readMetrics);
  const errors = itemErrors(TOOL_ID, "metrics", "App Service plans (CPU and memory)", failures, measured.length);
  await store.putDoc(USAGE_KEY, { updatedAt: new Date().toISOString(), days: DAYS, cpuWarn, memoryWarn, plans });
  return [...planFindings(plans, { cpuWarn, memoryWarn }), ...errors];
}

// --- Usage reads (the Plans view) ---

async function usage(keys) {
  const out = { updatedAt: null, days: DAYS, plans: [], failures: [] };
  for (const k of keys) {
    let doc;
    try {
      doc = await store.getDoc(USAGE_KEY, k);
    } catch (err) {
      out.failures.push({ tenant: k, error: `could not read the plan usage: ${err.message}` });
      continue;
    }
    if (!doc) continue;
    if (doc.updatedAt && (!out.updatedAt || doc.updatedAt > out.updatedAt)) {
      out.updatedAt = doc.updatedAt;
      out.cpuWarn = doc.cpuWarn;
      out.memoryWarn = doc.memoryWarn;
    }
    out.plans.push(...(doc.plans || []).map((p) => ({ ...p, ...(k !== tenants.HOME && { tenant: k }) })));
  }
  return out;
}

function registerRoutes(app, { readKeys, decorate }) {
  app.get("/api/app-service-usage", async (req, res) => {
    try {
      const u = await usage(readKeys(req));
      await decorate(TOOL_ID, u.plans);
      res.json(u);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  id: TOOL_ID,
  label: "App Service usage",
  schedule: "45 6 * * *", // daily at 06:45
  run,
  registerRoutes,
  _test: { summarizeSeries, planFindings, canShrink },
};
