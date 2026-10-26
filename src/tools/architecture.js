// Architecture: a drawing of the environment. Each run reads every resource
// with the subnet it sits in (through its NIC, its IP configuration or its
// VNet integration), the VNets with their subnets and peerings, on-premises
// sites with their VPN and ExpressRoute connections, and which resources have
// a public IP, and saves that as architecture/inventory.json in the tenant's
// history storage. The page draws it with the layers the viewer picks
// (subscriptions, resource groups, VNets, subnets, kinds of resource). For
// information only: no findings. Reader is enough.
const store = require("../findingsStore");
const tenants = require("../tenants");
const { resourceGraphQuery } = require("../armClient");

const TOOL_ID = "architecture";
const INVENTORY_KEY = "architecture/inventory.json";
const MAX_RESOURCES = 20000;

// The subnet a resource sits in, by type, and what it points at (a NIC's VM,
// a private endpoint's target, a public IP's IP configuration, a disk's VM).
const RESOURCES_KQL = `Resources
| extend t = tolower(type)
| extend subnet = tolower(case(
    t == 'microsoft.network/networkinterfaces', tostring(properties.ipConfigurations[0].properties.subnet.id),
    t == 'microsoft.network/privateendpoints', tostring(properties.subnet.id),
    t == 'microsoft.network/applicationgateways', tostring(properties.gatewayIPConfigurations[0].properties.subnet.id),
    t in ('microsoft.network/azurefirewalls', 'microsoft.network/bastionhosts', 'microsoft.network/virtualnetworkgateways'), tostring(properties.ipConfigurations[0].properties.subnet.id),
    t == 'microsoft.network/loadbalancers', tostring(properties.frontendIPConfigurations[0].properties.subnet.id),
    t == 'microsoft.containerservice/managedclusters', tostring(properties.agentPoolProfiles[0].vnetSubnetID),
    t == 'microsoft.web/sites', tostring(properties.virtualNetworkSubnetId),
    t == 'microsoft.compute/virtualmachinescalesets', tostring(properties.virtualMachineProfile.networkProfile.networkInterfaceConfigurations[0].properties.ipConfigurations[0].properties.subnet.id),
    t == 'microsoft.containerinstance/containergroups', tostring(properties.subnetIds[0].id),
    t == 'microsoft.sql/managedinstances', tostring(properties.subnetId),
    t == 'microsoft.apimanagement/service', tostring(properties.virtualNetworkConfiguration.subnetResourceId),
    t == 'microsoft.app/managedenvironments', tostring(properties.vnetConfiguration.infrastructureSubnetId),
    t in ('microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbformysql/flexibleservers'), tostring(properties.network.delegatedSubnetResourceId),
    ''))
| extend link = tolower(case(
    t == 'microsoft.network/networkinterfaces', tostring(properties.virtualMachine.id),
    t == 'microsoft.network/privateendpoints', coalesce(tostring(properties.privateLinkServiceConnections[0].properties.privateLinkServiceId), tostring(properties.manualPrivateLinkServiceConnections[0].properties.privateLinkServiceId)),
    t == 'microsoft.network/publicipaddresses', tostring(properties.ipConfiguration.id),
    t == 'microsoft.compute/disks', tostring(managedBy),
    ''))
| extend ip = iff(t == 'microsoft.network/publicipaddresses', tostring(properties.ipAddress), '')
| project id, name, type = t, kind = tostring(kind), location, resourceGroup, subscriptionId, sku = tostring(sku.name), subnet, link, ip
| take ${MAX_RESOURCES + 1}`;

const parentOf = (id) => String(id || "").toLowerCase().split("/").slice(0, 9).join("/");
const vnetOfSubnet = (id) => String(id || "").toLowerCase().split("/subnets/")[0];
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);

async function read() {
  const q = (kql, opts = {}) => resourceGraphQuery(kql, { toolId: TOOL_ID, ...opts });
  const [resources, vnets, groups, subs, sites, connections] = await Promise.all([
    q(RESOURCES_KQL),
    q(`Resources | where type =~ 'microsoft.network/virtualnetworks'
      | project id = tolower(id), name, resourceGroup, subscriptionId, location, prefixes = properties.addressSpace.addressPrefixes,
          subnets = properties.subnets, peerings = properties.virtualNetworkPeerings`),
    q(`ResourceContainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' | project name, subscriptionId, location`),
    q(`ResourceContainers | where type =~ 'microsoft.resources/subscriptions' | project subscriptionId, name`),
    q(`Resources | where type in~ ('microsoft.network/localnetworkgateways', 'microsoft.network/expressroutecircuits')
      | project id = tolower(id), name, type = tolower(type), resourceGroup, subscriptionId, location,
          prefixes = properties.localNetworkAddressSpace.addressPrefixes, address = tostring(properties.gatewayIpAddress),
          provider = tostring(properties.serviceProviderProperties.serviceProviderName), peering = tostring(properties.serviceProviderProperties.peeringLocation)`),
    q(`Resources | where type =~ 'microsoft.network/connections'
      | project id = tolower(id), name, kind = tostring(properties.connectionType),
          gateway = tolower(tostring(properties.virtualNetworkGateway1.id)),
          site = tolower(coalesce(tostring(properties.localNetworkGateway2.id), tostring(properties.peer.id), tostring(properties.virtualNetworkGateway2.id)))`),
  ]);
  return { resources, vnets, groups, subs, sites, connections };
}

