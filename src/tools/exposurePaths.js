// Exposure paths: risks that only show when resources are looked at together.
// Each finding is a chain from the internet to something that matters:
//   - a public entry point (a VM the internet can reach through a public IP,
//     a public load balancer or application gateway; a public web app),
//   - whose managed identity can take over a subscription or read sensitive data, or
//   - whose network reaches a sensitive workload (key vault, database, storage,
//     or anything tagged as sensitive) with nothing in between: no NSG, an NSG
//     that lets the whole VNet in, private endpoints that ignore NSGs, and no
//     firewall (NVA) route on the way.
// Everything comes from Resource Graph, so Reader is enough. The network part is
// a model of NSG rules and routes, not a live test: application security groups,
// NIC-level outbound rules, Azure Firewall policies and VMSS are not followed.
const { resourceGraphQuery } = require("../armClient");
const settings = require("../settings");
const { nameOf } = require("./util");

const TOOL_ID = "exposure-paths";
const MAX_LISTED = 5; // targets named in one finding's detail
const MAX_HOPS = 3; // machines an attacker signs in to, one after another, inside the network
const MAX_HOSTS = 3000; // VM addresses: above this the hop search is skipped
const MAX_MAP = 40; // subnets in one VNet map
const SPECIAL_SUBNETS = /^(gatewaysubnet|azurefirewallsubnet|azurefirewallmanagementsubnet|azurebastionsubnet|routeserversubnet)$/i;

// Built-in role GUIDs (the same in every tenant).
const TAKEOVER_ROLES = {
  "8e3af657-a8ff-443c-a75c-2fe8c4bcb635": "Owner",
  "b24988ac-6180-42a0-ab88-20f7382dd24c": "Contributor",
  "18d7d88d-d35e-4fb5-a5c3-7773c20a72d9": "User Access Administrator",
  "f58310d9-a9f6-439a-9e8d-f62e7b41a168": "Role Based Access Control Administrator",
};
const DATA_ROLES = {
  "00482a5a-887f-4fb3-b363-3b7fe8e74483": "Key Vault Administrator",
  "b86a8fe4-44ce-4948-aee5-eccb2c155cd7": "Key Vault Secrets Officer",
  "4633458b-17de-408a-b874-0445c86b69e6": "Key Vault Secrets User",
  "14b46e9e-c2b7-41b4-b07b-48a6ebf60603": "Key Vault Crypto Officer",
  "a4417e6f-fecd-4de8-b567-7b0420556985": "Key Vault Certificates Officer",
  "f25e0fa2-a7c8-4377-a976-54943a77a395": "Key Vault Contributor",
  "b7e6dc6d-f1e8-4753-8033-0f276bb0955b": "Storage Blob Data Owner",
  "ba92f5b4-2d11-453d-a403-e96b0029c9fe": "Storage Blob Data Contributor",
  "2a2b9908-6ea1-4ae2-8e65-a410df84e7d1": "Storage Blob Data Reader",
  "17d1049b-9a84-46fb-8f53-869881c3d3ab": "Storage Account Contributor",
  "6d8ee4ec-f05a-4a1d-8b00-a9b17e38b437": "SQL Server Contributor",
  "9b7fa17d-e63e-47b0-bb0a-15c516ac86ec": "SQL DB Contributor",
  "5bd9cd88-fe45-4216-938b-f97437e15450": "DocumentDB Account Contributor",
};

// Sensitive by type, with the TCP ports a client uses.
const SENSITIVE_TYPES = {
  "microsoft.keyvault/vaults": ["Key vault", [443]],
  "microsoft.sql/servers": ["SQL server", [1433]],
  "microsoft.sql/managedinstances": ["SQL managed instance", [1433, 3342]],
  "microsoft.storage/storageaccounts": ["Storage account", [443, 445]],
  "microsoft.documentdb/databaseaccounts": ["Cosmos DB", [443, 10255]],
  "microsoft.dbforpostgresql/flexibleservers": ["PostgreSQL", [5432]],
  "microsoft.dbformysql/flexibleservers": ["MySQL", [3306]],
  "microsoft.cache/redis": ["Redis", [6379, 6380]],
};
const ADMIN_PORTS = { 22: "SSH", 3389: "RDP", 5985: "WinRM", 5986: "WinRM" };
const ADMIN_LIST = [22, 3389, 5985, 5986];
const OS_ADMIN = { windows: [3389, 5985, 5986], linux: [22] }; // the ports a sign-in to the next machine uses
const DATA_LIST = [1433, 3306, 5432, 6379, 6380, 10255, 445, 443];
const WELL_KNOWN = { ...ADMIN_PORTS, 80: "HTTP", 443: "HTTPS", 1433: "SQL", 3306: "MySQL", 5432: "PostgreSQL", 6379: "Redis", 445: "SMB" };
const SENSITIVE_VALUE = /^(true|yes|1|confidential|restricted|sensitive|secret|high|critical|pii)$/i;

const lc = (s) => String(s || "").toLowerCase();
const arr = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

function sensitiveTags() {
  return (settings.get("AZURE_SENSITIVE_TAGS") || "DataClassification,Sensitivity,Confidentiality,Sensitive")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}
function taggedSensitive(tags, names) {
  for (const [k, v] of Object.entries(tags || {})) if (names.includes(k.toLowerCase()) && SENSITIVE_VALUE.test(String(v).trim())) return `${k}=${v}`;
  return "";
}

/* ---------- IPv4 prefixes ---------- */
function cidr(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)(?:\/(\d+))?$/.exec(String(s || "").trim());
  if (!m) return null;
  const bits = m[5] == null ? 32 : Number(m[5]);
  if (bits > 32 || [1, 2, 3, 4].some((i) => Number(m[i]) > 255)) return null;
  const ip = ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { base: (ip & mask) >>> 0, bits, mask };
}
const contains = (outer, inner) => !!outer && !!inner && outer.bits <= inner.bits && ((inner.base & outer.mask) >>> 0) === outer.base;
const overlaps = (a, b) => contains(a, b) || contains(b, a);

