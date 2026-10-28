// IP address management: every virtual network's address space and subnets
// with how full they are, plus findings for what goes wrong with addresses:
// overlapping ranges (peering or VPN impossible later), subnets running out of
// addresses, public address space used inside a VNet, ranges outside the
// organisation's plan and peerings that are broken or out of sync. Also the
// firewall IP groups: their entries, what uses them, when they last changed,
// and findings for empty, unused, failed, nearly full or untidy groups. Each
// run also saves the address inventory (ipam/inventory.json in the tenant's
// history storage) for the IPAM page and the IP groups view, with the
// addresses known to be taken in each subnet. IPv4
// only. Overlaps are found within one tenant. Reader is enough.
const settings = require("../settings");
const store = require("../findingsStore");
const tenants = require("../tenants");
const { resourceGraphQuery, armGet } = require("../armClient");
const { numberSetting, mapLimit, runChecks, itemErrors, scanError } = require("./util");
const ip = require("./ipv4");

const TOOL_ID = "ipam";
const CONCURRENCY = 8;
const MAX_VNETS = 2000;
const FULL_PCT = 95;
const MAX_NAMED = 5; // overlapping networks named in one finding
const INVENTORY_KEY = "ipam/inventory.json";
const USAGES_API = "api-version=2024-05-01";
const IPGROUP_LIMIT = 5000; // entries Azure allows in one IP group
const IPGROUP_WARN_PCT = 80;
const WIDE_SIZE = 2 ** 24; // an entry wider than a /8
const MAX_CHANGE_LIST = 100; // added or removed entries kept per group
const MAX_LISTED = 4096; // taken addresses kept per subnet
const MAX_FREE_RUNS = 500; // free runs sent for one subnet

// IPAM_POOLS: the ranges the organisation hands out, e.g. "10.0.0.0/8, 172.16.0.0/12".
function pools() {
  return String(settings.get("IPAM_POOLS") || "")
    .split(/[,\s]+/)
    .map(ip.parse)
    .filter(Boolean);
}

const prefixList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String).filter(Boolean);

async function readNetworks() {
  const [vnets, subnets, others] = await Promise.all([
    resourceGraphQuery(
      `Resources
      | where type =~ 'microsoft.network/virtualnetworks'
      | project id, name, subscriptionId, resourceGroup, location,
          prefixes = properties.addressSpace.addressPrefixes,
          peerings = properties.virtualNetworkPeerings`,
      { toolId: TOOL_ID }
    ),
    resourceGraphQuery(
      `Resources
      | where type =~ 'microsoft.network/virtualnetworks'
      | mv-expand s = properties.subnets
      | project vnetId = id, name = tostring(s.name), prefix = tostring(s.properties.addressPrefix),
          prefixes = s.properties.addressPrefixes, delegation = tostring(s.properties.delegations[0].properties.serviceName)`,
      { toolId: TOOL_ID }
    ),
    // On-premises sites (VPN local network gateways) and Virtual WAN hubs
    // also take address space a VNet must not reuse.
    resourceGraphQuery(
      `Resources
      | where type in~ ('microsoft.network/localnetworkgateways', 'microsoft.network/virtualhubs')
      | where not(type =~ 'microsoft.network/virtualhubs' and isempty(tostring(properties.virtualWan.id))) // Route Server
      | project id, name, subscriptionId, resourceGroup, location, type = tolower(type),
          prefixes = iff(type =~ 'microsoft.network/virtualhubs', pack_array(properties.addressPrefix), properties.localNetworkAddressSpace.addressPrefixes)`,
      { toolId: TOOL_ID }
    ),
  ]);
  const byVnet = new Map();
  for (const s of subnets) {
    if (!s.name) continue;
    const id = String(s.vnetId).toLowerCase();
    if (!byVnet.has(id)) byVnet.set(id, []);
    byVnet.get(id).push({ name: s.name, prefixes: prefixList(s.prefixes).length ? prefixList(s.prefixes) : prefixList(s.prefix), delegation: s.delegation || null });
  }
  return {
    vnets: vnets.map((v) => ({
      id: v.id,
      name: v.name,
      subscriptionId: v.subscriptionId,
      resourceGroup: v.resourceGroup,
      location: v.location,
      prefixes: prefixList(v.prefixes),
      peerings: (v.peerings || []).map((p) => ({
        name: p.name,
        remoteId: (p.properties && p.properties.remoteVirtualNetwork && p.properties.remoteVirtualNetwork.id) || null,
        state: (p.properties && p.properties.peeringState) || null,
        sync: (p.properties && p.properties.peeringSyncLevel) || null,
      })),
      subnets: byVnet.get(String(v.id).toLowerCase()) || [],
    })),
    sites: others.map((o) => ({
      id: o.id,
      name: o.name,
      kind: o.type === "microsoft.network/virtualhubs" ? "hub" : "on-premises",
      subscriptionId: o.subscriptionId,
      resourceGroup: o.resourceGroup,
      location: o.location,
      prefixes: prefixList(o.prefixes),
    })),
  };
}

