// Azure Monitor: is everything watched, and does the watching work? Machines
// (VMs and Arc servers) with no Azure Monitor Agent, only the retired legacy
// agent, a failed agent, no data collection rule or no heartbeat; data
// collection rules that send to a deleted workspace or go unused; alert rules
// that are off, alert nobody, use a deleted action group or watch a deleted
// resource; action groups that are off, empty or unsubscribed; workspaces that
// hit their daily cap. Off per tenant (AZURE_MONITOR_IN_USE) for customers who
// do not use Azure Monitor: then no request is made and nothing is found.
// Reader is enough; the heartbeat check queries each workspace through ARM.
const settings = require("../settings");
const store = require("../findingsStore");
const tenants = require("../tenants");
const tenantContext = require("../tenantContext");
const { resourceGraphQuery, armPost, subscriptionIdsToScan } = require("../armClient");
const { numberSetting, mapLimit, runChecks, itemErrors, nameOf } = require("./util");

const TOOL_ID = "azure-monitor";
const INVENTORY_KEY = "azure-monitor/inventory.json";
const CONCURRENCY = 4;
const MAX_WORKSPACES = 50;
const SCOPE_CHUNK = 100;
const HEARTBEAT_DAYS = 7;

const AMA = ["azuremonitorwindowsagent", "azuremonitorlinuxagent"];
const LEGACY = ["microsoftmonitoringagent", "omsagentforlinux"];

const inUse = () => String(settings.get("AZURE_MONITOR_IN_USE") || "off").toLowerCase() === "on";
const heartbeatHours = () => numberSetting("AZURE_MONITOR_HEARTBEAT_HOURS", 2, { min: 1, max: 168 });
const low = (s) => String(s || "").toLowerCase();
const subOf = (id) => (low(id).match(/^\/subscriptions\/([^/]+)/) || [])[1] || "";
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);

/* ---------- machines ---------- */

