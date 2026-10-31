// Connectivity that is broken right now, the kind an MSP gets tickets for:
// site-to-site and VNet-to-VNet VPN connections that are not connected,
// ExpressRoute circuits not provisioned or with private peering off, VPN and
// ExpressRoute gateways in a failed state, private endpoints still waiting for
// approval or with no private DNS zone group (names likely resolve to the public
// address), and load balancing with unhealthy backends: Application Gateway
// (UnhealthyHostCount), Standard load balancers (health probe status) and Front
// Door (origin health), from the last hour of Azure Monitor metrics.
// Private endpoints that were rejected or disconnected are left to Orphaned
// resources. Reader is enough: Resource Graph, one ARM GET per connection for
// its live status, one per private endpoint for its DNS zone groups and one
// metrics call per load balancer, gateway or profile (each capped).
const { resourceGraphQuery, armGet } = require("../armClient");
const settings = require("../settings");
const { numberSetting, mapLimit, runChecks, itemErrors, scanError, nameOf } = require("./util");

const TOOL_ID = "connectivity";
const NETWORK_API = "2024-05-01";
const METRICS_API = "2018-01-01";
const CONCURRENCY = 8;
const MAX_CONNECTIONS = 500;
const MAX_ENDPOINTS = 500;
const MAX_METRIC_RESOURCES = 200; // per kind of load balancing

const rgOf = (id) => (String(id).match(/\/resourceGroups\/([^/]+)/i) || [])[1] || null;
const subOf = (id) => (String(id).match(/^\/subscriptions\/([^/]+)/i) || [])[1] || null;
const q = (query) => resourceGraphQuery(query, { toolId: TOOL_ID });

function base(r, suffix) {
  return {
    id: `${r.id}#${suffix}`,
    name: r.name || nameOf(r.id),
    resourceGroup: r.resourceGroup || rgOf(r.id),
    subscriptionId: r.subscriptionId || subOf(r.id),
  };
}

const list = (names, max = 5) => (names.length > max ? `${names.slice(0, max).join(", ")} and ${names.length - max} more` : names.join(", "));

/* ---------- VPN connections ---------- */

const DOWN = new Set(["notconnected", "unknown", "connecting"]);

// rows: [{ id, name, resourceGroup, subscriptionId, connectionType, status, provisioningState, peer }], status from
// the connection's own ARM GET. Pure, for the tests.
function judgeConnections(rows) {
  const out = [];
  for (const r of rows) {
    if (!/^(ipsec|vnet2vnet)$/i.test(r.connectionType || "")) continue;
    const status = String(r.status || "").toLowerCase();
    const failed = /^failed$/i.test(r.provisioningState || "");
    if (!failed && !DOWN.has(status)) continue;
    const what = /^vnet2vnet$/i.test(r.connectionType) ? "VNet-to-VNet connection" : "Site-to-site VPN connection";
    const to = r.peer ? ` to ${nameOf(r.peer)}` : "";
    const state = failed ? "is in a failed state" : status === "connecting" ? "is stuck connecting" : `is ${r.status}`;
    out.push({
      ...base(r, "vpn-down"),
      kind: "conn-vpn-down",
      status: r.status || null,
      detail: `${what}${to} ${state}: traffic over it is not getting through. Check the on-premises device, the shared key and the IPsec settings on both sides, and the gateway's connection troubleshooter`,
    });
  }
  return out;
}

async function connections() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.network/connections'
    | extend connectionType = tostring(properties.connectionType)
    | where connectionType in~ ('IPsec', 'Vnet2Vnet')
    | project id, name, resourceGroup, subscriptionId, connectionType, status = tostring(properties.connectionStatus),
        provisioningState = tostring(properties.provisioningState),
        peer = iff(connectionType =~ 'Vnet2Vnet', tostring(properties.virtualNetworkGateway2.id), tostring(properties.localNetworkGateway2.id))`);
  // Resource Graph does not keep the live status up to date; the connection's own GET has it.
  const todo = rows.slice(0, MAX_CONNECTIONS);
  const failures = await mapLimit(todo, CONCURRENCY, async (r) => {
    const live = await armGet(`https://management.azure.com${r.id}?api-version=${NETWORK_API}`, TOOL_ID);
    const p = (live && live.properties) || {};
    r.status = p.connectionStatus || r.status;
    r.provisioningState = p.provisioningState || r.provisioningState;
  });
  const failedIds = new Set(failures.map((f) => f.item.id));
  const out = judgeConnections(todo.filter((r) => !failedIds.has(r.id)));
  out.push(...itemErrors(TOOL_ID, "connections", "VPN connections", failures, todo.length));
  if (rows.length > todo.length) out.push(scanError(TOOL_ID, "connections-cap", `${rows.length - todo.length} of ${rows.length} VPN connections not checked`, `Only the first ${MAX_CONNECTIONS} are checked each run`));
  return out;
}