// The private addresses Azure resources hold, by subnet id (lower case):
// [address, name, kind, static (1/0)]. Network interfaces (VMs, private
// endpoints, private link services) and the front ends of load balancers,
// application gateways and firewalls. Uniform scale-set NICs (AKS nodes among
// them) and services that take addresses without a NIC (App Service
// integration, SQL managed instance) are not in Resource Graph; the subnet's
// usage count from Azure still includes them.
async function readAddresses() {
  const [nics, fronts] = await Promise.all([
    resourceGraphQuery(
      `Resources
      | where type =~ 'microsoft.network/networkinterfaces'
      | extend vm = tostring(properties.virtualMachine.id), pe = tostring(properties.privateEndpoint.id), pls = tostring(properties.privateLinkService.id)
      | mv-expand c = properties.ipConfigurations
      | extend addr = tostring(c.properties.privateIPAddress), subnetId = tolower(tostring(c.properties.subnet.id)), alloc = tostring(c.properties.privateIPAllocationMethod)
      | where isnotempty(addr) and isnotempty(subnetId)
      | project addr, subnetId, alloc, nic = name, vm, pe, pls`,
      { toolId: TOOL_ID }
    ),
    resourceGraphQuery(
      `Resources
      | where type in~ ('microsoft.network/loadbalancers', 'microsoft.network/applicationgateways', 'microsoft.network/azurefirewalls')
      | extend cfgs = iff(type =~ 'microsoft.network/azurefirewalls', properties.ipConfigurations, properties.frontendIPConfigurations)
      | mv-expand c = cfgs
      | extend addr = tostring(c.properties.privateIPAddress), subnetId = tolower(tostring(c.properties.subnet.id)), alloc = tostring(c.properties.privateIPAllocationMethod)
      | where isnotempty(addr) and isnotempty(subnetId)
      | project addr, subnetId, alloc, owner = name, rtype = tolower(type)`,
      { toolId: TOOL_ID }
    ),
  ]);
  return addressRows(nics, fronts);
}

const FRONT_KINDS = { "microsoft.network/loadbalancers": "load balancer", "microsoft.network/applicationgateways": "application gateway", "microsoft.network/azurefirewalls": "firewall" };

// Resource Graph rows -> Map(subnet id -> rows). Pure, for the tests.
function addressRows(nics, fronts) {
  const last = (id) => String(id).split("/").pop();
  const out = new Map();
  const add = (subnetId, row) => {
    if (!out.has(subnetId)) out.set(subnetId, []);
    out.get(subnetId).push(row);
  };
  for (const n of nics) {
    const [name, kind] = n.vm ? [last(n.vm), "VM"] : n.pe ? [last(n.pe), "private endpoint"] : n.pls ? [last(n.pls), "private link service"] : [n.nic, "network interface"];
    add(n.subnetId, [n.addr, name, kind, /static/i.test(n.alloc) ? 1 : 0]);
  }
  for (const f of fronts) add(f.subnetId, [f.addr, f.owner, FRONT_KINDS[f.rtype] || f.rtype, /static/i.test(f.alloc) ? 1 : 0]);
  return out;
}

