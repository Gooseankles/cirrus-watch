// Azure Monitor: is everything watched, and does the watching work? Machines
// (VMs and Arc servers) with no Azure Monitor Agent, only the retired legacy
// agent, a failed agent, no data collection rule or no heartbeat; data
// collection rules that send to a deleted workspace or go unused; alert rules
// that are off, alert nobody, use a deleted action group or watch a deleted
// resource; action groups that are off, empty or unsubscribed; workspaces that
// hit their daily cap; machines whose data goes only to workspaces that no
// enabled log alert rule reads (alerts are tied to one workspace). Per tenant (AZURE_MONITOR_IN_USE): "auto" (default)
// checks a tenant that has the Azure Monitor Agent or a data collection rule and skips the others (one Resource Graph
// query); "on" always checks; "off" makes no request and finds nothing.
// Reader is enough; the heartbeat check queries each workspace through the Logs Query API.
const settings = require("../settings");
const store = require("../findingsStore");
const tenants = require("../tenants");
const tenantContext = require("../tenantContext");
const { resourceGraphQuery, logAnalyticsQuery, subscriptionIdsToScan } = require("../armClient");
const { numberSetting, mapLimit, runChecks, itemErrors, nameOf } = require("./util");

const TOOL_ID = "azure-monitor";
const INVENTORY_KEY = "azure-monitor/inventory.json";
const CONCURRENCY = 4;
const MAX_WORKSPACES = 50;
const SCOPE_CHUNK = 100;
const HEARTBEAT_DAYS = 7;

const AMA = ["azuremonitorwindowsagent", "azuremonitorlinuxagent"];
const LEGACY = ["microsoftmonitoringagent", "omsagentforlinux"];

// "on", "off" or "auto" (anything else, including an old blank value, is auto).
const mode = () => {
  const v = String(settings.get("AZURE_MONITOR_IN_USE") || "auto").toLowerCase();
  return v === "on" || v === "off" ? v : "auto";
};
const heartbeatHours = () => numberSetting("AZURE_MONITOR_HEARTBEAT_HOURS", 2, { min: 1, max: 168 });
// The workspaces alerts are set up on, when given (resource IDs or names); blank = read from the log alert rules.
const alertWorkspacesSetting = () => String(settings.get("AZURE_MONITOR_ALERT_WORKSPACES") || "");
const low = (s) => String(s || "").toLowerCase();
const subOf = (id) => (low(id).match(/^\/subscriptions\/([^/]+)/) || [])[1] || "";
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
// A loop, not /\/+$/: that regex takes quadratic time on a long run of slashes.
const trimSlash = (s) => {
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
};

/* ---------- machines ---------- */

// machines: [{ id, name, type, resourceGroup, subscriptionId, power, arcStatus, os }]
// exts: [{ machineId, extType, state }]; dcras: [{ resourceId, ruleId }];
// dcrs: [{ id, name, workspaces: [id] }]; heartbeats: Map(machineId -> ISO) or null per workspace failure;
// checked: Set of workspace ids whose heartbeats were read; reach: alertReach() (null = not judged).
function machineInventory({ machines, exts, dcras, dcrs, heartbeats, checked, reach = null }) {
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
    const sends = Boolean(ama) && low(ama.state) !== "failed" && workspaces.length > 0;
    const alerted = reach ? workspaces.filter((w) => reach.readsWorkspace(w)) : [];
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
      // Whether an enabled log alert can see its data: "workspace" (a rule reads a workspace it
      // sends to), "scope" (a rule on its subscription, resource group or itself), "none", or
      // null when not judged (no working agent, no rule sending to a workspace, or no reach given).
      alert: !reach || !sends ? null : alerted.length ? "workspace" : reach.coversResource(id, m.type) ? "scope" : "none",
      alertWorkspaces: alerted.map(nameOf),
      heartbeatChecked: seen.length > 0,
      lastHeartbeat: hb,
    };
  });
}