/* ---------- ExpressRoute circuits ---------- */

// rows: [{ id, name, resourceGroup, subscriptionId, providerState, circuitState, provider, peerings: [{ name, properties: { peeringType, state } }] }].
// Pure, for the tests.
function judgeCircuits(rows) {
  const out = [];
  for (const r of rows) {
    const provider = r.provider ? ` with ${r.provider}` : "";
    if (r.providerState && !/^provisioned$/i.test(r.providerState)) {
      out.push({ ...base(r, "er-provider"), kind: "conn-er-circuit-down", state: r.providerState, detail: `The connectivity provider${provider} has the circuit as ${r.providerState}, not Provisioned: no traffic flows over it. Ask the provider to finish provisioning, giving them the circuit's service key` });
    }
    if (r.circuitState && !/^enabled$/i.test(r.circuitState)) {
      out.push({ ...base(r, "er-circuit"), kind: "conn-er-circuit-down", state: r.circuitState, detail: `The circuit is ${r.circuitState} on the Microsoft side, not Enabled: no traffic flows over it. Open a support case with Microsoft if it does not come back` });
    }
    let peerings = r.peerings;
    if (typeof peerings === "string") {
      try {
        peerings = JSON.parse(peerings);
      } catch {
        peerings = [];
      }
    }
    for (const p of Array.isArray(peerings) ? peerings : []) {
      const pp = p.properties || p;
      if (!/^azureprivatepeering$/i.test(pp.peeringType || "")) continue;
      if (/^disabled$/i.test(pp.state || "")) {
        out.push({ ...base(r, "er-private-peering"), kind: "conn-er-peering-disabled", detail: "Azure private peering is disabled: the VNets behind this circuit cannot be reached from on premises. Enable the peering if nobody turned it off on purpose" });
      }
    }
  }
  return out;
}

async function circuits() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.network/expressroutecircuits'
    | project id, name, resourceGroup, subscriptionId, providerState = tostring(properties.serviceProviderProvisioningState),
        circuitState = tostring(properties.circuitProvisioningState), provider = tostring(properties.serviceProviderProperties.serviceProviderName),
        peerings = properties.peerings`);
  return judgeCircuits(rows);
}

/* ---------- Gateways ---------- */

const GATEWAY_TYPES = {
  "microsoft.network/virtualnetworkgateways": "Virtual network gateway",
  "microsoft.network/vpngateways": "Virtual WAN VPN gateway",
  "microsoft.network/expressroutegateways": "Virtual WAN ExpressRoute gateway",
};

// rows: [{ id, name, resourceGroup, subscriptionId, type, gatewayType, provisioningState }]. Pure, for the tests.
function judgeGateways(rows) {
  return rows
    .filter((r) => /^failed$/i.test(r.provisioningState || ""))
    .map((r) => {
      const what = GATEWAY_TYPES[String(r.type).toLowerCase()] || "Gateway";
      const kind = r.gatewayType ? ` (${r.gatewayType})` : "";
      return { ...base(r, "gateway-failed"), kind: "conn-gateway-failed", detail: `${what}${kind} is in a failed provisioning state: its tunnels may be down and changes to it will not apply. Run a reset on the gateway or repeat the last change; open a support case if it stays Failed` };
    });
}

async function gateways() {
  const rows = await q(`Resources
    | where type in~ ('microsoft.network/virtualnetworkgateways', 'microsoft.network/vpngateways', 'microsoft.network/expressroutegateways')
    | where tostring(properties.provisioningState) =~ 'Failed'
    | project id, name, resourceGroup, subscriptionId, type = tolower(type), gatewayType = tostring(properties.gatewayType),
        provisioningState = tostring(properties.provisioningState)`);
  return judgeGateways(rows);
}

/* ---------- Private endpoints ---------- */

// rows: [{ id, name, resourceGroup, subscriptionId, status, target, manual }]. Rejected and Disconnected are in
// Orphaned resources; only the ones still waiting are flagged here. Pure, for the tests.
function judgePendingEndpoints(rows) {
  return rows
    .filter((r) => /^pending$/i.test(r.status || ""))
    .map((r) => ({
      ...base(r, "pe-pending"),
      kind: "conn-pe-pending",
      status: r.status,
      detail: `Waiting for the owner of ${nameOf(r.target) || "its target"} to approve the connection${r.manual ? " (manual approval)" : ""}: no traffic flows until then. Approve it under Networking, Private endpoint connections on the target, or delete the endpoint if it is not needed`,
    }));
}

// endpoint: { id, name, ... }, groups: the privateDnsZoneGroups list (ARM value array). Pure, for the tests.
function judgeDnsZoneGroups(endpoint, groups) {
  const configs = (groups || []).flatMap((g) => ((g.properties || {}).privateDnsZoneConfigs || []));
  if (configs.length) return [];
  return [{
    ...base(endpoint, "pe-no-dns"),
    kind: "conn-pe-no-dns",
    detail: `No private DNS zone group: unless your own DNS servers hold a record for ${nameOf(endpoint.target) || "the target"}, its name still resolves to the public address and traffic does not use the endpoint. Add a DNS zone group with the matching privatelink zone (or turn this check off in Settings if you run your own DNS)`,
  }];
}

async function endpointRows() {
  return q(`Resources
    | where type =~ 'microsoft.network/privateendpoints'
    | extend auto = array_length(properties.privateLinkServiceConnections) > 0
    | extend c = iff(auto, properties.privateLinkServiceConnections[0], properties.manualPrivateLinkServiceConnections[0])
    | project id, name, resourceGroup, subscriptionId, status = tostring(c.properties.privateLinkServiceConnectionState.status),
        target = tostring(c.properties.privateLinkServiceId), manual = not(auto)`);
}

async function privateEndpoints() {
  const rows = await endpointRows();
  const out = judgePendingEndpoints(rows);
  const dnsOn = String(settings.get("CONNECTIVITY_PE_DNS_CHECK") || "on").toLowerCase() !== "off";
  if (!dnsOn) return out;
  // Only approved endpoints carry traffic; DNS matters for those.
  const approved = rows.filter((r) => /^approved$/i.test(r.status || ""));
  const todo = approved.slice(0, MAX_ENDPOINTS);
  const failures = await mapLimit(todo, CONCURRENCY, async (r) => {
    const data = await armGet(`https://management.azure.com${r.id}/privateDnsZoneGroups?api-version=${NETWORK_API}`, TOOL_ID);
    out.push(...judgeDnsZoneGroups(r, data.value || []));
  });
  out.push(...itemErrors(TOOL_ID, "pe-dns", "private endpoints", failures, todo.length));
  if (approved.length > todo.length) out.push(scanError(TOOL_ID, "pe-dns-cap", `${approved.length - todo.length} of ${approved.length} private endpoints not checked for DNS`, `Only the first ${MAX_ENDPOINTS} are checked each run`));
  return out;
}