// Puts each subnet's taken addresses on it (s.ips, sorted) with the count (s.listed).
function addAddresses(vnets, bySubnet) {
  for (const v of vnets) {
    for (const s of v.subnets) {
      const seen = new Set();
      const rows = (bySubnet.get(`${String(v.id).toLowerCase()}/subnets/${s.name.toLowerCase()}`) || [])
        .map((r) => ({ r, n: ip.parse(r[0]) }))
        .filter((x) => x.n && x.n.bits === 32 && !seen.has(x.n.start) && seen.add(x.n.start))
        .sort((a, b) => a.n.start - b.n.start)
        .map((x) => x.r);
      s.listed = rows.length;
      s.ips = rows.slice(0, MAX_LISTED);
    }
  }
}

// Firewall IP groups with their entries and the firewalls and firewall
// policies that use them.
async function readIpGroups() {
  const rows = await resourceGraphQuery(
    `Resources
    | where type =~ 'microsoft.network/ipgroups'
    | project id, name, subscriptionId, resourceGroup, location, ips = properties.ipAddresses,
        firewalls = properties.firewalls, policies = properties.firewallPolicies, state = tostring(properties.provisioningState)`,
    { toolId: TOOL_ID }
  );
  const refs = (list) => (Array.isArray(list) ? list : []).map((x) => (x && x.id) || null).filter(Boolean);
  return rows.map((g) => ({
    id: g.id,
    name: g.name,
    subscriptionId: g.subscriptionId,
    resourceGroup: g.resourceGroup,
    location: g.location,
    state: g.state || null,
    entries: prefixList(g.ips).map((s) => s.trim()),
    firewalls: refs(g.firewalls),
    policies: refs(g.policies),
  }));
}

// When each group's entries last changed, by comparing with the inventory the
// last run saved: changedAt and the entries added and removed then. A group
// not seen before gets firstSeen.
function trackIpGroupChanges(groups, previous, now) {
  const before = new Map((previous || []).map((g) => [String(g.id).toLowerCase(), g]));
  const norm = (list) => new Set(list.map((e) => e.toLowerCase().replace(/\s+/g, "")));
  for (const g of groups) {
    const p = before.get(String(g.id).toLowerCase());
    if (!p) {
      g.firstSeen = now;
      continue;
    }
    g.firstSeen = p.firstSeen || null;
    const was = norm(p.entries || []);
    const is = norm(g.entries);
    const added = g.entries.filter((e) => !was.has(e.toLowerCase().replace(/\s+/g, "")));
    const removed = (p.entries || []).filter((e) => !is.has(e.toLowerCase().replace(/\s+/g, "")));
    if (added.length || removed.length) {
      g.changedAt = now;
      g.added = added.slice(0, MAX_CHANGE_LIST);
      g.removed = removed.slice(0, MAX_CHANGE_LIST);
      g.addedCount = added.length;
      g.removedCount = removed.length;
    } else if (p.changedAt) {
      for (const k of ["changedAt", "added", "removed", "addedCount", "removedCount"]) g[k] = p[k];
    }
  }
  return groups;
}

// Entries another entry of the same group already covers (or repeats):
// [{ entry, by }]. Sorted by start, widest first, so a covered entry always
// comes after the one covering it.
function coveredEntries(entries) {
  const parsed = entries.map(ip.parseEntry).filter(Boolean).sort((a, b) => a.start - b.start || b.end - a.end);
  const out = [];
  let widest = null;
  for (const e of parsed) {
    if (widest && e.end <= widest.end) out.push({ entry: e.text, by: widest.text });
    else widest = e;
  }
  return out;
}

const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