// machines: [{ id, name, type, resourceGroup, subscriptionId, power, arcStatus, os }]
// exts: [{ machineId, extType, state }]; dcras: [{ resourceId, ruleId }];
// dcrs: [{ id, name, workspaces: [id] }]; heartbeats: Map(machineId -> ISO) or null per workspace failure;
// checked: Set of workspace ids whose heartbeats were read.
function machineInventory({ machines, exts, dcras, dcrs, heartbeats, checked }) {
  const extsBy = new Map();
  for (const e of exts) {
    const k = low(e.machineId);
    if (!extsBy.has(k)) extsBy.set(k, []);
    extsBy.get(k).push(e);
  }
  const dcrById = new Map(dcrs.map((d) => [low(d.id), d]));
  const rulesBy = new Map();
  for (const a of dcras) {
    const k = low(a.resourceId);
    if (!rulesBy.has(k)) rulesBy.set(k, []);
    rulesBy.get(k).push(low(a.ruleId));
  }
  return machines.map((m) => {
    const id = low(m.id);
    const arc = low(m.type) === "microsoft.hybridcompute/machines";
    const list = extsBy.get(id) || [];
    const ama = list.find((e) => AMA.includes(low(e.extType)));
    const legacy = list.find((e) => LEGACY.includes(low(e.extType)));
    const ruleIds = rulesBy.get(id) || [];
    const rules = ruleIds.map((r) => dcrById.get(r)).filter(Boolean);
    const workspaces = [...new Set(rules.flatMap((r) => r.workspaces.map(low)))];
    const seen = workspaces.filter((w) => checked.has(w));
    const hb = heartbeats.get(id) || null;
    const running = arc ? low(m.arcStatus) === "connected" : !m.power || low(m.power) === "powerstate/running";
    return {
      id: m.id,
      name: m.name,
      kind: arc ? "Arc" : "VM",
      os: m.os || null,
      resourceGroup: m.resourceGroup,
      subscriptionId: m.subscriptionId,
      state: arc ? m.arcStatus || "Unknown" : running ? "Running" : String(m.power || "").replace(/^PowerState\//i, "") || "Stopped",
      running,
      agent: ama ? "ama" : legacy ? "legacy" : "none",
      agentState: (ama || legacy || {}).state || null,
      rules: ruleIds.map((r) => (dcrById.get(r) ? dcrById.get(r).name : nameOf(r))),
      workspaces: workspaces.map(nameOf),
      heartbeatChecked: seen.length > 0,
      lastHeartbeat: hb,
    };
  });
}

function machineFindings(inv, { hours, now = Date.now() }) {
  const out = [];
  const f = (m, kind, detail) => out.push({ kind, id: `${m.id}#monitor`, name: m.name, resourceGroup: m.resourceGroup, subscriptionId: m.subscriptionId, detail });
  for (const m of inv) {
    if (m.kind === "Arc" && !m.running) {
      f(m, "monitor-arc-disconnected", `Arc server is ${m.state}: Azure cannot reach its agent, so nothing from it is collected`);
      continue;
    }
    if (!m.running) continue;
    if (m.agent === "none") {
      f(m, "monitor-no-agent", `${m.kind === "Arc" ? "Arc server" : "Running VM"} has no Azure Monitor Agent: no logs, performance data or heartbeat from it`);
      continue;
    }
    if (m.agent === "legacy") {
      f(m, "monitor-legacy-agent", "Only the legacy Log Analytics agent (MMA/OMS), retired in August 2024; move it to the Azure Monitor Agent");
      continue;
    }
    if (low(m.agentState) === "failed") {
      f(m, "monitor-agent-failed", "The Azure Monitor Agent extension failed to install or update; reinstall it from the machine's Extensions");
      continue;
    }
    if (!m.rules.length) {
      f(m, "monitor-no-dcr", "Azure Monitor Agent is installed but no data collection rule is linked, so it collects nothing");
      continue;
    }
    if (!m.heartbeatChecked) continue;
    const age = m.lastHeartbeat ? (now - Date.parse(m.lastHeartbeat)) / 3600000 : Infinity;
    if (age > hours) {
      f(m, "monitor-no-heartbeat", m.lastHeartbeat
        ? `No heartbeat in ${m.workspaces.join(", ")} since ${m.lastHeartbeat.slice(0, 16).replace("T", " ")} UTC, although the machine is running`
        : `No heartbeat in ${m.workspaces.join(", ")} for ${HEARTBEAT_DAYS} days, although the machine is running and has a rule`);
    }
  }
  return out;
}

// dcrs: [{ id, name, resourceGroup, subscriptionId, workspaces, collects }]
function dcrFindings(dcrs, dcras, workspaceIds, scannedSubs) {
  const used = new Set(dcras.map((a) => low(a.ruleId)));
  const out = [];
  for (const d of dcrs) {
    const base = { id: `${d.id}#monitor`, name: d.name, resourceGroup: d.resourceGroup, subscriptionId: d.subscriptionId };
    const gone = d.workspaces.filter((w) => !workspaceIds.has(low(w)) && scannedSubs.has(subOf(w)));
    if (gone.length) out.push({ ...base, kind: "dcr-destination-missing", detail: `Sends to a workspace that no longer exists (${gone.map(nameOf).join(", ")}); what it collects is lost` });
    else if (d.collects && !used.has(low(d.id))) out.push({ ...base, kind: "dcr-unused", detail: "Data collection rule with data sources but no machine linked to it" });
  }
  return out;
}

/* ---------- alerts ---------- */

const RULE_KINDS = {
  "microsoft.insights/metricalerts": "Metric",
  "microsoft.insights/scheduledqueryrules": "Log",
  "microsoft.insights/activitylogalerts": "Activity log",
  "microsoft.alertsmanagement/smartdetectoralertrules": "Smart detector",
};

// One alert rule from its Resource Graph row: on or off, its action groups and scopes.
function ruleOf(r) {
  const p = r.properties || {};
  const type = low(r.type);
  let enabled;
  let groups;
  let scopes;
  if (type === "microsoft.insights/metricalerts") {
    enabled = p.enabled !== false;
    groups = arr(p.actions).map((a) => a.actionGroupId);
    scopes = arr(p.scopes);
  } else if (type === "microsoft.insights/scheduledqueryrules") {
    enabled = p.enabled !== false && low(p.enabled) !== "false";
    groups = p.actions && Array.isArray(p.actions.actionGroups) ? p.actions.actionGroups : p.action && p.action.aznsAction ? arr(p.action.aznsAction.actionGroup) : [];
    scopes = p.scopes ? arr(p.scopes) : p.source && p.source.dataSourceId ? [p.source.dataSourceId] : [];
  } else if (type === "microsoft.insights/activitylogalerts") {
    enabled = p.enabled !== false;
    groups = p.actions ? arr(p.actions.actionGroups).map((a) => a.actionGroupId) : [];
    scopes = arr(p.scopes);
  } else {
    enabled = low(p.state) !== "disabled";
    groups = p.actionGroups ? arr(p.actionGroups.groupIds) : [];
    scopes = arr(p.scope);
  }
  return {
    id: r.id,
    name: r.name,
    kind: RULE_KINDS[type] || type,
    resourceGroup: r.resourceGroup,
    subscriptionId: r.subscriptionId,
    enabled,
    severity: p.severity !== undefined && p.severity !== null ? Number(p.severity) : null,
    actionGroups: groups.filter(Boolean),
    scopes: scopes.filter(Boolean),
  };
}

// The resource a scope names, as Resource Graph lists it: a child resource
// (a SQL database, a storage blob service) by its top-level parent. Null for
// a subscription or resource group scope.
function scopeResource(id) {
  const parts = String(id || "").split("/");
  if (parts.length < 9 || low(parts[5]) !== "providers") return null;
  return low(parts.slice(0, 9).join("/"));
}

function alertFindings(rules, groups, existing, scannedSubs) {
  const groupById = new Map(groups.map((g) => [low(g.id), g]));
  const out = [];
  const used = new Map(); // action group id -> rule names
  for (const r of rules) {
    const base = { id: `${r.id}#monitor`, name: r.name, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId };
    if (!r.enabled) {
      out.push({ ...base, kind: "alert-disabled", detail: `${r.kind} alert rule is turned off` });
      continue;
    }
    for (const g of r.actionGroups) {
      const k = low(g);
      if (!used.has(k)) used.set(k, []);
      used.get(k).push(r.name);
    }
    if (!r.actionGroups.length) out.push({ ...base, kind: "alert-no-action", detail: `${r.kind} alert rule has no action group: it fires, but nobody is told` });
    const missing = r.actionGroups.filter((g) => !groupById.has(low(g)) && scannedSubs.has(subOf(g)));
    if (missing.length) out.push({ ...base, kind: "alert-action-group-missing", detail: `Uses an action group that no longer exists (${missing.map(nameOf).join(", ")})` });
    const gone = [...new Set(r.scopes.map(scopeResource).filter((s) => s && scannedSubs.has(subOf(s)) && !existing.has(s)))];
    if (gone.length) out.push({ ...base, kind: "alert-scope-missing", detail: `Watches a resource that no longer exists (${gone.map(nameOf).join(", ")}), so it can never fire` });
  }
  for (const [k, names] of used) {
    const g = groupById.get(k);
    if (!g) continue;
    const base = { id: `${g.id}#monitor`, name: g.name, resourceGroup: g.resourceGroup, subscriptionId: g.subscriptionId };
    const by = `used by ${names.length} rule${names.length === 1 ? "" : "s"}: ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`;
    if (!g.enabled) out.push({ ...base, kind: "action-group-disabled", detail: `Action group is turned off, so its alerts reach nobody (${by})` });
    else if (!g.receivers) out.push({ ...base, kind: "action-group-empty", detail: `Action group has no email, SMS, webhook or other receiver (${by})` });
    else if (g.emailOff.length) out.push({ ...base, kind: "action-group-email-off", detail: `${g.emailOff.length} email receiver${g.emailOff.length === 1 ? " has" : "s have"} unsubscribed (${g.emailOff.join(", ")}); ${by}` });
  }
  return out;
}

function groupOf(r) {
  const p = r.properties || {};
  let receivers = 0;
  for (const [k, v] of Object.entries(p)) if (/Receivers$/.test(k) && Array.isArray(v)) receivers += v.length;
  return {
    id: r.id,
    name: r.name,
    resourceGroup: r.resourceGroup,
    subscriptionId: r.subscriptionId,
    enabled: p.enabled !== false,
    receivers,
    emailOff: arr(p.emailReceivers).filter((e) => low(e.status) === "disabled").map((e) => e.name),
  };
}

/* ---------- workspaces ---------- */

function workspaceFindings(rows) {
  const out = [];
  for (const w of rows) {
    const base = { id: `${w.id}#monitor`, name: w.name, resourceGroup: w.resourceGroup, subscriptionId: w.subscriptionId };
    const status = low(w.ingestion);
    const cap = w.dailyCapGb > 0 ? ` (daily cap ${w.dailyCapGb} GB)` : "";
    if (status === "overquota" || status === "forceoff") out.push({ ...base, kind: "workspace-over-quota", detail: `Hit its daily cap${cap}: new logs are dropped until the cap resets` });
    else if (status === "approachingquota") out.push({ ...base, kind: "workspace-near-quota", detail: `Close to its daily cap${cap}; logs stop when it is reached` });
  }
  return out;
}

/* ---------- reading Azure ---------- */

const q = (query) => resourceGraphQuery(query, { toolId: TOOL_ID });

async function readAll() {
  const [machines, exts, dcras, dcrRows, rules, groups, workspaces] = await Promise.all([
    q(`Resources
      | where type in~ ('microsoft.compute/virtualmachines', 'microsoft.hybridcompute/machines')
      | project id, name, type = tolower(type), resourceGroup, subscriptionId,
        power = tostring(properties.extended.instanceView.powerState.code), arcStatus = tostring(properties.status),
        os = tostring(coalesce(properties.storageProfile.osDisk.osType, properties.osType))`),
    q(`Resources
      | where type in~ ('microsoft.compute/virtualmachines/extensions', 'microsoft.hybridcompute/machines/extensions')
      | extend extType = tolower(tostring(properties.type))
      | where extType in ('${[...AMA, ...LEGACY].join("', '")}')
      | project machineId = substring(id, 0, indexof(tolower(id), '/extensions/')), extType, state = tostring(properties.provisioningState)`),
    q(`InsightsResources
      | where type =~ 'microsoft.insights/datacollectionruleassociations'
      | extend ruleId = tostring(properties.dataCollectionRuleId)
      | where isnotempty(ruleId)
      | project resourceId = substring(id, 0, indexof(tolower(id), '/providers/microsoft.insights/datacollectionruleassociations')), ruleId`).catch((err) => err),
    q(`Resources
      | where type =~ 'microsoft.insights/datacollectionrules'
      | project id, name, resourceGroup, subscriptionId, destinations = properties.destinations, dataSources = properties.dataSources`),
    q(`Resources
      | where type in~ ('${Object.keys(RULE_KINDS).join("', '")}')
      | project id, name, type = tolower(type), resourceGroup, subscriptionId, properties`),
    q(`Resources
      | where type =~ 'microsoft.insights/actiongroups'
      | project id, name, resourceGroup, subscriptionId, properties`),
    q(`Resources
      | where type =~ 'microsoft.operationalinsights/workspaces'
      | project id, name, resourceGroup, subscriptionId,
        ingestion = tostring(properties.workspaceCapping.dataIngestionStatus), dailyCapGb = todouble(properties.workspaceCapping.dailyQuotaGb)`),
  ]);
  const dcrs = dcrRows.map((d) => ({
    id: d.id,
    name: d.name,
    resourceGroup: d.resourceGroup,
    subscriptionId: d.subscriptionId,
    workspaces: arr(d.destinations && d.destinations.logAnalytics).map((x) => x.workspaceResourceId).filter(Boolean),
    collects: Boolean(d.dataSources && Object.values(d.dataSources).some((v) => Array.isArray(v) && v.length)),
  }));
  // Without the rule links every machine would look unlinked: the machine check fails instead.
  return { machines, exts, dcras: Array.isArray(dcras) ? dcras : [], dcrasError: Array.isArray(dcras) ? null : dcras, dcrs, rules: rules.map(ruleOf), groups: groups.map(groupOf), workspaces };
}

// Last heartbeat per machine from each workspace the running machines send to.
async function readHeartbeats(workspaceIds) {
  const heartbeats = new Map();
  const checked = new Set();
  const list = workspaceIds.slice(0, MAX_WORKSPACES);
  const query = `Heartbeat | where TimeGenerated > ago(${HEARTBEAT_DAYS}d) | summarize last = max(TimeGenerated) by rid = tolower(_ResourceId)`;
  const failures = await mapLimit(list, CONCURRENCY, async (ws) => {
    const data = await armPost(`https://management.azure.com${ws}/api/query?api-version=2017-01-01-preview`, { query }, TOOL_ID);
    const table = (data.tables || [])[0] || { columns: [], rows: [] };
    const iRid = table.columns.findIndex((c) => c.name === "rid");
    const iLast = table.columns.findIndex((c) => c.name === "last");
    for (const row of table.rows || []) {
      const rid = low(row[iRid]);
      const last = row[iLast];
      if (rid && last && (!heartbeats.has(rid) || heartbeats.get(rid) < last)) heartbeats.set(rid, last);
    }
    checked.add(low(ws));
  });
  return { heartbeats, checked, failures, total: list.length, capped: workspaceIds.length > MAX_WORKSPACES };
}

// Which scope resources still exist, in chunks (a Resource Graph query must stay short).
async function existingResources(ids) {
  const found = new Set();
  for (let i = 0; i < ids.length; i += SCOPE_CHUNK) {
    const chunk = ids.slice(i, i + SCOPE_CHUNK);
    const rows = await q(`Resources | where tolower(id) in (${chunk.map((x) => `'${x.replace(/'/g, "")}'`).join(", ")}) | project id = tolower(id)`);
    for (const r of rows) found.add(r.id);
  }
  return found;
}

