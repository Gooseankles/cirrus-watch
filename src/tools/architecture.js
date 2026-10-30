// Architecture: a drawing of the environment. Each run reads every resource
// with the subnet it sits in (through its NIC, its IP configuration or its
// VNet integration), the VNets with their subnets and peerings, on-premises
// sites with their VPN and ExpressRoute connections, which resources have
// a public IP, what each managed identity may reach (its Azure roles on a
// resource or resource group, Key Vault access policies) and which Entra app
// registrations sign people in to a web app (a redirect URI on its host
// name), and saves that as architecture/inventory.json in the tenant's
// history storage. The page draws it with the layers the viewer picks
// (subscriptions, resource groups, VNets, subnets, kinds of resource). For
// information only: no findings. Reader is enough; Application.Read.All on
// Microsoft Graph adds the sign-in tiles.
const store = require("../findingsStore");
const flows = require("./trafficFlow");
const tenants = require("../tenants");
const { resourceGraphQuery } = require("../armClient");
const { graphGetAll } = require("../graphClient");

const TOOL_ID = "architecture";
const INVENTORY_KEY = "architecture/inventory.json";
const NETWORK_KEY = "architecture/network.json"; // NSGs, routes and addresses for the traffic lines
const FIREWALL_KEY = "firewall/inventory.json"; // saved by the Firewall policies scan
const MAX_IDS = 2000;
const MAX_PAIRS = 6000; // the whole drawing at once: about 75 VMs
const MAX_RESOURCES = 20000;
const MAX_ACCESS = 20000; // identity access lines kept per tenant

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
| extend rs = t == 'microsoft.network/virtualhubs' and isempty(tostring(properties.virtualWan.id))
| extend principal = tolower(coalesce(tostring(identity.principalId), iff(t == 'microsoft.managedidentity/userassignedidentities', tostring(properties.principalId), '')))
| extend uamis = iff(isnull(identity.userAssignedIdentities), dynamic(null), bag_keys(identity.userAssignedIdentities))
| extend hosts = iff(t == 'microsoft.web/sites', properties.hostNames, dynamic(null))
| project id, name, resType = t, resKind = tostring(kind), location, resourceGroup, subscriptionId, sku = tostring(sku.name), subnet, link, ip, rs, principal, uamis, hosts`;

const parentOf = (id) => String(id || "").toLowerCase().split("/").slice(0, 9).join("/");
const vnetOfSubnet = (id) => String(id || "").toLowerCase().split("/subnets/")[0];
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const lc = (s) => String(s || "").toLowerCase();

async function read() {
  const q = (kql, opts = {}) => resourceGraphQuery(kql, { toolId: TOOL_ID, ...opts });
  // The traffic lines need these; a drawing still comes without them.
  const soft = (kql) => q(kql).catch(() => null);
  const [resources, vnets, groups, subs, sites, connections, nsgs, routeTables, nics, firewalls, roles, roleDefs, vaultPolicies, apps] = await Promise.all([
    q(RESOURCES_KQL),
    q(`Resources | where type =~ 'microsoft.network/virtualnetworks'
      | project id = tolower(id), name, resourceGroup, subscriptionId, location, prefixes = properties.addressSpace.addressPrefixes,
          subnets = properties.subnets, peerings = properties.virtualNetworkPeerings`),
    q(`ResourceContainers | where type =~ 'microsoft.resources/subscriptions/resourcegroups' | project name, subscriptionId, location`),
    q(`ResourceContainers | where type =~ 'microsoft.resources/subscriptions' | project subscriptionId, name`),
    q(`Resources | where type in~ ('microsoft.network/localnetworkgateways', 'microsoft.network/expressroutecircuits')
      | project id = tolower(id), name, siteType = tolower(type), resourceGroup, subscriptionId, location,
          prefixes = properties.localNetworkAddressSpace.addressPrefixes, siteAddress = tostring(properties.gatewayIpAddress),
          siteProvider = tostring(properties.serviceProviderProperties.serviceProviderName), sitePeering = tostring(properties.serviceProviderProperties.peeringLocation)`),
    q(`Resources | where type =~ 'microsoft.network/connections'
      | project id = tolower(id), name, connKind = tostring(properties.connectionType),
          gateway = tolower(tostring(properties.virtualNetworkGateway1.id)),
          site = tolower(coalesce(tostring(properties.localNetworkGateway2.id), tostring(properties.peer.id), tostring(properties.virtualNetworkGateway2.id)))`),
    soft(`Resources | where type =~ 'microsoft.network/networksecuritygroups' | project id = tolower(id), name, rules = properties.securityRules, defaults = properties.defaultSecurityRules`),
    soft(`Resources | where type =~ 'microsoft.network/routetables' | project id = tolower(id), name, routes = properties.routes`),
    soft(`Resources | where type =~ 'microsoft.network/networkinterfaces'
      | project id = tolower(id), vm = tolower(tostring(properties.virtualMachine.id)), pe = tolower(tostring(properties.privateEndpoint.id)),
          nsg = tolower(tostring(properties.networkSecurityGroup.id)), primary = tobool(properties.primary), fwd = tobool(properties.enableIPForwarding),
          nicIp = tostring(properties.ipConfigurations[0].properties.privateIPAddress), nicSubnet = tolower(tostring(properties.ipConfigurations[0].properties.subnet.id)),
          asgs = properties.ipConfigurations[0].properties.applicationSecurityGroups`),
    soft(`Resources | where type =~ 'microsoft.network/azurefirewalls'
      | project id = tolower(id), name, policy = tolower(tostring(properties.firewallPolicy.id)),
          fwIp = tostring(coalesce(properties.ipConfigurations[0].properties.privateIPAddress, properties.hubIPAddresses.privateIPAddress)),
          fwSubnet = tolower(tostring(properties.ipConfigurations[0].properties.subnet.id))`),
    // Identity lines: roles given to service principals (managed identities are among them) and vault access policies.
    soft(`AuthorizationResources | where type =~ 'microsoft.authorization/roleassignments' and tostring(properties.principalType) =~ 'ServicePrincipal'
      | project principalId = tolower(tostring(properties.principalId)), roleDefinitionId = tolower(tostring(properties.roleDefinitionId)), scope = tolower(tostring(properties.scope))`),
    q(`AuthorizationResources | where type =~ 'microsoft.authorization/roledefinitions' | project id = tolower(id), roleName = tostring(properties.roleName)`, { subscriptions: [] }).catch(() => null),
    soft(`Resources | where type =~ 'microsoft.keyvault/vaults' and tobool(properties.enableRbacAuthorization) != true
      | project id = tolower(id), policies = properties.accessPolicies`),
    // Sign-in: app registrations with a redirect URI on a web app's host name. Needs Application.Read.All.
    graphGetAll("/applications?$select=appId,displayName,web,spa,publicClient&$top=999", TOOL_ID).catch(() => null),
  ]);
  return { resources, vnets, groups, subs, sites, connections, nsgs, routeTables, nics, firewalls, roles, roleDefs, vaultPolicies, apps };
}

// Resources a drawing shows on their own, with their subnet and public IPs
// worked out. NICs and public IPs stay in the list (the page can show them)
// but also hand their subnet and address to what they belong to.
function build(d) {
  const res = d.resources.slice(0, MAX_RESOURCES).map((r) => ({
    id: String(r.id).toLowerCase(),
    name: r.name,
    type: r.resType,
    ...(r.resKind && { kind: r.resKind }),
    ...(r.sku && { sku: r.sku }),
    location: r.location,
    resourceGroup: String(r.resourceGroup || "").toLowerCase(),
    subscriptionId: r.subscriptionId,
    ...(r.subnet && { subnet: r.subnet }),
    ...(r.link && { link: r.link }),
    ...(r.ip && { ip: r.ip }),
    // Route Server is a virtual hub without a Virtual WAN.
    ...(r.rs && { routeServer: true }),
    ...(r.principal && { principal: r.principal }),
    ...(list(r.uamis).length && { identities: list(r.uamis).map(lc) }),
    ...(list(r.hosts).length && { hosts: list(r.hosts).map(lc) }),
  }));
  const byId = new Map(res.map((r) => [r.id, r]));
  // A VM sits where its first NIC sits.
  for (const nic of res.filter((r) => r.type === "microsoft.network/networkinterfaces" && r.link && r.subnet)) {
    const vm = byId.get(nic.link);
    if (vm && !vm.subnet) vm.subnet = nic.subnet;
  }
  // Others (Route Server) have their IP configurations as child resources: the subnet lists them.
  for (const v of d.vnets) {
    for (const sn of list(v.subnets)) {
      for (const c of list((sn.properties || {}).ipConfigurations)) {
        const r = byId.get(parentOf(c.id));
        if (r && !r.subnet && r.type !== "microsoft.network/networkinterfaces") r.subnet = lc(sn.id);
      }
    }
  }
  // A firewall VM (Palo Alto, Fortinet...): IP forwarding on one of its NICs, or a route sends traffic to it.
  const hops = new Set(list(d.routeTables).flatMap((t) => list(t.routes).map((r) => (r.properties || {}).nextHopIpAddress)).filter(Boolean));
  for (const n of d.nics || []) {
    const vm = n.vm && byId.get(n.vm);
    if (vm && (n.fwd || hops.has(n.nicIp))) vm.appliance = true;
  }
  // A public IP marks what holds it (through a NIC, the VM).
  for (const pip of res.filter((r) => r.type === "microsoft.network/publicipaddresses" && r.link)) {
    let owner = byId.get(parentOf(pip.link));
    if (owner && owner.type === "microsoft.network/networkinterfaces" && owner.link) owner = byId.get(owner.link) || owner;
    // Route Server's public IP is only for Azure to manage it: it takes no traffic.
    if (owner) (owner[owner.routeServer ? "mgmtIps" : "publicIps"] = owner[owner.routeServer ? "mgmtIps" : "publicIps"] || []).push(pip.ip || pip.name);
  }
  const { access, signIns } = identityLinks(d, res);
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
      id: s.id, name: s.name, type: s.siteType, resourceGroup: String(s.resourceGroup || "").toLowerCase(), subscriptionId: s.subscriptionId, location: s.location,
      prefixes: list(s.prefixes).map(String), ...(s.siteAddress && { address: s.siteAddress }), ...(s.siteProvider && { provider: s.siteProvider }), ...(s.sitePeering && { peering: s.sitePeering }),
    })),
    connections: d.connections.filter((c) => c.gateway && c.site).map((c) => ({ id: c.id, name: c.name, kind: c.connKind, gateway: c.gateway, site: c.site })),
    // null: could not be read (no access); []: read, nothing found.
    access: access && access.slice(0, MAX_ACCESS),
    signIns,
  };
}

// What each managed identity may reach, and which app registrations sign people in to which web app.
//  access:  { from: the resource holding the identity (a user-assigned identity is its own resource), to: a resource
//             id or "rg:<subscription>|<group>" (lower case), roles: [names], kind: "data" or "control" }
//  signIns: { appId, name, to: [web app ids] }
// A role on a part of a resource (a blob container, a secret) counts for the resource. Roles on a subscription or a
// management group are left out: they reach everything and would draw a line to every tile.
const DATA_ROLE = /data|secret|keys|certificate|crypto|queue|blob|file|table|message|sender|receiver|access policy/i;
function identityLinks(d, res) {
  const owner = new Map(); // principal id -> resource id
  for (const r of res) if (r.principal) owner.set(r.principal, r.id);
  const known = new Set(res.map((r) => r.id));
  const names = new Map((d.roleDefs || []).map((x) => [String(x.id).split("/").pop(), x.roleName]));
  let access = null;
  if (d.roles || d.vaultPolicies) {
    const pairs = new Map();
    const add = (from, to, role) => {
      const k = `${from}>${to}`;
      if (!pairs.has(k)) pairs.set(k, { from, to, roles: [], kind: "control" });
      const p = pairs.get(k);
      if (!p.roles.includes(role)) p.roles.push(role);
      if (DATA_ROLE.test(role)) p.kind = "data";
    };
    for (const a of d.roles || []) {
      const from = owner.get(a.principalId);
      if (!from || !a.scope) continue;
      const guid = String(a.roleDefinitionId).split("/").pop();
      const role = names.get(guid) || guid;
      const parts = a.scope.split("/");
      // /subscriptions/<s>/resourcegroups/<g> has 5 parts; a resource 9 or more.
      if (parts[3] !== "resourcegroups") continue;
      if (parts.length >= 9) {
        const to = parentOf(a.scope);
        if (known.has(to) && to !== from) add(from, to, role);
      } else if (parts.length === 5) add(from, `rg:${parts[2]}|${parts[4]}`, role);
    }
    for (const v of d.vaultPolicies || []) {
      if (!known.has(v.id)) continue;
      for (const p of list(v.policies)) {
        const from = owner.get(lc(p.objectId));
        if (!from) continue;
        const perms = p.permissions || {};
        const what = ["secrets", "keys", "certificates"].filter((k) => list(perms[k]).length).map((k) => `${k}: ${list(perms[k]).map(lc).join(", ")}`);
        add(from, v.id, `Access policy${what.length ? ` (${what.join("; ")})` : ""}`);
      }
    }
    access = [...pairs.values()];
  }
  let signIns = null;
  if (d.apps) {
    const hostOwner = new Map();
    for (const r of res) for (const h of r.hosts || []) hostOwner.set(h, r.id);
    signIns = [];
    for (const app of d.apps) {
      const uris = [app.web, app.spa, app.publicClient].flatMap((x) => list((x || {}).redirectUris));
      const to = new Set();
      for (const u of uris) {
        let host;
        try {
          host = new URL(u).hostname.toLowerCase();
        } catch {
          continue;
        }
        if (hostOwner.has(host)) to.add(hostOwner.get(host));
      }
      if (to.size) signIns.push({ appId: app.appId, name: app.displayName || app.appId, to: [...to] });
    }
  }
  return { access, signIns };
}

// The network as the traffic lines need it, in short: ids in lower case, NSG rules with one-letter keys.
function buildNetwork(d) {
  const nsgRule = (r) => {
    const p = r.properties || r;
    return {
      n: r.name, p: p.priority || 0, d: lc(p.direction) === "outbound" ? "out" : "in", a: lc(p.access) === "allow", pr: p.protocol || "*",
      s: [...list(p.sourceAddressPrefix), ...list(p.sourceAddressPrefixes)], sa: list(p.sourceApplicationSecurityGroups).map((x) => lc(x.id)),
      t: [...list(p.destinationAddressPrefix), ...list(p.destinationAddressPrefixes)], ta: list(p.destinationApplicationSecurityGroups).map((x) => lc(x.id)),
      dp: [...list(p.destinationPortRange), ...list(p.destinationPortRanges)],
    };
  };
  const byPrio = (a, b) => a.p - b.p;
  const nics = new Map();
  // Every NIC address, not only a VM's primary one: a route's next hop is often a firewall VM's inside NIC.
  const addrs = (d.nics || []).filter((n) => n.nicIp).map((n) => [n.nicIp, n.vm || n.pe || n.id]);
  for (const n of d.nics || []) {
    if (!n.nicIp || !n.nicSubnet) continue;
    const owner = n.vm || n.pe || n.id;
    const prev = nics.get(owner);
    if (prev && !(n.primary && !prev.primary)) continue; // a VM uses its primary NIC
    nics.set(owner, { owner, ip: n.nicIp, subnet: n.nicSubnet, ...(n.nsg && { nsg: n.nsg }), ...(n.pe && { pe: true }), ...(list(n.asgs).length && { asgs: list(n.asgs).map((x) => lc(x.id)) }), primary: !!n.primary });
  }
  for (const n of nics.values()) delete n.primary;
  return {
    complete: !!(d.nsgs && d.routeTables && d.nics),
    vnets: d.vnets.map((v) => ({
      id: v.id,
      prefixes: list(v.prefixes).map(String),
      peers: list(v.peerings)
        .filter((p) => /connected/i.test((p.properties || {}).peeringState || "") && (p.properties || {}).allowVirtualNetworkAccess !== false)
        .map((p) => lc(((p.properties || {}).remoteVirtualNetwork || {}).id))
        .filter(Boolean),
    })),
    subnets: d.vnets.flatMap((v) =>
      list(v.subnets).map((s) => {
        const p = s.properties || {};
        return {
          id: lc(s.id), name: s.name, vnet: v.id,
          prefixes: list(p.addressPrefixes).length ? list(p.addressPrefixes).map(String) : list(p.addressPrefix).map(String),
          ...(p.networkSecurityGroup && { nsg: lc(p.networkSecurityGroup.id) }),
          ...(p.routeTable && { rt: lc(p.routeTable.id) }),
          ...(p.privateEndpointNetworkPolicies && { pePolicies: p.privateEndpointNetworkPolicies }),
        };
      })
    ),
    nsgs: (d.nsgs || []).map((n) => ({ id: n.id, name: n.name, rules: list(n.rules).map(nsgRule).sort(byPrio), defaults: list(n.defaults).map(nsgRule).sort(byPrio) })),
    routeTables: (d.routeTables || []).map((t) => ({
      id: t.id,
      name: t.name,
      routes: list(t.routes).map((r) => {
        const p = r.properties || {};
        return { name: r.name, prefix: p.addressPrefix, hop: p.nextHopType, ...(p.nextHopIpAddress && { hopIp: p.nextHopIpAddress }) };
      }),
    })),
    nics: [...nics.values()],
    addrs,
    firewalls: (d.firewalls || []).filter((f) => f.fwIp).map((f) => ({ id: f.id, name: f.name, ip: f.fwIp, policy: f.policy, subnet: f.fwSubnet })),
  };
}

async function run() {
  const d = await read();
  const updatedAt = new Date().toISOString();
  await store.putDoc(NETWORK_KEY, { updatedAt, ...buildNetwork(d) });
  await store.putDoc(INVENTORY_KEY, { updatedAt, ...build(d) });
  cache.clear();
  return [];
}

// Saved networks, kept a short while: each click on the drawing asks for its lines.
const cache = new Map();
async function savedNetwork(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 120000) return hit;
  const [net, fw] = await Promise.all([store.getDoc(NETWORK_KEY, key), store.getDoc(FIREWALL_KEY, key).catch(() => null)]);
  const out = { at: Date.now(), net: net ? flows.index(net) : null, complete: !!(net && net.complete), fw };
  cache.set(key, out);
  return out;
}

// Can each resource in `from` reach each in `to` on the picked ports?
async function trafficLines(keys, body) {
  const tenant = String(body.tenant || "");
  if (!keys.includes(tenant)) return { status: 404, error: "Unknown tenant" };
  const checks = body.preset && flows.PRESETS[body.preset] ? flows.checksOf(body.preset) : flows.customChecks(body.ports);
  if (!checks) return { status: 400, error: "Ports look like: 443, tcp 8080-8090, udp 53" };
  const ids = (v) => (Array.isArray(v) ? v : []).map(lc).filter(Boolean).slice(0, MAX_IDS);
  // Brief: for the lines over the whole drawing, without the path steps and the open checks.
  const brief = !!body.brief;
  let capped = false;
  const from = ids(body.from), to = ids(body.to);
  const saved = await savedNetwork(tenant);
  if (!saved.net) return { checks: checks.map((c) => c.label), results: [], missing: "Run the Architecture scan again: the saved drawing is older than the traffic lines" };
  const results = [];
  for (const a of from) {
    for (const b of to) {
      if (a === b) continue;
      if (results.length >= MAX_PAIRS) {
        capped = true;
        break;
      }
      const na = saved.net.nics.get(a), nb = saved.net.nics.get(b);
      if (!na || !nb) {
        if (!brief) results.push({ from: a, to: b, state: "none", why: "No private address known for one side" });
        continue;
      }
      const r = flows.evaluate(saved.net, saved.fw, na, nb, checks);
      if (brief) {
        delete r.steps;
        if (r.checks) r.checks = r.checks.filter((c) => c.ok !== "all").map(({ rule, ...c }) => c);
      }
      results.push({ from: a, to: b, ...r });
    }
  }
  return {
    checks: checks.map((c) => c.label),
    results,
    ...(capped && { capped: MAX_PAIRS }),
    ...(!saved.fw && { note: "Firewall rules are not saved: run the Firewall policies scan to follow traffic through a firewall" }),
    ...(!saved.complete && { missing: "NSGs or routes could not be read in the last scan" }),
  };
}

async function inventory(keys) {
  const out = { updatedAt: null, tenants: [], resources: [], vnets: [], groups: [], subscriptions: [], sites: [], connections: [], access: [], signIns: [], unread: [], truncated: false, failures: [] };
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
    for (const part of ["resources", "vnets", "groups", "subscriptions", "sites", "connections", "access", "signIns"]) out[part].push(...(doc[part] || []).map(tag));
    // What the last scan could not read in this tenant (a scan from before this was added saved neither).
    for (const part of ["access", "signIns"]) if (!Array.isArray(doc[part])) out.unread.push({ tenant: k, part });
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
  app.post("/api/architecture/flows", async (req, res) => {
    try {
      const out = await trafficLines(readKeys(req), req.body || {});
      if (out.error) return res.status(out.status).json({ error: out.error });
      res.json(out);
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
  _test: { build, buildNetwork, trafficLines, parentOf, identityLinks },
};