function ipGroupFindings(groups) {
  const out = [];
  const sameAs = new Map(); // merged address spans -> groups
  for (const g of groups) {
    const base = { id: g.id, name: g.name, ...where(g) };
    const users = g.firewalls.length + g.policies.length;
    if (g.state && g.state !== "Succeeded") {
      out.push({ ...base, id: `${g.id}#state`, kind: "ipgroup-failed", detail: `Provisioning state is ${g.state}: the last change did not finish, so firewalls using it may still have the old entries. Save the group again` });
    }
    if (!g.entries.length) {
      out.push({ ...base, id: `${g.id}#empty`, kind: "ipgroup-empty", detail: users ? `Has no entries but ${plural(users, "firewall or policy")} uses it: rules with it match nothing` : "Has no entries and nothing uses it. Delete it if it is not needed" });
      continue;
    }
    if (!users) {
      out.push({ ...base, id: `${g.id}#unused`, kind: "ipgroup-unused", detail: `${plural(g.entries.length, "entry")}, but no firewall or firewall policy uses it. Delete it, or keep it if a rule is coming` });
    }
    const pct = (g.entries.length / IPGROUP_LIMIT) * 100;
    if (pct >= IPGROUP_WARN_PCT) {
      out.push({ ...base, id: `${g.id}#limit`, kind: "ipgroup-near-limit", detail: `${plural(g.entries.length, "entry")} of the ${IPGROUP_LIMIT.toLocaleString("en-US")} Azure allows (${Math.round(pct)}%). Merge single addresses into ranges or split the group` });
    }
    const covered = coveredEntries(g.entries);
    if (covered.length) {
      const named = covered.slice(0, MAX_NAMED).map((c) => (c.entry.toLowerCase() === c.by.toLowerCase() ? `${c.entry} (twice)` : `${c.entry} (in ${c.by})`)).join(", ");
      out.push({ ...base, id: `${g.id}#covered`, kind: "ipgroup-redundant", count: covered.length, detail: `${plural(covered.length, "entry")} already covered by another entry: ${named}${covered.length > MAX_NAMED ? ` and ${covered.length - MAX_NAMED} more` : ""}. Removing ${covered.length === 1 ? "it" : "them"} changes nothing` });
    }
    const wide = g.entries.map(ip.parseEntry).filter((e) => e && e.size > WIDE_SIZE);
    if (wide.length) {
      out.push({ ...base, id: `${g.id}#wide`, kind: "ipgroup-wide", detail: `${wide.map((e) => e.text).join(", ")} is wider than a /8 (${wide[0].size.toLocaleString("en-US")} addresses); a rule using this group lets in far more than one site. Check it is meant` });
    }
    const parsed = g.entries.map(ip.parseEntry).filter(Boolean);
    if (parsed.length) {
      const key = ip.merge(parsed).map((s) => s.join("-")).join(",");
      if (!sameAs.has(key)) sameAs.set(key, []);
      sameAs.get(key).push(g);
    }
  }
  for (const same of sameAs.values()) {
    if (same.length < 2) continue;
    for (const g of same) {
      const others = same.filter((o) => o !== g);
      out.push({
        id: `${g.id}#duplicate`,
        name: g.name,
        ...where(g),
        kind: "ipgroup-duplicate",
        detail: `Holds the same addresses as ${others.slice(0, MAX_NAMED).map((o) => `${o.name} (rg ${o.resourceGroup})`).join(", ")}${others.length > MAX_NAMED ? ` and ${others.length - MAX_NAMED} more` : ""}. Two copies drift apart when only one is updated; use one group`,
      });
    }
  }
  return out;
}

// Used and usable addresses per subnet (Azure keeps 5 in each), one call per VNet.
async function addUsage(vnets) {
  const checked = vnets.slice(0, MAX_VNETS);
  const failures = await mapLimit(checked, CONCURRENCY, async (v) => {
    let url = `https://management.azure.com${v.id}/usages?${USAGES_API}`;
    const byName = new Map(v.subnets.map((s) => [s.name.toLowerCase(), s]));
    while (url) {
      const page = await armGet(url, TOOL_ID);
      for (const u of page.value || []) {
        const s = byName.get(String(u.id || "").split("/").pop().toLowerCase());
        if (!s) continue;
        s.used = Number(u.currentValue) || 0;
        s.usable = Number(u.limit) || 0;
      }
      url = page.nextLink || null;
    }
  });
  const errors = itemErrors(TOOL_ID, "usages", "VNets' subnet usage", failures.map((f) => ({ ...f, item: { subscriptionId: f.item.subscriptionId } })), checked.length);
  if (vnets.length > MAX_VNETS) errors.push(scanError(TOOL_ID, "vnets-cap", `Subnet usage read for ${MAX_VNETS} of ${vnets.length} VNets`, "The rest show no usage"));
  return errors;
}

