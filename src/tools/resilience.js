// What a zone, region or service outage would take down: single VMs, AKS
// clusters, App Service plans, gateways and databases with one instance or
// one zone, storage kept in one datacenter, and subscriptions with no
// Service Health alert. Each finding follows a PSRule for Azure rule
// (Reliability pillar). Reader is enough.
const { resourceGraphQuery } = require("../armClient");
const { runChecks } = require("./util");
const { hasZones, ruleFinding, rules, zoneList } = require("./psrule");

const TOOL_ID = "resilience";

const R = rules({
  vmStandalone: "Azure.VM.Standalone|Important|Reliability",
  aksZones: "Azure.AKS.AvailabilityZone|Important|Reliability",
  aksNodes: "Azure.AKS.MinNodeCount|Important|Reliability",
  aksSla: "Azure.AKS.UptimeSLA|Important|Reliability",
  planInstances: "Azure.AppService.PlanInstanceCount|Important|Reliability",
  planZones: "Azure.AppService.AvailabilityZone|Important|Reliability",
  storageLrs: "Azure.Storage.UseReplication|Important|Reliability",
  pipZones: "Azure.PublicIP.AvailabilityZone|Important|Reliability",
  lbZones: "Azure.LB.AvailabilityZone|Important|Reliability",
  agwZones: "Azure.AppGw.AvailabilityZone|Important|Reliability",
  agwInstances: "Azure.AppGw.MinInstance|Important|Reliability",
  vpnLegacy: "Azure.VNG.VPNLegacySKU|Critical|Reliability",
  vpnZones: "Azure.VNG.VPNAvailabilityZoneSKU|Important|Reliability",
  vpnActive: "Azure.VNG.VPNActiveActive|Important|Reliability",
  erLegacy: "Azure.VNG.ERLegacySKU|Critical|Reliability",
  erZones: "Azure.VNG.ERAvailabilityZoneSKU|Important|Reliability",
  serviceHealth: "Azure.Monitor.ServiceHealth|Important|Reliability",
  pgGeo: "Azure.PostgreSQL.GeoRedundantBackup|Important|Reliability",
  pgHa: "Azure.PostgreSQL.ZoneRedundantHA|Important|Reliability",
  mysqlGeo: "Azure.MySQL.GeoRedundantBackup|Important|Reliability",
  mysqlHa: "Azure.MySQL.ZoneRedundantHA|Important|Reliability",
});

const MIN_SYSTEM_NODES = 3; // PSRule's default for Azure.AKS.MinNodeCount
const PREMIUM_DISKS = new Set(["premium_lrs", "premium_zrs", "premiumv2_lrs", "ultrassd_lrs"]);

const q = (kql) => resourceGraphQuery(kql, { toolId: TOOL_ID });

async function vms() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.compute/virtualmachines'
    | where isempty(properties.availabilitySet.id) and isempty(properties.virtualMachineScaleSet.id) and coalesce(array_length(zones), 0) == 0
    | project id, name, resourceGroup, subscriptionId, osDisk = tostring(properties.storageProfile.osDisk.managedDisk.storageAccountType),
        dataDisks = properties.storageProfile.dataDisks`);
  return rows
    .filter((r) => {
      const types = [r.osDisk, ...(r.dataDisks || []).map((d) => d && d.managedDisk && d.managedDisk.storageAccountType)];
      return !types.every((t) => PREMIUM_DISKS.has(String(t || "").toLowerCase()));
    })
    .map((r) => ruleFinding(r, "rel-vm-standalone", "Virtual machines", R.vmStandalone, `A single VM with no zone or availability set, and not every disk is Premium SSD (${r.osDisk || "unmanaged OS disk"}). A host or zone failure stops it. Put it in a zone or availability set, or use Premium SSD disks for the single-VM SLA`));
}

async function aks() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.containerservice/managedclusters'
    | project id, name, resourceGroup, subscriptionId, location, tier = tostring(sku.tier), pools = properties.agentPoolProfiles`);
  const out = [];
  for (const r of rows) {
    const pools = r.pools || [];
    if (hasZones(r.location)) {
      const noZone = pools.filter((p) => zoneList(p.availabilityZones).length < 2).map((p) => p.name);
      if (noZone.length) out.push(ruleFinding(r, "rel-aks-zones", "AKS", R.aksZones, `Node pools not spread over zones: ${noZone.join(", ")}. Zones are set when a pool is created, so add a new zonal pool and move the work over`));
    }
    const system = pools.filter((p) => String(p.mode).toLowerCase() === "system");
    const nodes = system.reduce((n, p) => n + (p.enableAutoScaling ? Number(p.minCount) || 0 : Number(p.count) || 0), 0);
    if (system.length && nodes < MIN_SYSTEM_NODES) out.push(ruleFinding(r, "rel-aks-min-nodes", "AKS", R.aksNodes, `System node pools have ${nodes} node${nodes === 1 ? "" : "s"}${system.some((p) => p.enableAutoScaling) ? " at their minimum" : ""}; use at least ${MIN_SYSTEM_NODES} so an upgrade or a node failure does not stop the cluster's own services`));
    if (!r.tier || /^free$/i.test(r.tier)) out.push(ruleFinding(r, "rel-aks-free-tier", "AKS", R.aksSla, "Free tier: the API server has no uptime SLA. Use the Standard tier for production clusters"));
  }
  return out;
}