async function run() {
  if (!inUse()) {
    await store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), off: true, machines: [], rules: [] });
    return [];
  }
  const [data, subs] = await Promise.all([readAll(), subscriptionIdsToScan(TOOL_ID)]);
  const scannedSubs = new Set(subs.map(low));
  const workspaceIds = new Set(data.workspaces.map((w) => low(w.id)));
  let machines = [];
  let rulesOut = [];

  const checks = {
    Machines: async () => {
      if (data.dcrasError) throw new Error(`could not read data collection rule links: ${data.dcrasError.message}`);
      // Heartbeats only from workspaces a running, agent-equipped machine sends to.
      const pre = machineInventory({ ...data, heartbeats: new Map(), checked: new Set() });
      const wanted = [...new Set(pre.filter((m) => m.running && m.agent === "ama" && m.rules.length).flatMap((m) => {
        const ruleIds = data.dcras.filter((a) => low(a.resourceId) === low(m.id)).map((a) => low(a.ruleId));
        return data.dcrs.filter((d) => ruleIds.includes(low(d.id))).flatMap((d) => d.workspaces);
      }).map(low))].filter((w) => workspaceIds.has(w));
      const hb = await readHeartbeats(wanted);
      machines = machineInventory({ ...data, heartbeats: hb.heartbeats, checked: hb.checked });
      const errs = itemErrors(TOOL_ID, "heartbeats", "workspaces (heartbeat query; needs Reader or Log Analytics Reader)", hb.failures.map((f) => ({ ...f, item: { subscriptionId: subOf(f.item) } })), hb.total);
      return [...machineFindings(machines, { hours: heartbeatHours() }), ...dcrFindings(data.dcrs, data.dcras, workspaceIds, scannedSubs), ...errs];
    },
    Alerts: async () => {
      const scopeIds = [...new Set(data.rules.filter((r) => r.enabled).flatMap((r) => r.scopes.map(scopeResource)).filter((s) => s && scannedSubs.has(subOf(s))))];
      const existing = await existingResources(scopeIds);
      const groupName = new Map(data.groups.map((g) => [low(g.id), g.name]));
      rulesOut = data.rules.map((r) => ({ ...r, actionGroups: r.actionGroups.map((g) => groupName.get(low(g)) || (scannedSubs.has(subOf(g)) ? `${nameOf(g)} (missing)` : nameOf(g))), scopes: r.scopes.map(nameOf) }));
      return alertFindings(data.rules, data.groups, existing, scannedSubs);
    },
    Workspaces: async () => workspaceFindings(data.workspaces),
  };
  const findings = await runChecks(TOOL_ID, checks);
  await store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), off: false, machines, rules: rulesOut });
  return findings;
}