// Address-space totals per VNet and the room left for new subnets.
function summarize(v) {
  const spaces = v.prefixes.map(ip.parse).filter(Boolean);
  const subnetRanges = v.subnets.flatMap((s) => s.prefixes.map(ip.parse).filter(Boolean));
  v.addresses = spaces.reduce((n, r) => n + r.size, 0);
  v.unallocated = spaces.reduce((n, r) => n + ip.freeAddresses(r, subnetRanges), 0);
  v.largestFree = spaces.flatMap((r) => ip.freeBlocks(r, subnetRanges)).reduce((best, b) => (!best || b.size > best.size ? b : best), null);
  v.largestFree = v.largestFree ? v.largestFree.cidr : null;
  const counted = v.subnets.filter((s) => s.usable > 0);
  v.used = counted.reduce((n, s) => n + s.used, 0);
  v.usable = counted.reduce((n, s) => n + s.usable, 0);
  return v;
}

const where = (x) => ({ subscriptionId: x.subscriptionId, resourceGroup: x.resourceGroup });

function subnetFindings(vnets, warnPct) {
  const out = [];
  for (const v of vnets) {
    for (const s of v.subnets) {
      if (!(s.usable > 0)) continue;
      const pct = (s.used / s.usable) * 100;
      if (pct < warnPct) continue;
      const free = s.usable - s.used;
      out.push({
        kind: pct >= FULL_PCT ? "subnet-full" : "subnet-near-full",
        id: `${v.id}/subnets/${s.name}#usage`,
        name: `${v.name} / ${s.name}`,
        ...where(v),
        usedPct: Math.round(pct),
        detail: `${s.prefixes.join(", ")}: ${s.used.toLocaleString("en-US")} of ${s.usable.toLocaleString("en-US")} usable addresses in use (${Math.round(pct)}%), ${free.toLocaleString("en-US")} left. New VMs, scale-out or private endpoints here will fail when it is full`,
      });
    }
  }
  return out;
}

// One finding per network that overlaps another (VNet, hub or on-premises
// site), naming the others. Overlapping VNets can never be peered or joined
// to the same hub; an overlap with a VPN site sends traffic the wrong way.
function overlapFindings(vnets, sites) {
  const nets = [
    ...vnets.map((v) => ({ ...v, kind: "vnet" })),
    ...sites,
  ].map((n) => ({ n, ranges: n.prefixes.map(ip.parse).filter(Boolean) }));
  const hits = new Map(); // vnet id -> [{ other, mine, theirs }]
  for (let i = 0; i < nets.length; i++) {
    for (let j = i + 1; j < nets.length; j++) {
      const a = nets[i], b = nets[j];
      if (a.n.kind !== "vnet" && b.n.kind !== "vnet") continue;
      const pairs = [];
      for (const ra of a.ranges) for (const rb of b.ranges) if (ip.overlaps(ra, rb)) pairs.push([ra.cidr, rb.cidr]);
      if (!pairs.length) continue;
      for (const [me, other, flip] of [[a, b, false], [b, a, true]]) {
        if (me.n.kind !== "vnet") continue;
        if (!hits.has(me.n.id)) hits.set(me.n.id, { vnet: me.n, others: [] });
        hits.get(me.n.id).others.push({ net: other.n, pairs: pairs.map(([x, y]) => (flip ? [y, x] : [x, y])) });
      }
    }
  }
  const out = [];
  for (const { vnet, others } of hits.values()) {
    const onPrem = others.filter((o) => o.net.kind === "on-premises");
    const label = (o) => `${o.net.name}${o.net.kind === "vnet" ? "" : o.net.kind === "hub" ? " (WAN hub)" : " (on-premises)"} ${o.pairs[0][1]}`;
    const named = others.slice(0, MAX_NAMED).map(label).join(", ");
    out.push({
      kind: onPrem.length ? "ip-overlap-onprem" : "ip-overlap",
      id: `${vnet.id}#overlap`,
      name: vnet.name,
      ...where(vnet),
      overlaps: others.length,
      detail:
        `${[...new Set(others.flatMap((o) => o.pairs.map((p) => p[0])))].join(", ")} overlaps ${others.length} other network${others.length === 1 ? "" : "s"}: ${named}` +
        `${others.length > MAX_NAMED ? ` and ${others.length - MAX_NAMED} more` : ""}. ` +
        (onPrem.length ? "Traffic to the overlapping on-premises addresses cannot be routed" : "They can never be peered or connected to the same hub"),
    });
  }
  return out;
}