// Consumption and elastic plans scale by themselves; Free and Shared cannot scale out.
const PLAN_SKIP = /^(free|shared|dynamic|elasticpremium|flexconsumption|workflowstandard)$/i;
const PLAN_ZONE_TIERS = /^(premiumv2|premiumv3|premium0v3|premiummv3|premiumv4|isolatedv2)$/i;

async function appServicePlans() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.web/serverfarms'
    | where toint(properties.numberOfSites) > 0
    | project id, name, resourceGroup, subscriptionId, location, tier = tostring(sku.tier), sku = tostring(sku.name),
        capacity = toint(sku.capacity), zoneRedundant = tobool(properties.zoneRedundant)`);
  const out = [];
  for (const r of rows) {
    if (PLAN_SKIP.test(r.tier)) continue;
    if ((r.capacity || 1) < 2) out.push(ruleFinding(r, "rel-plan-one-instance", "App Service", R.planInstances, `Runs on ${r.capacity || 1} instance (${r.sku}). While Azure replaces a faulty instance, every app on the plan is down. Scale out to 2 or more`));
    if (hasZones(r.location) && PLAN_ZONE_TIERS.test(r.tier) && !r.zoneRedundant) out.push(ruleFinding(r, "rel-plan-no-zones", "App Service", R.planZones, `Not zone redundant (${r.sku}): all instances can sit in one zone. Turn on zone redundancy (3 instances or more)`));
  }
  return out;
}

async function storage() {
  const rows = await q(`Resources
    | where type =~ 'microsoft.storage/storageaccounts'
    | where tostring(sku.name) endswith '_LRS'
    | where tostring(tags['ms-resource-usage']) != 'azure-cloud-shell'
    | project id, name, resourceGroup, subscriptionId, sku = tostring(sku.name)`);
  return rows.map((r) => ruleFinding(r, "rel-storage-lrs", "Storage", R.storageLrs, `${r.sku}: every copy is in one datacenter. Use ZRS, GRS or GZRS for accounts that hold data`));
}

async function network() {
  const rows = await q(`Resources
    | where type in~ ('microsoft.network/publicipaddresses', 'microsoft.network/loadbalancers', 'microsoft.network/applicationgateways', 'microsoft.network/virtualnetworkgateways')
    | project id, name, resourceGroup, subscriptionId, location, type = tolower(type), skuName = tostring(sku.name), zones,
        frontends = properties.frontendIPConfigurations, agwTier = tostring(properties.sku.tier), agwCapacity = toint(properties.sku.capacity),
        agwMin = toint(properties.autoscaleConfiguration.minCapacity), gwType = tostring(properties.gatewayType),
        gwSku = tostring(properties.sku.name), activeActive = tobool(properties.activeActive)`);
  const out = [];
  for (const r of rows) {
    const zoned = hasZones(r.location);
    if (r.type === "microsoft.network/publicipaddresses") {
      const z = zoneList(r.zones);
      if (zoned && /^standard$/i.test(r.skuName) && z.length === 1) out.push(ruleFinding(r, "rel-pip-one-zone", "Networking", R.pipZones, `Pinned to zone ${z[0]}: the address is lost if that zone fails. A public IP cannot change zones; a new zone-redundant one is needed`));
    } else if (r.type === "microsoft.network/loadbalancers") {
      if (!zoned || !/^standard$/i.test(r.skuName)) continue;
      const weak = (r.frontends || []).filter((f) => f.properties && f.properties.subnet && zoneList(f.zones).length < 2).map((f) => f.name);
      if (weak.length) out.push(ruleFinding(r, "rel-lb-zones", "Networking", R.lbZones, `Internal frontends not zone redundant: ${weak.join(", ")}. Recreate them with zones 1, 2 and 3`));
    } else if (r.type === "microsoft.network/applicationgateways") {
      if (!/_v2$/i.test(r.agwTier)) continue;
      if (zoned && zoneList(r.zones).length < 2) out.push(ruleFinding(r, "rel-agw-zones", "Networking", R.agwZones, "Not spread over zones. Zones are set when the gateway is created, so it needs a new zone-redundant gateway"));
      const min = r.agwMin != null ? r.agwMin : r.agwCapacity;
      if (min != null && min < 2) out.push(ruleFinding(r, "rel-agw-one-instance", "Networking", R.agwInstances, `${r.agwMin != null ? "Autoscale minimum" : "Instance count"} is ${min}. Use at least 2 so traffic keeps flowing while an instance is replaced`));
    } else if (r.type === "microsoft.network/virtualnetworkgateways") {
      const sku = r.gwSku || "";
      if (/^vpn$/i.test(r.gwType)) {
        const legacy = /^(basic|standard|highperformance)$/i.test(sku);
        if (legacy) out.push(ruleFinding(r, "rel-vpn-legacy-sku", "Networking", R.vpnLegacy, `${sku} is a legacy VPN gateway SKU that Azure is retiring. Migrate to a VpnGw AZ SKU`));
        else if (zoned && !/az$/i.test(sku)) out.push(ruleFinding(r, "rel-vpn-no-zones", "Networking", R.vpnZones, `${sku} runs in one zone. Use the zone-redundant ${sku}AZ SKU`));
        if (!/^basic$/i.test(sku) && !r.activeActive) out.push(ruleFinding(r, "rel-vpn-not-active-active", "Networking", R.vpnActive, "Not active-active: tunnels drop while Azure fails over to the standby instance during maintenance or a fault"));
      } else if (/^expressroute$/i.test(r.gwType)) {
        const legacy = /^(standard|highperformance|ultraperformance)$/i.test(sku);
        if (legacy) out.push(ruleFinding(r, "rel-er-legacy-sku", "Networking", R.erLegacy, `${sku} is a legacy ExpressRoute gateway SKU. Migrate to an ErGw AZ SKU`));
        else if (zoned && !/az$/i.test(sku)) out.push(ruleFinding(r, "rel-er-no-zones", "Networking", R.erZones, `${sku} runs in one zone. Use a zone-redundant ErGw AZ SKU`));
      }
    }
  }
  return out;
}

// Subscriptions where no enabled activity log alert with an action group
// watches Service Health (outages, planned maintenance, health advisories).
async function serviceHealth() {
  const [subs, alerts] = await Promise.all([
    q(`ResourceContainers | where type =~ 'microsoft.resources/subscriptions' | project subscriptionId, name`),
    q(`Resources
      | where type =~ 'microsoft.insights/activitylogalerts'
      | where tobool(properties.enabled) != false and coalesce(array_length(properties.actions.actionGroups), 0) > 0
      | where tostring(properties.condition) contains 'ServiceHealth'
      | project subscriptionId, scopes = properties.scopes`),
  ]);
  const covered = new Set();
  for (const a of alerts) {
    const scopes = Array.isArray(a.scopes) && a.scopes.length ? a.scopes : [`/subscriptions/${a.subscriptionId}`];
    for (const s of scopes) {
      const m = String(s).match(/^\/subscriptions\/([^/]+)/i);
      if (m) covered.add(m[1].toLowerCase());
    }
  }
  return subs
    .filter((s) => !covered.has(String(s.subscriptionId).toLowerCase()))
    .map((s) => ruleFinding({ id: `/subscriptions/${s.subscriptionId}`, name: s.name, subscriptionId: s.subscriptionId }, "rel-no-service-health", "Monitoring", R.serviceHealth, "No Service Health alert: nobody is told about Azure outages, planned maintenance or advisories that hit this subscription. Add an activity log alert on Service Health with an action group"));
}

const DB = {
  "microsoft.dbforpostgresql/flexibleservers": { label: "PostgreSQL", geo: R.pgGeo, ha: R.pgHa, kind: "pg" },
  "microsoft.dbformysql/flexibleservers": { label: "MySQL", geo: R.mysqlGeo, ha: R.mysqlHa, kind: "mysql" },
};

async function databases() {
  const rows = await q(`Resources
    | where type in~ ('microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbformysql/flexibleservers')
    | where tostring(properties.replicationRole) !in~ ('Replica', 'AsyncReplica', 'GeoAsyncReplica')
    | project id, name, resourceGroup, subscriptionId, location, type = tolower(type), tier = tostring(sku.tier),
        geo = tostring(properties.backup.geoRedundantBackup), ha = tostring(properties.highAvailability.mode)`);
  const out = [];
  for (const r of rows) {
    const t = DB[r.type];
    if (!/^enabled$/i.test(r.geo)) out.push(ruleFinding(r, `rel-${t.kind}-no-geo-backup`, "Databases", t.geo, `${t.label} backups stay in this region; a regional outage takes them too. Geo-redundant backup can only be turned on when a server is created or restored`));
    if (hasZones(r.location) && !/^burstable$/i.test(r.tier) && !/^zoneredundant$/i.test(r.ha)) out.push(ruleFinding(r, `rel-${t.kind}-no-zone-ha`, "Databases", t.ha, /^samezone$/i.test(r.ha) ? `${t.label} high availability keeps the standby in the same zone. Use zone-redundant high availability` : `${t.label} has no zone-redundant high availability: a zone failure stops the server`));
  }
  return out;
}

function run() {
  return runChecks(TOOL_ID, {
    "Virtual machines": vms,
    "AKS clusters": aks,
    "App Service plans": appServicePlans,
    "Storage accounts": storage,
    "Networking": network,
    "Service Health alerts": serviceHealth,
    "Databases": databases,
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Resilience",
  schedule: "15 3 * * *", // daily at 03:15
  run,
  _test: { R },
};