// Resources a drawing shows on their own, with their subnet and public IPs
// worked out. NICs and public IPs stay in the list (the page can show them)
// but also hand their subnet and address to what they belong to.
function build(d) {
  const res = d.resources.slice(0, MAX_RESOURCES).map((r) => ({
    id: String(r.id).toLowerCase(),
    name: r.name,
    type: r.type,
    ...(r.kind && { kind: r.kind }),
    ...(r.sku && { sku: r.sku }),
    location: r.location,
    resourceGroup: String(r.resourceGroup || "").toLowerCase(),
    subscriptionId: r.subscriptionId,
    ...(r.subnet && { subnet: r.subnet }),
    ...(r.link && { link: r.link }),
    ...(r.ip && { ip: r.ip }),
  }));
  const byId = new Map(res.map((r) => [r.id, r]));
  // A VM sits where its first NIC sits.
  for (const nic of res.filter((r) => r.type === "microsoft.network/networkinterfaces" && r.link && r.subnet)) {
    const vm = byId.get(nic.link);
    if (vm && !vm.subnet) vm.subnet = nic.subnet;
  }
  // A public IP marks what holds it (through a NIC, the VM).
  for (const pip of res.filter((r) => r.type === "microsoft.network/publicipaddresses" && r.link)) {
    let owner = byId.get(parentOf(pip.link));
    if (owner && owner.type === "microsoft.network/networkinterfaces" && owner.link) owner = byId.get(owner.link) || owner;
    if (owner) (owner.publicIps = owner.publicIps || []).push(pip.ip || pip.name);
  }
  const vnets = d.vnets.map((v) => ({
    id: v.id,
    name: v.name,
    resourceGroup: String(v.resourceGroup || "").toLowerCase(),
    subscriptionId: v.subscriptionId,
    location: v.location,
    prefixes: list(v.prefixes).map(String),
    subnets: list(v.subnets).map((s) => {
      const p = s.properties || {};
      return {
        id: String(s.id || "").toLowerCase(),
        name: s.name,
        prefixes: list(p.addressPrefixes).length ? list(p.addressPrefixes).map(String) : list(p.addressPrefix).map(String),
        ...(p.networkSecurityGroup && { nsg: p.networkSecurityGroup.id.split("/").pop() }),
        ...(p.routeTable && { routeTable: p.routeTable.id.split("/").pop() }),
        ...(p.natGateway && { natGateway: p.natGateway.id.split("/").pop() }),
        ...(list(p.delegations).length && { delegation: (list(p.delegations)[0].properties || {}).serviceName }),
      };
    }),
    peerings: list(v.peerings)
      .map((p) => ({ remote: String(((p.properties || {}).remoteVirtualNetwork || {}).id || "").toLowerCase(), state: (p.properties || {}).peeringState || "" }))
      .filter((p) => p.remote),
  }));
  // A resource whose subnet is not in a VNet we read (another tenant, no access) keeps the id but draws in its group.
  const known = new Set(vnets.flatMap((v) => v.subnets.map((s) => s.id)));
  for (const r of res) if (r.subnet && !known.has(r.subnet) && !vnets.some((v) => v.id === vnetOfSubnet(r.subnet))) r.subnetOutside = true;
  return {
    resources: res,
    truncated: d.resources.length > MAX_RESOURCES,
    vnets,
    groups: d.groups.map((g) => ({ name: String(g.name).toLowerCase(), displayName: g.name, subscriptionId: g.subscriptionId, location: g.location })),
    subscriptions: d.subs.map((s) => ({ id: s.subscriptionId, name: s.name })),
    sites: d.sites.map((s) => ({
      id: s.id, name: s.name, type: s.type, resourceGroup: String(s.resourceGroup || "").toLowerCase(), subscriptionId: s.subscriptionId, location: s.location,
      prefixes: list(s.prefixes).map(String), ...(s.address && { address: s.address }), ...(s.provider && { provider: s.provider }), ...(s.peering && { peering: s.peering }),
    })),
    connections: d.connections.filter((c) => c.gateway && c.site).map((c) => ({ id: c.id, name: c.name, kind: c.kind, gateway: c.gateway, site: c.site })),
  };
}

async function run() {
  const doc = build(await read());
  await store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), ...doc });
  return [];
}

async function inventory(keys) {
  const out = { updatedAt: null, tenants: [], resources: [], vnets: [], groups: [], subscriptions: [], sites: [], connections: [], truncated: false, failures: [] };
  for (const k of keys) {
    let doc;
    try {
      doc = await store.getDoc(INVENTORY_KEY, k);
    } catch (err) {
      out.failures.push({ tenant: k, error: `could not read the saved drawing: ${err.message}` });
      continue;
    }
    if (!doc) continue;
    if (doc.updatedAt && (!out.updatedAt || doc.updatedAt > out.updatedAt)) out.updatedAt = doc.updatedAt;
    out.tenants.push({ key: k, name: tenants.nameOf(k) });
    out.truncated = out.truncated || !!doc.truncated;
    const tag = (x) => ({ ...x, tenant: k });
    for (const part of ["resources", "vnets", "groups", "subscriptions", "sites", "connections"]) out[part].push(...(doc[part] || []).map(tag));
  }
  return out;
}

function registerRoutes(app, { readKeys }) {
  app.get("/api/architecture", async (req, res) => {
    try {
      res.json(await inventory(readKeys(req)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Architecture",
  schedule: "40 4 * * *", // daily at 04:40
  info: true,
  run,
  registerRoutes,
  _test: { build, parentOf },
};