// reach: alertReach(), for the machines whose data no log alert reads (left out when not given).
function machineFindings(inv, { hours, now = Date.now(), reach = null }) {
  const out = [];
  const unread = [];
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
    if (reach && m.alert === "none") unread.push(m);
    if (!m.heartbeatChecked) continue;
    const age = m.lastHeartbeat ? (now - Date.parse(m.lastHeartbeat)) / 3600000 : Infinity;
    if (age > hours) {
      f(m, "monitor-no-heartbeat", m.lastHeartbeat
        ? `No heartbeat in ${m.workspaces.join(", ")} since ${m.lastHeartbeat.slice(0, 16).replace("T", " ")} UTC, although the machine is running`
        : `No heartbeat in ${m.workspaces.join(", ")} for ${HEARTBEAT_DAYS} days, although the machine is running and has a rule`);
    }
  }
  if (!unread.length) return out;
  // No log alert rule at all (and no workspaces named in Settings): one finding for the tenant, not one per machine.
  if (!reach.source) {
    const ws = [...new Set(unread.flatMap((m) => m.workspaces))];
    out.push({
      kind: "monitor-not-alerted",
      id: `${TOOL_ID}/log-alerts`,
      name: "Log alert rules",
      resourceGroup: null,
      subscriptionId: null,
      detail: `No enabled log alert rule in this tenant: no log search alert can fire for the ${unread.length} running machine${unread.length === 1 ? " that sends" : "s that send"} data to ${ws.slice(0, 3).join(", ")}${ws.length > 3 ? ", …" : ""}`,
    });
    return out;
  }
  for (const m of unread) {
    const many = m.workspaces.length > 1;
    f(m, "monitor-not-alerted", `Sends data to ${m.workspaces.join(", ")}, but no enabled log alert rule reads ${many ? "those workspaces" : "that workspace"}: no log search alert can fire on its logs`);
  }
  return out;
}

const WORKSPACE_RE = /\/providers\/microsoft\.operationalinsights\/workspaces\/[^/]+$/;