/* ---------- Backend health (Azure Monitor metrics) ---------- */

// A metrics answer as one entry per time series: { dims: { name: value }, avg } where avg is the mean of the
// averages in the window. Series with no data points are left out. Pure, for the tests.
function seriesAverages(data) {
  const out = [];
  for (const metric of (data && data.value) || []) {
    for (const s of metric.timeseries || []) {
      const points = (s.data || []).map((d) => d.average).filter((v) => typeof v === "number" && Number.isFinite(v));
      if (!points.length) continue;
      const dims = {};
      for (const m of s.metadatavalues || []) dims[String((m.name && m.name.value) || m.name || "").toLowerCase()] = m.value;
      out.push({ dims, avg: points.reduce((a, b) => a + b, 0) / points.length });
    }
  }
  return out;
}

const dimLabel = (s, dim) => (dim && s.dims[dim.toLowerCase()]) || null;
const round = (n) => Math.round(n * 10) / 10;

// Application Gateway: UnhealthyHostCount averaged over the hour, per backend pool. Pure, for the tests.
function judgeAppGateway(r, series) {
  const bad = series.filter((s) => s.avg > 0);
  if (!bad.length) return [];
  const pools = bad.map((s) => dimLabel(s, "BackendSettingsPool")).filter(Boolean).map((p) => String(p).split("~")[0]);
  const hosts = round(bad.reduce((a, s) => a + s.avg, 0));
  return [{
    ...base(r, "agw-unhealthy"),
    kind: "conn-agw-unhealthy",
    detail: `On average ${hosts} backend host(s) failed the health probe over the last hour${pools.length ? ` (pool ${list([...new Set(pools)])})` : ""}. Open Backend health on the gateway to see which servers and why, then fix the servers or the probe`,
  }];
}

// Health percentages (load balancer probes, Front Door origins): series under the threshold. Pure, for the tests.
function judgeHealthPercent(r, series, { kind, dim, what, fix, threshold = 100 }) {
  const bad = series.filter((s) => s.avg < threshold);
  if (!bad.length) return [];
  const names = bad.map((s) => {
    const n = dimLabel(s, dim);
    return n ? `${n} ${round(s.avg)}%` : `${round(s.avg)}%`;
  });
  return [{ ...base(r, kind.replace(/^conn-/, "")), kind, detail: `${what} below ${threshold}% over the last hour: ${list(names)}. ${fix}` }];
}

