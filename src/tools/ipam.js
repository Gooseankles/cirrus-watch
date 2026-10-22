// IP address management: every virtual network's address space and subnets
// with how full they are, plus findings for what goes wrong with addresses:
// overlapping ranges (peering or VPN impossible later), subnets running out of
// addresses, public address space used inside a VNet, ranges outside the
// organisation's plan and peerings that are broken or out of sync. Each run
// also saves the address inventory (ipam/inventory.json in the tenant's
// history storage) for the Networks and Free ranges views. IPv4 only.
// Overlaps are found within one tenant. Reader is enough.
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
  const { vnets, sites } = await readNetworks();
  const usageErrors = await addUsage(vnets);
  vnets.forEach(summarize);
  const findings = await runChecks(TOOL_ID, {
    Subnets: async () => subnetFindings(vnets, warnPct),
    Overlaps: async () => overlapFindings(vnets, sites),
    "Address space": async () => spaceFindings(vnets, plan),
    Peerings: async () => peeringFindings(vnets),
  });
  await store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), vnets, sites });
  return [...findings, ...usageErrors];
}

// --- Inventory reads (the IPAM page) ---

async function inventory(keys) {
  const out = { updatedAt: null, vnets: [], sites: [], failures: [] };
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

function registerRoutes(app, { readKeys, decorate }) {
  app.get("/api/ipam", async (req, res) => {
    try {
      const inv = await inventory(readKeys(req));
      await decorate(TOOL_ID, [...inv.vnets, ...inv.sites]);
      res.json({ ...inv, pools: pools().map((p) => p.cidr) });
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
  _test: { summarize, subnetFindings, overlapFindings, spaceFindings, peeringFindings, findFree },
};