/* ---------- port ranges ---------- */
function ruleRanges(p) {
  return [...arr(p.destinationPortRange), ...arr(p.destinationPortRanges)].map((r) => {
    const s = String(r).trim();
    if (s === "*") return [0, 65535];
    const [a, b] = s.split("-").map(Number);
    return [a, Number.isFinite(b) ? b : a];
  });
}
const coversPort = (ranges, port) => ranges.some(([a, b]) => port >= a && port <= b);
const isAll = (ranges) => ranges.some(([a, b]) => a <= 1 && b >= 65535);
function intersect(x, y) {
  const out = [];
  for (const [a1, b1] of x) for (const [a2, b2] of y) if (Math.max(a1, a2) <= Math.min(b1, b2)) out.push([Math.max(a1, a2), Math.min(b1, b2)]);
  return out;
}
function portsText(ranges) {
  if (isAll(ranges)) return "all ports";
  const named = Object.keys(WELL_KNOWN).map(Number).filter((p) => coversPort(ranges, p));
  const parts = ranges.slice(0, 4).map(([a, b]) => (a === b ? `${a}${WELL_KNOWN[a] ? ` ${WELL_KNOWN[a]}` : ""}` : `${a}-${b}`));
  const extra = ranges.length > 4 ? ` +${ranges.length - 4}` : "";
  return `port${ranges.length === 1 && ranges[0][0] === ranges[0][1] ? "" : "s"} ${parts.join(", ")}${extra}${named.length && parts.every((p) => /-/.test(p)) ? ` (incl. ${named.map((p) => WELL_KNOWN[p]).join(", ")})` : ""}`;
}
const adminOpen = (ranges) => Object.keys(ADMIN_PORTS).some((p) => coversPort(ranges, Number(p)));

/* ---------- NSG rules ---------- */
const DEFAULTS = {
  inbound: [
    { name: "AllowVnetInBound", priority: 65000, access: "Allow", sourceAddressPrefix: "VirtualNetwork", destinationAddressPrefix: "VirtualNetwork", destinationPortRange: "*", protocol: "*" },
    { name: "AllowAzureLoadBalancerInBound", priority: 65001, access: "Allow", sourceAddressPrefix: "AzureLoadBalancer", destinationAddressPrefix: "*", destinationPortRange: "*", protocol: "*" },
    { name: "DenyAllInBound", priority: 65500, access: "Deny", sourceAddressPrefix: "*", destinationAddressPrefix: "*", destinationPortRange: "*", protocol: "*" },
  ],
  outbound: [
    { name: "AllowVnetOutBound", priority: 65000, access: "Allow", sourceAddressPrefix: "VirtualNetwork", destinationAddressPrefix: "VirtualNetwork", destinationPortRange: "*", protocol: "*" },
    { name: "AllowInternetOutBound", priority: 65001, access: "Allow", sourceAddressPrefix: "*", destinationAddressPrefix: "Internet", destinationPortRange: "*", protocol: "*" },
    { name: "DenyAllOutBound", priority: 65500, access: "Deny", sourceAddressPrefix: "*", destinationAddressPrefix: "*", destinationPortRange: "*", protocol: "*" },
  ],
};
function nsgRules(nsg, direction) {
  const flat = (r) => ({ name: r.name, ...(r.properties || r) });
  const custom = arr(nsg.rules).map(flat);
  const defaults = arr(nsg.defaults).map(flat);
  return [...custom, ...(defaults.length ? defaults : DEFAULTS[direction])]
    .filter((p) => lc(p.direction || direction) === direction && !/^(udp|icmp|esp|ah)$/i.test(p.protocol || ""))
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));
}
const ANY = new Set(["*", "any", "0.0.0.0/0", "0.0.0.0"]);
const INTERNET = new Set([...ANY, "internet"]);
// Does one side of a rule match an address? `vnet` = the address is inside the VirtualNetwork tag here.
function sideMatches(prefixes, addr, vnet) {
  return prefixes.some((s) => {
    const v = lc(s);
    if (ANY.has(v)) return true;
    if (v === "virtualnetwork") return vnet;
    const c = cidr(s);
    return c && addr ? overlaps(c, addr) : false;
  });
}
const sources = (p) => [...arr(p.sourceAddressPrefix), ...arr(p.sourceAddressPrefixes)];
const dests = (p) => [...arr(p.destinationAddressPrefix), ...arr(p.destinationAddressPrefixes)];

// First matching rule decides. Returns { allow, rule } for the first of `ports` that is allowed, else { allow:false, rule }.
function nsgDecides(nsg, direction, src, dst, ports) {
  const rules = nsgRules(nsg, direction);
  let denied = null;
  for (const port of ports) {
    const hit = rules.find((p) => sideMatches(sources(p), src, true) && sideMatches(dests(p), dst, true) && coversPort(ruleRanges(p), port));
    if (hit && lc(hit.access) === "allow") return { allow: true, rule: hit.name, port };
    denied = denied || (hit && hit.name);
  }
  return { allow: false, rule: denied };
}

// Ports an NSG opens to the internet: allow rules from any source, minus what an earlier deny from any source closes.
function internetPorts(nsg) {
  const rules = nsgRules(nsg, "inbound").filter((p) => sources(p).some((s) => INTERNET.has(lc(s))));
  const open = [];
  const closed = [];
  const named = [];
  for (const p of rules) {
    let ranges = ruleRanges(p);
    for (const c of closed) ranges = subtract(ranges, c);
    if (lc(p.access) === "allow" && ranges.length) {
      open.push(...ranges);
      named.push(p.name);
    }
    closed.push(ruleRanges(p)); // first match wins: later rules never change these ports
  }
  return { ranges: merge(open), rules: named };
}
function subtract(ranges, cut) {
  let out = ranges;
  for (const [c1, c2] of cut) {
    const next = [];
    for (const [a, b] of out) {
      if (c2 < a || c1 > b) next.push([a, b]);
      else {
        if (a < c1) next.push([a, c1 - 1]);
        if (b > c2) next.push([c2 + 1, b]);
      }
    }
    out = next;
  }
  return out;
}
function merge(ranges) {
  const s = [...ranges].sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([...r]);
  }
  return out;
}