// Where enabled log alert rules (scheduled query rules, kind LogAlert) look. A rule
// scoped to a workspace reads what is sent there; one scoped to a subscription,
// resource group or resource (a resource-centric log alert) reads the logs of the
// resources under it, whichever workspace they go to (only those of its target
// resource types when it names any). override: AZURE_MONITOR_ALERT_WORKSPACES, a
// comma list of workspace resource IDs or names that replaces the workspaces read
// from the rules. source: "setting", "rules", or null when no enabled log alert rule exists.
function alertReach(rules, override = "") {
  const log = rules.filter((r) => r.kind === "Log" && r.enabled && low(r.ruleKind) !== "logtometric");
  const named = String(override || "").split(",").map((x) => trimSlash(low(x.trim()))).filter(Boolean);
  const ids = new Set();
  const names = new Set();
  const scopes = [];
  for (const r of log) {
    for (const raw of r.scopes) {
      const s = trimSlash(low(raw));
      if (WORKSPACE_RE.test(s)) {
        if (!named.length) ids.add(s);
      } else if (s) scopes.push({ scope: s, types: arr(r.targetTypes).map(low) });
    }
  }
  // Anything with a slash is a resource ID (a pasted one may lack the leading slash); the rest are names.
  for (const n of named) (n.includes("/") ? ids.add(n.startsWith("/") ? n : `/${n}`) : names.add(n));
  return {
    source: named.length ? "setting" : log.length ? "rules" : null,
    logRules: log.length,
    workspaces: [...ids].map(nameOf).concat([...names]),
    readsWorkspace: (w) => ids.has(low(w)) || names.has(nameOf(low(w))),
    coversResource: (id, type) => {
      const r = low(id);
      return scopes.some((s) => (r === s.scope || r.startsWith(`${s.scope}/`)) && (!s.types.length || s.types.includes(low(type))));
    },
  };
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
  let targetTypes = [];
  if (type === "microsoft.insights/metricalerts") {
    enabled = p.enabled !== false;
    groups = arr(p.actions).map((a) => a.actionGroupId);
    scopes = arr(p.scopes);
  } else if (type === "microsoft.insights/scheduledqueryrules") {
    enabled = p.enabled !== false && low(p.enabled) !== "false";
    groups = p.actions && Array.isArray(p.actions.actionGroups) ? p.actions.actionGroups : p.action && p.action.aznsAction ? arr(p.action.aznsAction.actionGroup) : [];
    scopes = p.scopes ? arr(p.scopes) : p.source && p.source.dataSourceId ? [p.source.dataSourceId] : [];
    targetTypes = arr(p.targetResourceTypes);
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
    ...(type === "microsoft.insights/scheduledqueryrules" && { ruleKind: r.kind || "LogAlert", targetTypes }),
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

/* ---------- coverage counts ---------- */

// One machine's coverage, the first thing wrong with it (the same order as the
// findings): "disconnected" (Arc), "noAgent", "legacy", "agentFailed", "noDcr",
// "noHeartbeat", else "monitored": the Azure Monitor Agent installed and not
// failed, at least one data collection rule and, where the heartbeat was read for
// a running machine, one within the last `hours`. A stopped VM is judged by its setup.
function machineStatus(m, hours, now = Date.now()) {
  if (m.kind === "Arc" && !m.running) return "disconnected";
  if (m.agent === "none") return "noAgent";
  if (m.agent === "legacy") return "legacy";
  if (low(m.agentState) === "failed") return "agentFailed";
  if (!(m.rules || []).length) return "noDcr";
  if (m.running && m.heartbeatChecked && (!m.lastHeartbeat || (now - Date.parse(m.lastHeartbeat)) / 3600000 > hours)) return "noHeartbeat";
  return "monitored";
}

const MACHINE_KEYS = ["total", "monitored", "running", "noAgent", "legacy", "agentFailed", "noDcr", "noHeartbeat", "disconnected"];
function machineCounts(list, hours, now) {
  const c = Object.fromEntries(MACHINE_KEYS.map((k) => [k, 0]));
  for (const m of list) {
    c.total++;
    if (m.running) c.running++;
    c[machineStatus(m, hours, now)]++;
  }
  return c;
}

// The counts at the top of the page, saved with the inventory. machines and
// rules as in the inventory (null when that check failed, so no false zeros);
// dcrs, groups, workspaces and scaleSets as read from Resource Graph (null = not read).
// scaleSets: [{ id, agent: "ama"|"legacy"|"none", rules: n }].
// Machines whose data an enabled log alert reads, out of all machines (VMs and Arc);
// null for an inventory saved before this was judged.
function alertCoverageOf(machines) {
  if (!Array.isArray(machines) || machines.some((m) => m.alert === undefined)) return null;
  const c = { total: machines.length, covered: 0, byWorkspace: 0, byScope: 0, notAlerted: 0, noData: 0 };
  for (const m of machines) {
    if (m.alert === "workspace") c.byWorkspace++;
    else if (m.alert === "scope") c.byScope++;
    else if (m.alert === "none") c.notAlerted++;
    else c.noData++;
  }
  c.covered = c.byWorkspace + c.byScope;
  return c;
}

function summaryOf({ machines, rules, dcrs = null, groups = null, workspaces = null, scaleSets = null, hours, now = Date.now() }) {
  const count = (x) => (Array.isArray(x) ? x.length : null);
  let sets = null;
  if (Array.isArray(scaleSets)) {
    sets = { total: scaleSets.length, monitored: 0, noAgent: 0, legacy: 0, noDcr: 0 };
    for (const v of scaleSets) sets[v.agent === "none" ? "noAgent" : v.agent === "legacy" ? "legacy" : v.rules ? "monitored" : "noDcr"]++;
  }
  return {
    vms: Array.isArray(machines) ? machineCounts(machines.filter((m) => m.kind !== "Arc"), hours, now) : null,
    arc: Array.isArray(machines) ? machineCounts(machines.filter((m) => m.kind === "Arc"), hours, now) : null,
    scaleSets: sets,
    alertRules: Array.isArray(rules) ? { total: rules.length, enabled: rules.filter((r) => r.enabled).length } : null,
    alertCoverage: alertCoverageOf(machines),
    dataCollectionRules: count(dcrs),
    actionGroups: count(groups),
    workspaces: count(workspaces),
  };
}

// Several tenants' summaries added up; a count one tenant could not read is unknown (null) in the total.
function addSummaries(list) {
  const add = (a, b) => {
    if (a === null || b === null || a === undefined || b === undefined) return null;
    if (typeof a === "number") return a + b;
    return Object.fromEntries(Object.keys(a).map((k) => [k, add(a[k], b[k])]));
  };
  return list.length ? list.reduce((acc, x) => Object.fromEntries(Object.keys(acc).map((k) => [k, add(acc[k], x[k])]))) : null;
}

/* ---------- reading Azure ---------- */

const q = (query) => resourceGraphQuery(query, { toolId: TOOL_ID });

async function readAll() {
  const [machines, exts, dcras, dcrRows, rules, groups, workspaces, scaleSets] = await Promise.all([
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
      | project id, name, type = tolower(type), kind, resourceGroup, subscriptionId, properties`),
    q(`Resources
      | where type =~ 'microsoft.insights/actiongroups'
      | project id, name, resourceGroup, subscriptionId, properties`),
    q(`Resources
      | where type =~ 'microsoft.operationalinsights/workspaces'
      | project id, name, resourceGroup, subscriptionId, customerId = tostring(properties.customerId),
        ingestion = tostring(properties.workspaceCapping.dataIngestionStatus), dailyCapGb = todouble(properties.workspaceCapping.dailyQuotaGb)`),
    // Scale sets only for the counts: whether the model has the agent. A failure leaves the count out.
    q(`Resources
      | where type =~ 'microsoft.compute/virtualmachinescalesets'
      | extend e = tolower(tostring(properties.virtualMachineProfile.extensionProfile.extensions))
      | project id, ama = e has '${AMA[0]}' or e has '${AMA[1]}', legacy = e has '${LEGACY[0]}' or e has '${LEGACY[1]}'`).catch(() => null),
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
  return { machines, exts, scaleSets, dcras: Array.isArray(dcras) ? dcras : [], dcrasError: Array.isArray(dcras) ? null : dcras, dcrs, rules: rules.map(ruleOf), groups: groups.map(groupOf), workspaces };
}

// Last heartbeat per machine from each workspace the running machines send to.
// workspaceIds are ARM resource IDs; customerIds maps them (lower case) to the
// workspace ID the Logs Query API v1 wants (properties.customerId from Resource Graph).
async function readHeartbeats(workspaceIds, customerIds = new Map()) {
  const heartbeats = new Map();
  const checked = new Set();
  const list = workspaceIds.slice(0, MAX_WORKSPACES);
  const query = `Heartbeat | where TimeGenerated > ago(${HEARTBEAT_DAYS}d) | summarize last = max(TimeGenerated) by rid = tolower(_ResourceId)`;
  const failures = await mapLimit(list, CONCURRENCY, async (ws) => {
    const customerId = customerIds.get(low(ws));
    if (!customerId) throw new Error(`no workspace ID (customerId) for ${ws} in Resource Graph`);
    const data = await logAnalyticsQuery(customerId, { query }, TOOL_ID);
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

// Auto mode: does the tenant use Azure Monitor at all? Any Azure Monitor Agent or data collection rule says yes.
async function foundInTenant() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.insights/datacollectionrules'
      or (type in~ ('microsoft.compute/virtualmachines/extensions', 'microsoft.hybridcompute/machines/extensions')
        and tolower(tostring(properties.type)) in ('${AMA.join("', '")}'))
    | take 1 | project id`);
  return rows.length > 0;
}

async function run() {
  const m = mode();
  if (m === "off" || (m === "auto" && !(await foundInTenant()))) {
    await store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), off: true, reason: m, machines: [], rules: [] });
    return [];
  }
  const [data, subs] = await Promise.all([readAll(), subscriptionIdsToScan(TOOL_ID)]);
  const scannedSubs = new Set(subs.map(low));
  const workspaceIds = new Set(data.workspaces.map((w) => low(w.id)));
  const reach = alertReach(data.rules, alertWorkspacesSetting());
  let machines = [];
  let rulesOut = [];
  let machinesOk = false;

  const checks = {
    Machines: async () => {
      if (data.dcrasError) throw new Error(`could not read data collection rule links: ${data.dcrasError.message}`);
      // Heartbeats only from workspaces a running, agent-equipped machine sends to.
      const pre = machineInventory({ ...data, heartbeats: new Map(), checked: new Set() });
      const wanted = [...new Set(pre.filter((m) => m.running && m.agent === "ama" && m.rules.length).flatMap((m) => {
        const ruleIds = data.dcras.filter((a) => low(a.resourceId) === low(m.id)).map((a) => low(a.ruleId));
        return data.dcrs.filter((d) => ruleIds.includes(low(d.id))).flatMap((d) => d.workspaces);
      }).map(low))].filter((w) => workspaceIds.has(w));
      const hb = await readHeartbeats(wanted, new Map(data.workspaces.map((w) => [low(w.id), w.customerId])));
      machines = machineInventory({ ...data, heartbeats: hb.heartbeats, checked: hb.checked, reach });
      machinesOk = true;
      const errs = itemErrors(TOOL_ID, "heartbeats", "workspaces (heartbeat query; needs Reader or Log Analytics Reader)", hb.failures.map((f) => ({ ...f, item: { subscriptionId: subOf(f.item) } })), hb.total);
      return [...machineFindings(machines, { hours: heartbeatHours(), reach }), ...dcrFindings(data.dcrs, data.dcras, workspaceIds, scannedSubs), ...errs];
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
  const ruled = new Set(data.dcras.map((a) => low(a.resourceId)));
  const scaleSets = Array.isArray(data.scaleSets) && !data.dcrasError
    ? data.scaleSets.map((v) => ({ id: v.id, agent: v.ama ? "ama" : v.legacy ? "legacy" : "none", rules: ruled.has(low(v.id)) ? 1 : 0 }))
    : null;
  const summary = summaryOf({ machines: machinesOk ? machines : null, rules: data.rules, dcrs: data.dcrs, groups: data.groups, workspaces: data.workspaces, scaleSets, hours: heartbeatHours() });
  // alertWorkspaces: where the log alerts look, for the line on the Machines tab (inventory() hands it on as saved).
  await store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), off: false, machines, rules: rulesOut, summary, alertWorkspaces: { source: reach.source, names: reach.workspaces } });
  return findings;
}