const HEALTH = {
  lb: {
    kind: "conn-lb-unhealthy",
    metric: "DipAvailability",
    dim: "BackendIPAddress",
    what: "Health probe status",
    fix: "Check that the backends are running and answer the probe's port and path, and that an NSG allows the AzureLoadBalancer service tag",
  },
  afd: {
    kind: "conn-fd-unhealthy",
    metric: "OriginHealthPercentage",
    dim: "Origin",
    what: "Origin health",
    fix: "Check that the origins are up and answer the health probe path, and that their firewalls let Front Door in",
  },
  fdClassic: {
    kind: "conn-fd-unhealthy",
    metric: "BackendHealthPercentage",
    dim: "Backend",
    what: "Backend health",
    fix: "Check that the backends are up and answer the health probe path, and that their firewalls let Front Door in",
  },
};

// The last hour of one metric, split by a dimension when it has one. A dimension filter the resource does not
// support is answered with 400; the metric is then read whole.
async function metricSeries(id, metric, dim) {
  const end = new Date();
  const start = new Date(end.getTime() - 3600000);
  const url = `https://management.azure.com${id}/providers/Microsoft.Insights/metrics?api-version=${METRICS_API}` +
    `&metricnames=${metric}&aggregation=Average&interval=PT5M&timespan=${start.toISOString()}/${end.toISOString()}`;
  if (dim) {
    try {
      return seriesAverages(await armGet(`${url}&$filter=${encodeURIComponent(`${dim} eq '*'`)}`, TOOL_ID));
    } catch (err) {
      if (!/\(400\)/.test(String(err.message))) throw err;
    }
  }
  return seriesAverages(await armGet(url, TOOL_ID));
}

async function metricCheck(key, what, rows, judge) {
  const todo = rows.slice(0, MAX_METRIC_RESOURCES);
  const out = [];
  const failures = await mapLimit(todo, CONCURRENCY, async (r) => out.push(...(await judge(r))));
  out.push(...itemErrors(TOOL_ID, key, what, failures, todo.length));
  if (rows.length > todo.length) out.push(scanError(TOOL_ID, `${key}-cap`, `${rows.length - todo.length} of ${rows.length} ${what} not checked`, `Only the first ${MAX_METRIC_RESOURCES} are checked each run`));
  return out;
}

async function appGateways() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.network/applicationgateways' and tostring(properties.operationalState) =~ 'Running'
    | project id, name, resourceGroup, subscriptionId`);
  return metricCheck("agw", "application gateways", rows, async (r) => judgeAppGateway(r, await metricSeries(r.id, "UnhealthyHostCount", "BackendSettingsPool")));
}

async function loadBalancers(threshold) {
  const rows = await q(`Resources
    | where type =~ 'microsoft.network/loadbalancers' and tostring(sku.name) =~ 'Standard'
    | where array_length(properties.loadBalancingRules) > 0 and array_length(properties.probes) > 0
    | project id, name, resourceGroup, subscriptionId`);
  const h = HEALTH.lb;
  return metricCheck("lb", "load balancers", rows, async (r) => judgeHealthPercent(r, await metricSeries(r.id, h.metric, h.dim), { ...h, threshold }));
}

async function frontDoors(threshold) {
  const rows = await q(`Resources
    | where (type =~ 'microsoft.cdn/profiles' and tostring(sku.name) in~ ('Standard_AzureFrontDoor', 'Premium_AzureFrontDoor'))
        or (type =~ 'microsoft.network/frontdoors' and tostring(properties.enabledState) !~ 'Disabled')
    | project id, name, resourceGroup, subscriptionId, type = tolower(type)`);
  return metricCheck("fd", "Front Door profiles", rows, async (r) => {
    const h = r.type === "microsoft.network/frontdoors" ? HEALTH.fdClassic : HEALTH.afd;
    return judgeHealthPercent(r, await metricSeries(r.id, h.metric, h.dim), { ...h, threshold });
  });
}

async function run() {
  const threshold = numberSetting("CONNECTIVITY_HEALTH_PERCENT", 100, { min: 1, max: 100 });
  return runChecks(TOOL_ID, {
    "VPN connections": connections,
    "ExpressRoute circuits": circuits,
    "Gateways": gateways,
    "Private endpoints": privateEndpoints,
    "Application gateways": appGateways,
    "Load balancers": () => loadBalancers(threshold),
    "Front Door": () => frontDoors(threshold),
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Connectivity health",
  schedule: "35 * * * *", // every hour at :35
  run,
  _test: { judgeConnections, judgeCircuits, judgeGateways, judgePendingEndpoints, judgeDnsZoneGroups, seriesAverages, judgeAppGateway, judgeHealthPercent, HEALTH },
};