/* ---------- the model ---------- */
function principalsOf(identity) {
  const out = [];
  if (!identity) return out;
  if (identity.principalId) out.push({ principalId: lc(identity.principalId), label: "system-assigned identity" });
  for (const [id, v] of Object.entries(identity.userAssignedIdentities || {})) if (v && v.principalId) out.push({ principalId: lc(v.principalId), label: `identity ${nameOf(id)}` });
  return out;
}

function buildNetwork(d) {
  const subnets = new Map(); // subnetId -> { id, name, vnetId, prefixes:[cidr], nsgId, rtId, pePolicies }
  const vnets = new Map(); // vnetId -> { id, name, spaces:[cidr], peers:Set }
  for (const v of d.vnets) {
    const vid = lc(v.id);
    vnets.set(vid, { id: v.id, name: v.name, resourceGroup: v.resourceGroup, subscriptionId: v.subscriptionId, spaces: arr(v.addressPrefixes).map(cidr).filter(Boolean), peers: new Set() });
    for (const s of arr(v.subnets)) {
      const p = s.properties || {};
      subnets.set(lc(s.id), {
        id: s.id,
        name: s.name,
        vnetId: vid,
        prefixes: [...arr(p.addressPrefix), ...arr(p.addressPrefixes)].map(cidr).filter(Boolean),
        prefixText: String(p.addressPrefix || arr(p.addressPrefixes)[0] || ""),
        nsgId: lc(p.networkSecurityGroup && p.networkSecurityGroup.id),
        rtId: lc(p.routeTable && p.routeTable.id),
        pePolicies: String(p.privateEndpointNetworkPolicies || "Disabled"),
      });
    }
    for (const pe of arr(v.peerings)) {
      const p = pe.properties || {};
      if (lc(p.peeringState) === "connected" && p.allowVirtualNetworkAccess !== false && p.remoteVirtualNetwork) vnets.get(vid).peers.add(lc(p.remoteVirtualNetwork.id));
    }
  }
  const nsgs = new Map(d.nsgs.map((n) => [lc(n.id), n]));
  const routeTables = new Map(d.routeTables.map((r) => [lc(r.id), r]));
  return { subnets, vnets, nsgs, routeTables };
}

// Sensitive things and where on the network they can be reached from.
function buildTargets(d, net, tagNames) {
  const targets = new Map(); // resourceId -> { id, name, what, ports, places:[{ subnetId, prefix, how, pe }], vnetRules:Set, publicOn }
  const add = (r, what, ports, why) => {
    const id = lc(r.id);
    if (!targets.has(id)) targets.set(id, { id: r.id, name: r.name, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId, what, why, ports, places: [], vnetRules: new Set(), publicOn: true });
    return targets.get(id);
  };
  for (const r of d.resources) {
    const type = lc(r.type);
    const known = SENSITIVE_TYPES[type];
    const tag = taggedSensitive(r.tags, tagNames);
    if (!known && !tag) continue;
    if (type === "microsoft.storage/storageaccounts" && lc(r.tags && r.tags["ms-resource-usage"]) === "azure-cloud-shell") continue;
    const t = add(r, known ? known[0] : type === "microsoft.compute/virtualmachines" ? "VM" : r.type.split("/").pop(), known ? known[1] : [...Object.keys(ADMIN_PORTS).map(Number), 443, 1433], tag ? `tagged ${tag}` : "");
    t.publicOn = !/^disabled$/i.test(r.publicNetworkAccess || "");
    for (const rule of arr(r.vnetRules)) if (rule && rule.id) t.vnetRules.add(lc(rule.id));
    const delegated = r.delegatedSubnet || r.miSubnet;
    if (delegated && net.subnets.has(lc(delegated))) {
      const s = net.subnets.get(lc(delegated));
      t.places.push({ subnetId: lc(delegated), prefix: s.prefixes[0], how: `in subnet ${s.name}`, pe: false });
    }
  }
  for (const pe of d.privateEndpoints) {
    const target = lc(pe.target);
    const t = targets.get(target);
    const s = net.subnets.get(lc(pe.subnetId));
    if (!t || !s) continue;
    t.places.push({ subnetId: lc(pe.subnetId), prefix: s.prefixes[0], how: `private endpoint ${pe.name}`, pe: true });
  }
  // Tagged VMs: reached at their NICs' private addresses.
  for (const nic of d.nics) {
    const t = nic.vmId && targets.get(lc(nic.vmId));
    if (!t) continue;
    for (const ipc of arr(nic.ipcs)) {
      const s = net.subnets.get(lc(ipc.subnetId));
      if (s) t.places.push({ subnetId: lc(ipc.subnetId), prefix: cidr(ipc.privateIp) || s.prefixes[0], how: `NIC ${nic.name}`, pe: false, nicNsg: lc(nic.nsgId) });
    }
  }
  return targets;
}