function spaceFindings(vnets, plan) {
  const out = [];
  for (const v of vnets) {
    const ranges = v.prefixes.map(ip.parse).filter(Boolean);
    const publicRanges = ranges.filter((r) => !ip.isPrivate(r));
    if (publicRanges.length) {
      out.push({
        kind: "ip-public-space",
        id: `${v.id}#public-space`,
        name: v.name,
        ...where(v),
        detail: `${publicRanges.map((r) => r.cidr).join(", ")} is public address space: the internet sites that own it cannot be reached from this VNet. Use 10.0.0.0/8, 172.16.0.0/12 or 192.168.0.0/16`,
      });
    }
    const outside = plan.length ? ranges.filter((r) => !plan.some((p) => ip.contains(p, r))) : [];
    if (outside.length) {
      out.push({
        kind: "ip-outside-plan",
        id: `${v.id}#outside-plan`,
        name: v.name,
        ...where(v),
        detail: `${outside.map((r) => r.cidr).join(", ")} is outside the address plan (${plan.map((p) => p.cidr).join(", ")})`,
      });
    }
    if (ranges.length && v.unallocated < 16) {
      out.push({
        kind: "vnet-no-room",
        id: `${v.id}#no-room`,
        name: v.name,
        ...where(v),
        detail: `${v.prefixes.join(", ")} is fully used by subnets; a new subnet needs more address space added to the VNet first`,
      });
    }
  }
  return out;
}

function peeringFindings(vnets) {
  const out = [];
  for (const v of vnets) {
    for (const p of v.peerings) {
      const remote = String(p.remoteId || "").split("/").pop() || "remote VNet";
      if (p.state && p.state !== "Connected" && p.state !== "Initiated") {
        out.push({
          kind: "peering-disconnected",
          id: `${v.id}/virtualNetworkPeerings/${p.name}#state`,
          name: `${v.name} → ${remote}`,
          ...where(v),
          detail: `Peering ${p.name} is ${p.state}: the other side was removed, so no traffic flows. Delete it and peer again`,
        });
      } else if (p.state === "Connected" && p.sync && p.sync !== "FullyInSync") {
        out.push({
          kind: "peering-not-synced",
          id: `${v.id}/virtualNetworkPeerings/${p.name}#sync`,
          name: `${v.name} → ${remote}`,
          ...where(v),
          detail: `Peering ${p.name} is ${p.sync}: an address space changed and the peering was not synced, so the new addresses cannot be reached. Sync the peering`,
        });
      }
    }
  }
  return out;
}