/* ---------- read routes ---------- */

// Each tenant's machines and alert rules from its last scan, and which tenants have the check off.
async function inventory(keys) {
  const out = { updatedAt: null, machines: [], rules: [], off: [], failures: [] };
  for (const k of keys) {
    const t = tenants.byKey(k);
    const on = t ? await tenantContext.runIn(t, async () => inUse()) : false;
    if (!on) out.off.push({ key: k, name: tenants.nameOf(k) });
    let doc;
    try {
      doc = await store.getDoc(INVENTORY_KEY, k);
    } catch (err) {
      out.failures.push({ tenant: k, error: `could not read the inventory: ${err.message}` });
      continue;
    }
    if (!doc || !on) continue;
    if (doc.updatedAt && (!out.updatedAt || doc.updatedAt > out.updatedAt)) out.updatedAt = doc.updatedAt;
    const tag = (x) => ({ ...x, ...(k !== tenants.HOME && { tenant: k }) });
    out.machines.push(...(doc.machines || []).map(tag));
    out.rules.push(...(doc.rules || []).map(tag));
  }
  return out;
}

function registerRoutes(app, { readKeys, decorate }) {
  app.get("/api/azure-monitor", async (req, res) => {
    try {
      const inv = await inventory(readKeys(req));
      await decorate(TOOL_ID, [...inv.machines, ...inv.rules]);
      res.json({ ...inv, heartbeatHours: heartbeatHours() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Azure Monitor",
  schedule: "55 4 * * *", // daily at 04:55
  run,
  registerRoutes,
  _test: { machineInventory, machineFindings, dcrFindings, ruleOf, groupOf, scopeResource, alertFindings, workspaceFindings, inUse },
};