// Internet-reachable VMs and web apps.
function buildEntries(d, net) {
  const pips = new Map(d.pips.map((p) => [lc(p.id), p]));
  const lbPools = new Map(); // backend pool id -> { lb, ranges }
  const natRules = new Map(); // NIC ipconfig id -> [{ lb, ranges }]
  for (const lb of d.lbs) {
    if (!arr(lb.frontends).some((f) => f && f.properties && f.properties.publicIPAddress)) continue;
    for (const rule of arr(lb.rules)) {
      const p = rule.properties || {};
      const port = Number(p.backendPort);
      const ranges = port === 0 ? [[0, 65535]] : [[port, port]];
      for (const pool of [p.backendAddressPool, ...arr(p.backendAddressPools)].filter(Boolean)) {
        const k = lc(pool.id);
        const x = lbPools.get(k) || { lb, ranges: [] };
        x.ranges.push(...ranges);
        lbPools.set(k, x);
      }
    }
    for (const nat of arr(lb.natRules)) {
      const p = nat.properties || {};
      if (!p.backendIPConfiguration) continue;
      const k = lc(p.backendIPConfiguration.id);
      natRules.set(k, [...(natRules.get(k) || []), { lb, ranges: [[Number(p.backendPort), Number(p.backendPort)]] }]);
    }
  }
  const agwPools = new Map(); // pool id -> agw
  for (const g of d.agws) {
    if (!arr(g.frontends).some((f) => f && f.properties && f.properties.publicIPAddress)) continue;
    for (const pool of arr(g.pools)) agwPools.set(lc(pool.id), g);
  }

  const vms = new Map(d.vms.map((v) => [lc(v.id), v]));
  const entries = new Map(); // id -> entry
  const entryOf = (v) => {
    const k = lc(v.id);
    if (!entries.has(k)) entries.set(k, { id: v.id, name: v.name, resourceGroup: v.resourceGroup, subscriptionId: v.subscriptionId, type: "VM", ways: [], subnets: new Set(), principals: principalsOf(v.identity) });
    return entries.get(k);
  };
  const nsgText = (ids) => ids.map((id) => nameOf(id)).join(" and ");

  for (const nic of d.nics) {
    const vm = nic.vmId && vms.get(lc(nic.vmId));
    if (!vm) continue;
    for (const ipc of arr(nic.ipcs)) {
      const subnet = net.subnets.get(lc(ipc.subnetId));
      const nsgIds = [lc(nic.nsgId), subnet && subnet.nsgId].filter(Boolean);
      // What the internet gets through both NSGs (NIC and subnet). No NSG: a Standard IP is closed, Basic is open.
      const throughNsgs = (wanted) => {
        let ranges = wanted;
        const names = [];
        for (const id of nsgIds) {
          const n = net.nsgs.get(id);
          if (!n) continue;
          const o = internetPorts(n);
          ranges = intersect(ranges, o.ranges);
          names.push(`${n.name}: ${o.rules.join(", ") || "none"}`);
        }
        return { ranges: merge(ranges), names };
      };
      const ways = [];
      const pip = ipc.pipId && pips.get(lc(ipc.pipId));
      if (pip) {
        if (!nsgIds.length) {
          if (!/^standard$/i.test(pip.sku || "")) ways.push({ via: `public IP ${pip.name}${pip.ip ? ` (${pip.ip})` : ""}`, ranges: [[0, 65535]], note: "no NSG on the NIC or subnet" });
        } else {
          const o = throughNsgs([[0, 65535]]);
          if (o.ranges.length) ways.push({ via: `public IP ${pip.name}${pip.ip ? ` (${pip.ip})` : ""}`, ranges: o.ranges, note: `open by ${nsgText(nsgIds)}` });
        }
      }
      const lbHits = [...arr(ipc.lbPools).map((id) => lbPools.get(lc(id))).filter(Boolean), ...(natRules.get(lc(ipc.id)) || [])];
      for (const h of lbHits) {
        const o = nsgIds.length ? throughNsgs(h.ranges) : { ranges: merge(h.ranges) }; // a public LB keeps the client's address, so NSGs see the internet
        if (o.ranges.length) ways.push({ via: `public load balancer ${h.lb.name}`, ranges: o.ranges, note: nsgIds.length ? `allowed by ${nsgText(nsgIds)}` : "no NSG" });
      }
      for (const id of arr(ipc.agwPools)) {
        const g = agwPools.get(lc(id));
        if (g) ways.push({ via: `application gateway ${g.name}`, ranges: merge(arr(g.ports).map((p) => [Number(p), Number(p)]).filter(([p]) => p > 0)), note: "public frontend", web: true });
      }
      if (!ways.length) continue;
      const e = entryOf(vm);
      e.ways.push(...ways);
      if (subnet) e.subnets.add(lc(ipc.subnetId));
    }
  }
  for (const s of d.sites) {
    if (/^disabled$/i.test(s.publicNetworkAccess || "") || /^stopped$/i.test(s.state || "")) continue;
    const e = { id: s.id, name: s.name, resourceGroup: s.resourceGroup, subscriptionId: s.subscriptionId, type: /functionapp/i.test(s.kind || "") ? "Function app" : "Web app", ways: [{ via: `${s.defaultHostName || s.name}`, ranges: [[443, 443]], note: "public web app", web: true }], subnets: new Set(), principals: principalsOf(s.identity) };
    if (s.vnetSubnet && net.subnets.has(lc(s.vnetSubnet))) e.subnets.add(lc(s.vnetSubnet));
    entries.set(lc(s.id), e);
  }
  for (const e of entries.values()) {
    e.ranges = merge(e.ways.flatMap((w) => w.ranges));
    e.admin = e.ways.some((w) => !w.web && adminOpen(w.ranges));
  }
  return entries;
}