async function run() {
  const warnPct = numberSetting("IPAM_SUBNET_WARN_PCT", 80, { min: 1, max: 100 });
  const plan = pools();
  const [{ vnets, sites }, ipGroups, previous] = await Promise.all([
    readNetworks(),
    readIpGroups(),
    store.getDoc(INVENTORY_KEY).catch(() => null), // only for when IP groups last changed
  ]);
  const now = new Date().toISOString();
  trackIpGroupChanges(ipGroups, previous && previous.ipGroups, now);
  const usageErrors = await addUsage(vnets);
  try {
    addAddresses(vnets, await readAddresses());
  } catch (err) {
    usageErrors.push(scanError(TOOL_ID, "addresses", "Taken addresses could not be read", `The IPAM page shows counts only: ${String(err.message).slice(0, 300)}`));
  }
  vnets.forEach(summarize);
  const findings = await runChecks(TOOL_ID, {
    Subnets: async () => subnetFindings(vnets, warnPct),
    Overlaps: async () => overlapFindings(vnets, sites),
    "Address space": async () => spaceFindings(vnets, plan),
    Peerings: async () => peeringFindings(vnets),
    "IP groups": async () => ipGroupFindings(ipGroups),
  });
  await store.putDoc(INVENTORY_KEY, { updatedAt: now, vnets, sites, ipGroups });
  return [...findings, ...usageErrors];
}

// --- Inventory reads (the IPAM page) ---

async function inventory(keys) {
  const out = { updatedAt: null, vnets: [], sites: [], ipGroups: [], failures: [] };
  for (const k of keys) {
    let doc;
    try {
      doc = await store.getDoc(INVENTORY_KEY, k);
    } catch (err) {
      out.failures.push({ tenant: k, error: `could not read the address inventory: ${err.message}` });
      continue;
    }
    if (!doc) continue;
    if (doc.updatedAt && (!out.updatedAt || doc.updatedAt > out.updatedAt)) out.updatedAt = doc.updatedAt;
    const tag = (x) => ({ ...x, ...(k !== tenants.HOME && { tenant: k }) });
    out.vnets.push(...(doc.vnets || []).map(tag));
    out.sites.push(...(doc.sites || []).map(tag));
    out.ipGroups.push(...(doc.ipGroups || []).map(tag));
  }
  return out;
}