/* ---------- read routes ---------- */

// Each tenant's machines and alert rules from its last scan, and which tenants were not checked:
// reason "off" (set to No) or "auto" (Auto found no agent or data collection rule at the last scan).
async function inventory(keys) {
  const out = { updatedAt: null, machines: [], rules: [], off: [], failures: [], summary: null, alertWorkspaces: [] };
  const summaries = [];
  for (const k of keys) {
    const t = tenants.byKey(k);
    const m = t ? await tenantContext.runIn(t, async () => mode()) : "off";
    let doc;
    try {
      doc = await store.getDoc(INVENTORY_KEY, k);
    } catch (err) {
      if (m === "off") out.off.push({ key: k, name: tenants.nameOf(k), reason: "off" });
      out.failures.push({ tenant: k, error: `could not read the inventory: ${err.message}` });
      continue;
    }
    if (m === "off") out.off.push({ key: k, name: tenants.nameOf(k), reason: "off" });
    else if (doc && doc.off && doc.reason === "auto" && m === "auto") out.off.push({ key: k, name: tenants.nameOf(k), reason: "auto" });
    // A doc saved while the check was off (turned on since, not scanned yet) has no counts to add.
    if (!doc || doc.off || m === "off") continue;
    if (doc.updatedAt && (!out.updatedAt || doc.updatedAt > out.updatedAt)) out.updatedAt = doc.updatedAt;
    const tag = (x) => ({ ...x, ...(k !== tenants.HOME && { tenant: k }) });
    out.machines.push(...(doc.machines || []).map(tag));
    out.rules.push(...(doc.rules || []).map(tag));
    if (doc.alertWorkspaces) out.alertWorkspaces.push({ tenant: k, name: tenants.nameOf(k), ...doc.alertWorkspaces });
    // A scan from before the counts were saved: what its machine and rule lists give.
    summaries.push(doc.summary || summaryOf({ machines: doc.machines || [], rules: doc.rules || [], hours: heartbeatHours(), now: Date.parse(doc.updatedAt) || Date.now() }));
  }
  out.summary = addSummaries(summaries);
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
  _test: { machineInventory, machineFindings, machineStatus, summaryOf, alertReach, alertCoverageOf, alertWorkspacesSetting, addSummaries, dcrFindings, ruleOf, groupOf, scopeResource, alertFindings, workspaceFindings, mode, foundInTenant },
};