// Can traffic from an entry's subnet reach a target's place with nothing in between?
function lateral(net, entrySubnetId, place, ports) {
  const es = net.subnets.get(entrySubnetId);
  const ts = net.subnets.get(place.subnetId);
  if (!es || !ts || !place.prefix) return null;
  const sameVnet = es.vnetId === ts.vnetId;
  const peered = !sameVnet && net.vnets.get(es.vnetId) && net.vnets.get(es.vnetId).peers.has(ts.vnetId);
  if (!sameVnet && !peered) return null;
  const src = es.prefixes[0];
  // A route that sends the traffic to a firewall (NVA) counts as segmentation. It must beat the VNet's own route,
  // and a private endpoint's /32 route beats it unless the endpoint's subnet has route-table policies on.
  const space = (net.vnets.get(ts.vnetId) || { spaces: [] }).spaces.find((s) => contains(s, place.prefix));
  const peRoutes = /^(enabled|routetableenabled)$/i.test(ts.pePolicies);
  const rt = es.rtId && net.routeTables.get(es.rtId);
  const nva = rt && arr(rt.routes).find((r) => {
    const p = r.properties || r;
    const c = cidr(p.addressPrefix);
    return /^virtualappliance$/i.test(p.nextHopType || "") && contains(c, place.prefix) && (!space || c.bits >= space.bits) && (!place.pe || peRoutes);
  });
  if (nva) return null;
  const steps = [];
  if (es.nsgId && net.nsgs.get(es.nsgId)) {
    const out = nsgDecides(net.nsgs.get(es.nsgId), "outbound", src, place.prefix, ports);
    if (!out.allow) return null;
  }
  const nsgApplies = !place.pe || /^(enabled|networksecuritygroupenabled)$/i.test(ts.pePolicies);
  let port = ports[0];
  if (!ts.nsgId) steps.push(`no NSG on ${ts.name}`);
  else if (!nsgApplies) steps.push(`the NSG on ${ts.name} does not apply to private endpoints (network policies off)`);
  else {
    const n = net.nsgs.get(ts.nsgId);
    if (!n) return null;
    const v = nsgDecides(n, "inbound", src, place.prefix, ports);
    if (!v.allow) return null;
    port = v.port;
    steps.push(`${n.name} lets ${sameVnet ? "the VNet" : "the peered VNet"} in (${v.rule})`);
  }
  if (place.nicNsg && net.nsgs.get(place.nicNsg)) {
    const v = nsgDecides(net.nsgs.get(place.nicNsg), "inbound", src, place.prefix, ports);
    if (!v.allow) return null;
  }
  return { port, sameVnet, sameSubnet: entrySubnetId === place.subnetId, peered, note: steps.join("; "), subnet: ts.name, vnet: (net.vnets.get(ts.vnetId) || {}).name };
}