// Free /size blocks in a range. With a VNet: room for a new subnet in one of
// its address spaces. Without: room for a new network anywhere in the pool,
// avoiding every VNet, hub and on-premises range seen.
function findFree(inv, { pool, size, vnetId }) {
  const range = ip.parse(pool);
  if (!range || !/\//.test(String(pool))) return { error: "pool must be an IPv4 range like 10.0.0.0/8" };
  const bits = Number(size);
  if (!Number.isInteger(bits) || bits < range.bits || bits > 29) return { error: `size must be /${range.bits} to /29` };
  let used;
  if (vnetId) {
    const v = inv.vnets.find((x) => String(x.id).toLowerCase() === String(vnetId).toLowerCase());
    if (!v) return { error: "no such VNet in the inventory" };
    if (!v.prefixes.map(ip.parse).some((r) => r && ip.contains(r, range))) return { error: "that range is not in the VNet's address space" };
    used = v.subnets.flatMap((s) => s.prefixes.map((p) => ({ r: ip.parse(p), owner: s.name })));
  } else {
    used = [...inv.vnets, ...inv.sites].flatMap((n) => n.prefixes.map((p) => ({ r: ip.parse(p), owner: n.name, tenantName: n.tenantName })));
  }
  used = used.filter((u) => u.r && ip.overlaps(u.r, range));
  const free = ip.freeOfSize(range, used.map((u) => u.r), bits);
  return {
    pool: range.cidr,
    size: bits,
    free: free.list,
    count: free.count,
    freeAddresses: ip.freeAddresses(range, used.map((u) => u.r)),
    addresses: range.size,
    taken: used.slice(0, 200).map((u) => ({ cidr: u.r.cidr, owner: u.owner, ...(u.tenantName && { tenantName: u.tenantName }) })).sort((a, b) => ip.parse(a.cidr).start - ip.parse(b.cidr).start),
  };
}

// One subnet's addresses: the ones known to be taken and the free runs in
// between, leaving out the five Azure keeps (the first four and the last).
// Pure, for the tests.
function subnetAddresses(v, s) {
  const taken = (s.ips || []).map((r) => ip.parse(r[0]).start);
  const ranges = s.prefixes.map(ip.parse).filter(Boolean);
  const free = [];
  let freeCount = 0;
  for (const r of ranges) {
    const first = r.size >= 8 ? r.start + 4 : r.start;
    const end = r.size >= 8 ? r.end - 1 : r.end;
    let at = first;
    for (const n of taken) {
      if (n < at || n > end) continue;
      if (n > at) free.push({ from: at, to: n - 1 });
      at = n + 1;
    }
    if (at <= end) free.push({ from: at, to: end });
  }
  for (const f of free) freeCount += f.to - f.from + 1;
  return {
    vnet: { id: v.id, name: v.name, subscriptionId: v.subscriptionId, subscriptionName: v.subscriptionName, resourceGroup: v.resourceGroup, tenant: v.tenant, tenantName: v.tenantName, prefixes: v.prefixes },
    subnet: { name: s.name, prefixes: s.prefixes, delegation: s.delegation, used: s.used, usable: s.usable, listed: s.listed || 0, listKnown: Array.isArray(s.ips) },
    ranges: ranges.map((r) => ({ cidr: r.cidr, start: ip.toIp(r.start), size: r.size })),
    taken: (s.ips || []).map(([addr, name, kind, fixed]) => ({ ip: addr, name, kind, static: !!fixed })),
    // Azure counts more in use than are listed: something Resource Graph does not show (AKS nodes, App Service) holds the rest.
    unlisted: Math.max(0, (s.used || 0) - (s.listed || 0)),
    freeCount,
    free: free.slice(0, MAX_FREE_RUNS).map((f) => ({ from: ip.toIp(f.from), to: ip.toIp(f.to), count: f.to - f.from + 1 })),
    freeRuns: free.length,
  };
}

function registerRoutes(app, { readKeys, decorate }) {
  app.get("/api/ipam", async (req, res) => {
    try {
      const inv = await inventory(readKeys(req));
      await decorate(TOOL_ID, [...inv.vnets, ...inv.sites, ...inv.ipGroups]);
      // Each subnet's address list comes from /api/ipam/subnet; here the room left for new subnets.
      for (const v of inv.vnets) {
        const subnetRanges = v.subnets.flatMap((s) => s.prefixes.map(ip.parse).filter(Boolean));
        v.freeBlocks = v.prefixes.map(ip.parse).filter(Boolean).flatMap((r) => ip.freeBlocks(r, subnetRanges)).slice(0, 50).map((b) => b.cidr);
        v.subnets = v.subnets.map(({ ips, ...s }) => ({ ...s, listKnown: Array.isArray(ips), nextFree: Array.isArray(ips) ? subnetAddresses(v, { ...s, ips }).free.slice(0, 3) : [] }));
      }
      res.json({ ...inv, pools: pools().map((p) => p.cidr) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/api/ipam/subnet", async (req, res) => {
    const q = (k) => (typeof req.query[k] === "string" ? req.query[k] : "");
    try {
      const inv = await inventory(readKeys(req));
      const v = inv.vnets.find((x) => String(x.id).toLowerCase() === q("vnet").toLowerCase());
      const s = v && v.subnets.find((x) => x.name.toLowerCase() === q("subnet").toLowerCase());
      if (!s) return res.status(404).json({ error: "no such subnet in the address inventory" });
      await decorate(TOOL_ID, [v]);
      res.json(subnetAddresses(v, s));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  app.get("/api/ipam/free", async (req, res) => {
    const q = (k) => (typeof req.query[k] === "string" ? req.query[k] : "");
    try {
      const result = findFree(await inventory(readKeys(req)), { pool: q("pool"), size: q("size"), vnetId: q("vnet") });
      res.status(result.error ? 400 : 200).json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  id: TOOL_ID,
  label: "IP addresses",
  schedule: "20 4 * * *", // daily at 04:20
  run,
  registerRoutes,
  _test: { summarize, subnetFindings, overlapFindings, spaceFindings, peeringFindings, findFree, subnetAddresses, addAddresses, addressRows, trackIpGroupChanges, coveredEntries, ipGroupFindings },
};