function analyse(d, opts = {}) {
  const tagNames = opts.tagNames || ["dataclassification", "sensitivity", "confidentiality", "sensitive"];
  const net = buildNetwork(d);
  const targets = buildTargets(d, net, tagNames);
  const entries = buildEntries(d, net);
  const roles = new Map(); // principalId -> [{ role, guid, scope }]
  for (const a of d.roleAssignments) {
    const guid = lc(a.roleDefinitionId).split("/").pop();
    if (!TAKEOVER_ROLES[guid] && !DATA_ROLES[guid]) continue;
    const k = lc(a.principalId);
    roles.set(k, [...(roles.get(k) || []), { guid, role: TAKEOVER_ROLES[guid] || DATA_ROLES[guid], scope: a.scope }]);
  }
  const vaultPolicies = new Map(); // principalId -> [vault target]
  for (const r of d.resources) {
    if (lc(r.type) !== "microsoft.keyvault/vaults" || r.rbac === true) continue;
    for (const p of arr(r.accessPolicies)) {
      const perms = (p && p.permissions) || {};
      const reads = [...arr(perms.secrets), ...arr(perms.keys), ...arr(perms.certificates)].some((x) => /^(get|list|all|decrypt|unwrapkey)$/i.test(x));
      if (reads && p.objectId) vaultPolicies.set(lc(p.objectId), [...(vaultPolicies.get(lc(p.objectId)) || []), targets.get(lc(r.id))].filter(Boolean));
    }
  }
  const scopeText = (s) => {
    const x = lc(s);
    if (x.includes("/providers/microsoft.management/managementgroups/")) return `management group ${s.split("/").pop()}`;
    const m = /^\/subscriptions\/([^/]+)(\/resourcegroups\/([^/]+))?(\/providers\/.+)?$/i.exec(s || "");
    if (!m) return s;
    if (m[4]) return nameOf(s);
    if (m[3]) return `resource group ${m[3]}`;
    const n = (opts.subNames || {})[m[1]];
    return `subscription ${n || m[1]}`;
  };
  const covers = (scope, id) => {
    const s = lc(scope).replace(/\/$/, "");
    return s.includes("/providers/microsoft.management/managementgroups/") || s === "/" || lc(id) === s || lc(id).startsWith(s + "/");
  };

  const findings = [];
  const entryStep = (e) => {
    const w = e.ways[0];
    return [
      { t: "internet", label: "Internet" },
      { t: "entry", label: w.via, note: `${portsText(w.ranges)}${w.note ? ` · ${w.note}` : ""}` },
      { t: "resource", label: e.name, note: e.type },
    ];
  };
  const entryText = (e) => `${e.type} ${e.name} is reachable from the internet (${e.ways.slice(0, 3).map((w) => `${w.via}: ${portsText(w.ranges)}`).join("; ")}${e.ways.length > 3 ? `; +${e.ways.length - 3} more` : ""})`;
  const list = (names) => `${names.slice(0, MAX_LISTED).join(", ")}${names.length > MAX_LISTED ? ` and ${names.length - MAX_LISTED} more` : ""}`;
  const base = (e, kind) => ({ kind, id: `${e.id}#${kind}`, name: e.name, resourceGroup: e.resourceGroup, subscriptionId: e.subscriptionId, entry: e.type });

  // What a set of managed identities can do: take over a scope, or read sensitive data.
  const identityReach = (principals) => {
    const takeover = [];
    const data = new Map();
    for (const p of principals) {
      for (const a of roles.get(p.principalId) || []) {
        if (TAKEOVER_ROLES[a.guid]) {
          if (/\/providers\/(?!microsoft\.management\/)/i.test(a.scope)) continue; // a role on one resource is not a takeover
          takeover.push({ text: `${a.role} on ${scopeText(a.scope)}`, via: p.label, sub: !/resourcegroups/i.test(a.scope) });
        } else {
          for (const t of targets.values()) if (covers(a.scope, t.id) && roleFits(a.guid, t.what)) data.set(lc(t.id), { t, role: a.role, via: p.label });
        }
      }
      for (const t of vaultPolicies.get(p.principalId) || []) data.set(lc(t.id), { t, role: "access policy", via: p.label });
    }
    takeover.sort((a, b) => b.sub - a.sub);
    return { takeover, data: [...data.values()] };
  };
  // Sensitive workloads the network lets a set of subnets reach.
  const networkReach = (subnetIds, selfId) => {
    const reach = [];
    for (const t of targets.values()) {
      if (lc(t.id) === lc(selfId)) continue;
      let found = null;
      for (const sid of subnetIds) {
        for (const place of t.places) {
          const hit = lateral(net, sid, place, t.ports);
          if (hit) {
            found = { t, place, hit };
            break;
          }
        }
        if (!found && t.publicOn && t.vnetRules.has(sid)) {
          const s = net.subnets.get(sid);
          found = { t, place: { how: "public endpoint" }, hit: { note: `its firewall lets ${s ? s.name : "the subnet"} in by a VNet rule`, port: t.ports[0] } };
        }
        if (found) break;
      }
      if (found) reach.push(found);
    }
    return reach;
  };
  const netStep = (hit) => ({ t: "network", label: hit.sameSubnet ? `same subnet ${hit.subnet}` : hit.peered ? `peered VNet ${hit.vnet}` : hit.vnet ? `VNet ${hit.vnet}` : "VNet rule", note: hit.note });
  const targetStep = (r, more) => ({ t: "target", label: more ? `${r.t.name} +${more}` : r.t.name, note: `${r.t.what}${r.t.why ? `, ${r.t.why}` : ""} · ${r.place.how}` });
  const reachText = (r) => `${r.t.name} (${r.t.what}, ${r.place.how}${r.hit.port ? `, port ${r.hit.port}` : ""}: ${r.hit.note || "open"})`;

  // Every VM address inside the network: where an attacker who holds one machine can sign in next.
  const vmById = new Map(d.vms.map((v) => [lc(v.id), v]));
  const hosts = [];
  const hostSubnets = new Map(); // vm id -> Set(subnet ids)
  for (const nic of d.nics) {
    const vm = nic.vmId && vmById.get(lc(nic.vmId));
    if (!vm) continue;
    for (const ipc of arr(nic.ipcs)) {
      const s = net.subnets.get(lc(ipc.subnetId));
      if (!s) continue;
      const key = lc(vm.id);
      hosts.push({ vm, key, subnetId: lc(ipc.subnetId), place: { subnetId: lc(ipc.subnetId), prefix: cidr(ipc.privateIp) || s.prefixes[0], how: `NIC ${nic.name}`, pe: false, nicNsg: lc(nic.nsgId) } });
      hostSubnets.set(key, (hostSubnets.get(key) || new Set()).add(lc(ipc.subnetId)));
    }
  }
  const hopMemo = new Map();
  const hop = (sid, h) => {
    const os = lc(h.vm.os);
    const k = `${sid}|${h.place.subnetId}|${h.place.prefix ? h.place.prefix.base : ""}|${h.place.nicNsg}|${os}`;
    if (!hopMemo.has(k)) hopMemo.set(k, lateral(net, sid, h.place, OS_ADMIN[os] || ADMIN_LIST));
    return hopMemo.get(k);
  };
  // Breadth-first from an entry over admin ports (SSH, RDP, WinRM), at most MAX_HOPS machines deep.
  const pivots = (e) => {
    const out = [];
    if (!e.subnets.size || hosts.length > MAX_HOSTS) return out;
    const seen = new Set([lc(e.id)]);
    let frontier = [{ subnets: e.subnets, chain: [] }];
    for (let depth = 0; depth < MAX_HOPS && frontier.length; depth++) {
      const next = [];
      for (const node of frontier) {
        for (const h of hosts) {
          if (seen.has(h.key)) continue;
          let hit = null;
          for (const sid of node.subnets) if ((hit = hop(sid, h))) break;
          if (!hit) continue;
          seen.add(h.key);
          next.push({ key: h.key, subnets: hostSubnets.get(h.key), chain: [...node.chain, { vm: h.vm, hit, subnet: net.subnets.get(h.subnetId).name }] });
        }
      }
      out.push(...next);
      frontier = next;
    }
    return out;
  };
  const portName = (p) => ADMIN_PORTS[p] || `port ${p}`;
  const hopSteps = (chain) => chain.flatMap((c) => [
    { t: "network", label: `${portName(c.hit.port)} into ${c.subnet}`, note: c.hit.note },
    { t: "resource", label: c.vm.name, note: "VM" },
  ]);
  const chainText = (chain) => chain.map((c) => `${portName(c.hit.port)} to ${c.vm.name} in ${c.subnet}`).join(", then ");

  for (const e of entries.values()) {
    // 1 + 2: what the entry's identity can do
    const own = identityReach(e.principals);
    if (own.takeover.length) {
      const top = own.takeover[0];
      findings.push({
        ...base(e, "path-identity-takeover"),
        path: [...entryStep(e), { t: "identity", label: top.via }, { t: "target", label: top.text }],
        detail: `${entryText(e)}. Its ${top.via} holds ${list(own.takeover.map((x) => x.text))}: whoever breaks into it can change or delete everything there. Give the identity only the roles it needs, on the resources it needs`,
      });
    }
    if (own.data.length) {
      const hits = own.data;
      findings.push({
        ...base(e, "path-identity-data"),
        targets: hits.map((h) => h.t.id),
        path: [...entryStep(e), { t: "identity", label: e.principals.length === 1 ? e.principals[0].label : "managed identity" }, { t: "target", label: hits.length === 1 ? hits[0].t.name : `${hits[0].t.name} +${hits.length - 1}`, note: hits.length === 1 ? hits[0].t.what : `${hits.length} sensitive resources` }],
        detail: `${entryText(e)}. Its managed identity can read data in ${list(hits.map((h) => `${h.t.name} (${h.role})`))}. Whoever breaks into it gets that data. Keep the access only if the app needs it, and narrow the role`,
      });
    }
    // 3: network reach to sensitive workloads
    const reach = networkReach(e.subnets, e.id);
    if (reach.length) {
      const first = reach.find((r) => r.hit.sameSubnet) || reach[0];
      const kind = e.admin ? "path-lateral-admin" : "path-lateral-data";
      findings.push({
        ...base(e, kind),
        targets: reach.map((r) => r.t.id),
        path: [...entryStep(e), netStep(first.hit), targetStep(first, reach.length - 1)],
        detail: `${entryText(e)}. From its network it can reach ${list(reach.map(reachText))}. ${e.admin ? "An admin port is open to the internet, so one stolen password is one step from the data. " : ""}Put an NSG that allows only the needed sources on the data subnet (turn on network policies for private endpoints), or route the traffic through a firewall`,
      });
    }
    // 4: inside the network: sign in to the next machine, and the next, and see what opens up from there
    const direct = new Set([...reach.map((r) => lc(r.t.id)), ...own.data.map((h) => lc(h.t.id))]);
    const gained = new Map(); // target id -> { chain, r }
    let takeover = null;
    for (const p of pivots(e)) {
      for (const r of networkReach(p.subnets, p.key)) if (!direct.has(lc(r.t.id)) && !gained.has(lc(r.t.id))) gained.set(lc(r.t.id), { chain: p.chain, r });
      const last = p.chain[p.chain.length - 1].vm;
      const ids = identityReach(principalsOf(last.identity));
      for (const h of ids.data) if (!direct.has(lc(h.t.id)) && !gained.has(lc(h.t.id))) gained.set(lc(h.t.id), { chain: p.chain, r: { t: h.t, place: { how: `${last.name}'s ${h.via}` }, hit: { note: h.role }, identity: true } });
      if (!own.takeover.length && ids.takeover.length && (!takeover || p.chain.length < takeover.chain.length)) takeover = { chain: p.chain, x: ids.takeover[0], vm: last };
    }
    if (takeover) {
      findings.push({
        ...base(e, "path-pivot-takeover"),
        path: [...entryStep(e), ...hopSteps(takeover.chain), { t: "identity", label: takeover.x.via }, { t: "target", label: takeover.x.text }],
        detail: `${entryText(e)}. From it an attacker can sign in onward (${chainText(takeover.chain)}). ${takeover.vm.name}'s ${takeover.x.via} holds ${takeover.x.text}. Allow admin ports between subnets only from a Bastion or jump subnet, and narrow the identity's role`,
      });
    }
    if (gained.size) {
      const g = [...gained.values()].sort((a, b) => a.chain.length - b.chain.length);
      const first = g[0];
      const lastStep = first.r.identity ? { t: "identity", label: first.r.place.how, note: first.r.hit.note } : netStep(first.r.hit);
      findings.push({
        ...base(e, "path-pivot-data"),
        targets: g.map((x) => x.r.t.id),
        path: [...entryStep(e), ...hopSteps(first.chain), lastStep, targetStep(first.r, g.length - 1)],
        detail: `${entryText(e)}. It cannot reach this data itself, but the NSGs let it sign in to other machines that can: ${list(g.map((x) => `${reachText(x.r)} via ${chainText(x.chain)}`))}. Allow SSH, RDP and WinRM between subnets only from a Bastion or jump subnet`,
      });
    }
  }

  // 5: the subnet map of each VNet: which subnet can reach which, on admin ports or on data ports
  const entrySubnets = new Set();
  for (const e of entries.values()) for (const s of e.subnets) entrySubnets.add(s);
  const dataSubnets = new Set();
  for (const t of targets.values()) for (const p of t.places) dataSubnets.add(p.subnetId);
  for (const [vid, v] of net.vnets) {
    const subs = [...net.subnets.entries()].filter(([, s]) => s.vnetId === vid && !SPECIAL_SUBNETS.test(s.name) && s.prefixes.length).slice(0, MAX_MAP);
    if (subs.length < 2) continue;
    let pairs = 0;
    let admin = 0;
    let dataOnly = 0;
    const cells = subs.map(([aId]) => subs.map(([bId, b]) => {
      if (aId === bId) return null;
      pairs++;
      const place = { subnetId: bId, prefix: b.prefixes[0], pe: false };
      const a = lateral(net, aId, place, ADMIN_LIST);
      if (a) {
        admin++;
        return { v: "admin", n: `${portName(a.port)}: ${a.note || "allowed"}` };
      }
      const x = lateral(net, aId, place, DATA_LIST);
      if (x) {
        dataOnly++;
        return { v: "data", n: `port ${x.port}: ${x.note || "allowed"}` };
      }
      return { v: "", n: "blocked" };
    }));
    const flat = admin * 2 >= pairs;
    const bare = subs.filter(([, s]) => !s.nsgId).map(([, s]) => s.name);
    const crossing = subs.some(([aId], i) => entrySubnets.has(aId) && subs.some(([bId], j) => dataSubnets.has(bId) && cells[i][j] && cells[i][j].v));
    findings.push({
      kind: flat ? "seg-flat-vnet" : "seg-vnet-map",
      id: `${v.id}#segmentation`,
      name: v.name,
      resourceGroup: v.resourceGroup,
      subscriptionId: v.subscriptionId,
      entry: "VNet",
      matrix: {
        subnets: subs.map(([id, s]) => ({ name: s.name, prefix: s.prefixText, nsg: s.nsgId ? nameOf(s.nsgId) : "", internet: entrySubnets.has(id), data: dataSubnets.has(id) })),
        cells,
      },
      detail: `${admin} of ${pairs} subnet pairs can reach each other on admin ports (SSH, RDP, WinRM)${dataOnly ? `, ${dataOnly} more only on data ports` : ""}.${bare.length ? ` No NSG on ${list(bare)}.` : ""}${crossing ? " An internet-facing subnet can reach a subnet that holds sensitive data." : ""}${flat ? " One machine taken over can reach most of the network. Add NSGs that deny traffic from the rest of the VNet first, then allow only the flows each subnet needs (admin ports only from a Bastion or jump subnet)" : ""}`,
    });
  }
  return { findings, counts: { entries: entries.size, targets: targets.size, hosts: hosts.length } };
}

// Does a data role apply to this kind of target?
function roleFits(guid, what) {
  const role = DATA_ROLES[guid] || "";
  if (/^Key Vault/.test(role)) return what === "Key vault";
  if (/^Storage/.test(role)) return what === "Storage account";
  if (/^SQL/.test(role)) return /^SQL/.test(what);
  if (/^DocumentDB/.test(role)) return what === "Cosmos DB";
  return true;
}

/* ---------- Resource Graph ---------- */
async function gather() {
  const q = (kql, opts = {}) => resourceGraphQuery(kql, { toolId: TOOL_ID, ...opts });
  const types = Object.keys(SENSITIVE_TYPES).map((t) => `'${t}'`).join(", ");
  const [vnets, nsgs, routeTables, nics, pips, lbs, agws, vms, sites, privateEndpoints, resources, roleAssignments] = await Promise.all([
    q(`Resources | where type =~ 'microsoft.network/virtualnetworks'
      | project id, name, resourceGroup, subscriptionId, addressPrefixes = properties.addressSpace.addressPrefixes, subnets = properties.subnets, peerings = properties.virtualNetworkPeerings`),
    q(`Resources | where type =~ 'microsoft.network/networksecuritygroups' | project id, name, rules = properties.securityRules, defaults = properties.defaultSecurityRules`),
    q(`Resources | where type =~ 'microsoft.network/routetables' | project id, name, routes = properties.routes`),
    q(`Resources | where type =~ 'microsoft.network/networkinterfaces'
      | project id, name, vmId = tostring(properties.virtualMachine.id), nsgId = tostring(properties.networkSecurityGroup.id), ipcs = properties.ipConfigurations
      | extend ipcs = ipcs`),
    q(`Resources | where type =~ 'microsoft.network/publicipaddresses' | project id, name, ip = tostring(properties.ipAddress), sku = tostring(sku.name)`),
    q(`Resources | where type =~ 'microsoft.network/loadbalancers'
      | project id, name, frontends = properties.frontendIPConfigurations, rules = properties.loadBalancingRules, natRules = properties.inboundNatRules`),
    q(`Resources | where type =~ 'microsoft.network/applicationgateways'
      | project id, name, frontends = properties.frontendIPConfigurations, pools = properties.backendAddressPools, settings = properties.backendHttpSettingsCollection`),
    q(`Resources | where type =~ 'microsoft.compute/virtualmachines'
      | project id, name, resourceGroup, subscriptionId, identity, tags, os = tostring(properties.storageProfile.osDisk.osType)`),
    q(`Resources | where type =~ 'microsoft.web/sites'
      | project id, name, resourceGroup, subscriptionId, kind, identity, state = tostring(properties.state), defaultHostName = tostring(properties.defaultHostName),
          publicNetworkAccess = tostring(properties.publicNetworkAccess), vnetSubnet = tostring(properties.virtualNetworkSubnetId)`),
    q(`Resources | where type =~ 'microsoft.network/privateendpoints'
      | project id, name, subnetId = tostring(properties.subnet.id),
          target = tostring(coalesce(properties.privateLinkServiceConnections[0].properties.privateLinkServiceId, properties.manualPrivateLinkServiceConnections[0].properties.privateLinkServiceId))`),
    q(`Resources | where type in~ (${types}) or isnotempty(tags)
      | project id, name, type, resourceGroup, subscriptionId, tags, publicNetworkAccess = tostring(properties.publicNetworkAccess),
          vnetRules = properties.networkAcls.virtualNetworkRules, accessPolicies = properties.accessPolicies, rbac = tobool(properties.enableRbacAuthorization),
          delegatedSubnet = tostring(properties.network.delegatedSubnetResourceId), miSubnet = tostring(properties.subnetId)`),
    q(`AuthorizationResources | where type =~ 'microsoft.authorization/roleassignments' and tostring(properties.principalType) =~ 'ServicePrincipal'
      | project principalId = tostring(properties.principalId), roleDefinitionId = tostring(properties.roleDefinitionId), scope = tostring(properties.scope)`),
  ]);
  // Flatten NIC IP configurations and gateway ports here, so analyse() works on plain data.
  const flatNics = nics.map((n) => ({
    ...n,
    ipcs: arr(n.ipcs).map((c) => {
      const p = c.properties || {};
      return {
        id: c.id,
        subnetId: p.subnet && p.subnet.id,
        privateIp: p.privateIPAddress,
        pipId: p.publicIPAddress && p.publicIPAddress.id,
        lbPools: arr(p.loadBalancerBackendAddressPools).map((x) => x.id),
        agwPools: arr(p.applicationGatewayBackendAddressPools).map((x) => x.id),
      };
    }),
  }));
  const flatAgws = agws.map((g) => ({ ...g, ports: arr(g.settings).map((s) => s.properties && s.properties.port).filter(Boolean) }));
  // Resources with tags but not a sensitive type are only kept when a tag marks them sensitive.
  const names = sensitiveTags();
  const keep = resources.filter((r) => SENSITIVE_TYPES[lc(r.type)] || taggedSensitive(r.tags, names));
  return { vnets, nsgs, routeTables, nics: flatNics, pips, lbs, agws: flatAgws, vms, sites, privateEndpoints, resources: keep, roleAssignments };
}

async function run() {
  const d = await gather();
  const subNames = {};
  try {
    const rows = await resourceGraphQuery(`ResourceContainers | where type == 'microsoft.resources/subscriptions' | project subscriptionId, name`, { toolId: TOOL_ID, subscriptions: [] });
    for (const r of rows) subNames[r.subscriptionId] = r.name;
  } catch {
    /* names are a nicety */
  }
  return analyse(d, { tagNames: sensitiveTags(), subNames }).findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Exposure paths",
  schedule: "30 4 * * *", // daily at 04:30
  run,
  _test: { analyse, cidr, contains, internetPorts, nsgDecides, lateral, buildNetwork, portsText },
};
