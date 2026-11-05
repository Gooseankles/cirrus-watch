// Firewall openings for the Architecture drawing: which on-premises addresses
// and which Internet names or addresses the Azure Firewall rules let traffic
// reach or come from. Each becomes a tile, and the drawing follows the traffic
// hop by hop: the VM (or subnet, or VNet) the rule names, the firewall, the VPN
// or ExpressRoute gateway, the site (the circuit or local network gateway) and
// the on-premises address; or the VM, the firewall and the Internet name or
// address. Works on what the scans save: architecture/network.json (VNet and
// subnet prefixes, NIC addresses, firewalls), firewall/inventory.json (policies,
// IP groups) and architecture/inventory.json (resources with their addresses,
// sites, connections, gateways, public IPs). Plain functions; no Azure calls.
//
// What counts as an opening: a rule in an Allow collection (network or
// application) or a DNAT rule. Its destinations are sorted into Azure (inside a
// VNet the scan read: not drawn as a tile), on-premises (a private range outside
// every VNet: a tile under the site whose address space holds it) and Internet (a
// public address, a name, a service tag, an FQDN tag or a web category: a tile in
// the Internet box). The rule's Azure side (its sources; its destinations for a
// rule from on-premises; the translated address of a DNAT rule) becomes the
// places the lines start or end at ("from"). A named on-premises source makes a
// line the other way, into Azure; a source range that also covers a VNet (such as
// 10.0.0.0/8) does not. "*" (or 0.0.0.0/0) as a destination reaches everything:
// one "Any address" tile under every site the firewall can reach and one in the
// Internet box, marked. "*" as a source is not drawn (it is nearly every rule):
// the line then starts at the firewall. Deny rules are left out: the Firewall
// policies scan reports what they shadow.
"use strict";
const ip = require("./ipv4");

const lc = (s) => String(s || "").toLowerCase();
const arr = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const one = (text) => ip.parseEntry(text);
const isAny = (s) => s === "*" || s === "0.0.0.0/0" || /^any$/i.test(s);
const vnetOf = (subnetId) => lc(subnetId).split("/").slice(0, 9).join("/");

const MAX_TARGETS = 2000; // tiles handed to the drawing (the browser caps each box further)
const MAX_RULES = 12; // rules listed per tile
const MAX_ADDRESSES = 50; // addresses listed for an IP group tile
const MAX_PORTS = 6; // port summaries per tile
const MAX_FROM = 24; // Azure-side places (resources, subnets, VNets) a tile's lines start or end at
const MAX_FROM_VNETS = 4; // a range over more VNets than this starts the line at the firewall instead

const GATEWAY = "microsoft.network/virtualnetworkgateways";
const ANY_LABEL = "Any address (*)";

/* ---------- rule text ---------- */

function portText(r) {
  if (r.type === "Application") {
    const p = arr(r.protocols).map((x) => String(x).replace(/^(\w+):(\d+)$/, (m, a, b) => `${a.toLowerCase()} ${b}`));
    return p.join(", ") || "web";
  }
  const protos = arr(r.protocols).map(String);
  const ports = arr(r.ports).map(String);
  const proto = protos.length && !protos.some((p) => /^any$/i.test(p)) ? protos.map((p) => p.toUpperCase()).join("/") : "any protocol";
  const port = ports.length && !ports.some(isAny) ? ports.join(", ") : "all ports";
  const text = `${proto} ${port}`;
  return r.type === "Nat" && r.translated ? `${text} → ${r.translated}` : text;
}

const groupName = (id) => `group ${String(id).split("/").pop()}`;

function ruleRow(r, policy, g, c, firewall) {
  return {
    name: r.name,
    policy: policy.name,
    group: g.name,
    collection: c.name,
    type: r.type,
    action: c.action,
    ports: portText(r),
    src: [...arr(r.src), ...arr(r.srcGroups).map(groupName)].join(", ") || "-",
    dst: [...arr(r.dst), ...arr(r.dstGroups).map(groupName), ...arr(r.fqdns), ...arr(r.targets), ...arr(r.urls), ...arr(r.tags), ...arr(r.categories)].join(", ") || "-",
    firewall,
  };
}

/* ---------- the environment: VNets, sites, gateways ---------- */

// network.json as saved (arrays) or as trafficFlow.index() returns it (Maps with parsed ranges).
const vnetList = (net) => (net.vnets instanceof Map ? [...net.vnets.values()] : arr(net.vnets));

function environment({ net, fw, inv }) {
  const vnets = vnetList(net).map((v) => ({ id: lc(v.id), ranges: v.ranges || arr(v.prefixes).map(one).filter(Boolean), peers: new Set([...(v.peers || [])].map(lc)) }));
  const vnetRanges = vnets.flatMap((v) => v.ranges);
  const peers = new Map(vnets.map((v) => [v.id, v.peers]));
  const resources = arr(inv.resources);
  const subnets = (net.subnets instanceof Map ? [...net.subnets.values()] : arr(net.subnets)).map((s) => ({ id: lc(s.id), vnet: lc(s.vnet), ranges: s.ranges || arr(s.prefixes).map(one).filter(Boolean) }));
  // Resources with a private address: where a rule's Azure side starts (or, for DNAT, ends). NICs and public
  // addresses hand theirs to what they belong to, so they are left out; a NIC the inventory did not fold in fills a gap.
  const NIC = "microsoft.network/networkinterfaces", PIP = "microsoft.network/publicipaddresses";
  const withIp = new Map();
  for (const r of resources) {
    const a = r.ip && r.subnet && r.type !== NIC && r.type !== PIP ? one(r.ip) : null;
    if (a) withIp.set(lc(r.id), { id: lc(r.id), name: r.name, subnet: lc(r.subnet), ip: a });
  }
  for (const n of net.nics instanceof Map ? [...net.nics.values()] : arr(net.nics)) {
    const id = lc(n.owner), a = n.ip && n.subnet ? one(n.ip) : null;
    if (a && id && !withIp.has(id)) withIp.set(id, { id, name: id.split("/").pop(), subnet: lc(n.subnet), ip: a });
  }
  const sites = arr(inv.sites).map((s) => ({ ...s, id: lc(s.id), ranges: arr(s.prefixes).map(one).filter(Boolean) }));
  const siteById = new Map(sites.map((s) => [s.id, s]));
  const gwOfSite = new Map(), sitesOfGw = new Map();
  for (const c of arr(inv.connections)) {
    const gw = lc(c.gateway), site = lc(c.site);
    if (!gw || !site || !siteById.has(site)) continue;
    if (!gwOfSite.has(site)) gwOfSite.set(site, new Set());
    gwOfSite.get(site).add(gw);
    if (!sitesOfGw.has(gw)) sitesOfGw.set(gw, new Set());
    sitesOfGw.get(gw).add(site);
  }
  const gateways = resources.filter((r) => r.type === GATEWAY).map((r) => ({ id: lc(r.id), name: r.name, vnet: r.subnet ? vnetOf(r.subnet) : "" }));
  const connected = gateways.filter((g) => sitesOfGw.has(g.id));
  // Who owns a public address in Azure (the firewall's own, an application gateway's...).
  const pubOwner = new Map();
  for (const r of resources) for (const a of arr(r.publicIps)) pubOwner.set(String(a), r.name);
  const ipGroups = {};
  for (const [id, g] of Object.entries((fw && fw.ipGroups) || {})) ipGroups[lc(id)] = g;
  return { vnets, vnetRanges, subnets, withIp: [...withIp.values()], peers, sites, siteById, gwOfSite, sitesOfGw, gateways, connected, pubOwner, ipGroups };
}

// The Azure side of a rule (its sources for an outbound opening, its destinations for an inbound one, the
// translated address of a DNAT rule) as the places on the drawing the line starts or ends at: a resource whose
// address the entry names, else the subnet it covers, else the VNet. "*" is every source and starts the line at the
// firewall (any: true); a range over more than MAX_FROM_VNETS VNets does the same (wide: true).
function azureSide(env, list, groups) {
  const spots = new Map();
  let any = false, wide = false;
  const entries = [...arr(list), ...arr(groups).flatMap((id) => (env.ipGroups[lc(id)] ? arr(env.ipGroups[lc(id)].ips) : []))];
  for (const e of entries) {
    const s = String(e || "").trim();
    if (!s) continue;
    if (isAny(s)) {
      any = true;
      continue;
    }
    const r = one(s);
    if (!r) continue; // a tag or a name is not a place in Azure
    const vnets = env.vnets.filter((v) => v.ranges.some((x) => ip.overlaps(x, r)));
    if (!vnets.length) continue;
    if (vnets.length > MAX_FROM_VNETS) {
      wide = true;
      continue;
    }
    for (const v of vnets) {
      if (v.ranges.some((x) => ip.contains(r, x))) {
        spots.set(v.id, { id: v.id, kind: "vnet" });
        continue;
      }
      const subs = env.subnets.filter((sn) => sn.vnet === v.id && sn.ranges.some((x) => ip.overlaps(x, r)));
      if (!subs.length) {
        spots.set(v.id, { id: v.id, kind: "vnet" });
        continue;
      }
      for (const sn of subs) {
        if (sn.ranges.some((x) => ip.contains(r, x))) {
          spots.set(sn.id, { id: sn.id, kind: "subnet" });
          continue;
        }
        const hits = env.withIp.filter((x) => x.subnet === sn.id && ip.contains(r, x.ip));
        if (hits.length) for (const h of hits) spots.set(h.id, { id: h.id, kind: "resource", name: h.name });
        else spots.set(sn.id, { id: sn.id, kind: "subnet" });
      }
    }
  }
  return { any, wide, spots: [...spots.values()] };
}

// The gateways a firewall's traffic can leave through: those in its VNet, else in a VNet peered with it, else
// every gateway with an on-premises connection.
function reachableGateways(env, firewall) {
  const vnet = firewall.subnet ? vnetOf(firewall.subnet) : "";
  const local = env.connected.filter((g) => g.vnet && g.vnet === vnet);
  if (local.length) return local;
  const near = env.peers.get(vnet) || new Set();
  const peered = env.connected.filter((g) => g.vnet && near.has(g.vnet));
  return peered.length ? peered : env.connected;
}

/* ---------- sorting one address entry ---------- */

// One text entry of a source or destination list: { kind: "any" | "azure" | "onprem" | "internet" | "tag" | "ipv6", ... }.
function classify(env, text) {
  const s = String(text || "").trim();
  if (!s) return null;
  if (isAny(s)) return { kind: "any" };
  if (/^internet$/i.test(s)) return { kind: "tag", label: "Internet", sub: "service tag: any public address" };
  if (s.includes(":")) return { kind: "ipv6", label: s };
  const r = one(s);
  if (!r) return { kind: "tag", label: s, sub: "service tag" };
  if (env.vnetRanges.some((v) => ip.contains(v, r))) return { kind: "azure" };
  if (ip.isPrivate(r)) return { kind: "onprem", label: s, range: r, wide: env.vnetRanges.some((v) => ip.overlaps(v, r)) };
  const owner = env.pubOwner.get(s);
  return { kind: "internet", label: s, range: r, ...(owner && { owner }) };
}

/* ---------- the targets ---------- */

function compute({ net, fw, inv }, opts = {}) {
  net = net || {};
  fw = fw || {};
  inv = inv || {};
  const env = environment({ net, fw, inv });
  const maxTargets = opts.maxTargets || MAX_TARGETS;
  const targets = new Map();
  const notes = [];
  const firewalls = [];
  let rulesSeen = 0;

  // One tile; the same key from several rules (or firewalls) merges into it. curFrom is the Azure side of the rule
  // being read (see azureSide): the tile collects the places its lines start or end at.
  let curFw = null, curFrom = null;
  const add = (key, make, rule, dir) => {
    let t = targets.get(key);
    if (!t) {
      if (targets.size >= maxTargets) return null;
      t = { key, ...make(), firewall: curFw, firewalls: [], dir, ports: [], rules: [], ruleCount: 0, from: [], fromCount: 0, fromAny: false };
      targets.set(key, t);
    }
    if (!t.firewalls.includes(curFw)) t.firewalls.push(curFw);
    if (t.dir !== dir) t.dir = "both";
    if (curFrom) {
      if (curFrom.any || curFrom.wide) t.fromAny = true;
      for (const f of curFrom.spots) {
        if (t.from.some((x) => x.id === f.id)) continue;
        t.fromCount++;
        if (t.from.length < MAX_FROM) t.from.push(f);
      }
    }
    if (!t.ports.includes(rule.ports) && t.ports.length < MAX_PORTS) t.ports.push(rule.ports);
    t.ruleCount++;
    if (t.rules.length < MAX_RULES) t.rules.push(rule);
    return t;
  };

  const firewallList = net.firewalls instanceof Map ? [...net.firewalls.values()] : arr(net.firewalls);
  for (const firewall of firewallList) {
    const policy = arr(fw.policies).find((p) => p.id === firewall.policy || arr(p.firewalls).includes(firewall.name));
    if (!policy) continue;
    const fwId = lc(firewall.id);
    curFw = fwId;
    firewalls.push({ id: fwId, name: firewall.name, policy: policy.name });
    const gws = reachableGateways(env, firewall);
    const gwIds = new Set(gws.map((g) => g.id));
    // The gateways that carry a site's traffic from this firewall (those it can reach, else all of the site's).
    const siteGws = (siteId) => {
      const all = [...(env.gwOfSite.get(siteId) || [])];
      const near = all.filter((id) => gwIds.has(id));
      return near.length ? near : all;
    };
    const reachedSites = env.sites.filter((s) => env.gwOfSite.has(s.id) && (!gws.length || [...env.gwOfSite.get(s.id)].some((id) => gwIds.has(id))));
    // Where a private range that no site's address space holds goes: the one gateway there is, else nowhere.
    const unknownSpot = () => {
      const cands = gws.length ? gws : env.gateways;
      if (cands.length !== 1) return { site: null, gateway: null };
      const sites = [...(env.sitesOfGw.get(cands[0].id) || [])];
      return { site: sites.length === 1 ? sites[0] : null, gateway: cands[0].id, guess: sites.length === 1 };
    };
    // The (site, gateway) spots for one on-premises range.
    const onpremSpots = (c) => {
      const hits = c.range ? env.sites.filter((s) => env.gwOfSite.has(s.id) && s.ranges.some((x) => ip.overlaps(x, c.range))) : [];
      return hits.length ? hits.flatMap((s) => siteGws(s.id).map((gateway) => ({ site: s.id, gateway }))) : [unknownSpot()];
    };
    const opKey = (spot, label) => `op|${spot.site || "?"}|${spot.gateway || "?"}|${label}`;
    const opTile = (spot, label, kind, fields) => ({ side: "onprem", kind, label, site: spot.site, gateway: spot.gateway, ...(spot.guess && { siteGuess: true }), ...fields });
    const inKey = (label) => `in|${fwId}|${label}`;
    const inTile = (label, kind, fields) => ({ side: "internet", kind, label, ...fields });

    const onprem = (c, rule, dir) => {
      for (const spot of onpremSpots(c)) add(opKey(spot, c.label), () => opTile(spot, c.label, "ip", c.wide && { wide: true }), rule, dir);
    };
    const internet = (c, rule, dir) => add(inKey(c.label), () => inTile(c.label, c.kind === "internet" ? "ip" : c.kind, { ...(c.sub && { sub: c.sub }), ...(c.owner && { owner: c.owner }) }), rule, dir);
    const anyAddress = (rule, dir, sides) => {
      if (sides.internet) internet({ kind: "any", label: ANY_LABEL }, rule, dir);
      if (!sides.onprem) return;
      const spots = reachedSites.length ? reachedSites.flatMap((s) => siteGws(s.id).map((gateway) => ({ site: s.id, gateway }))) : [unknownSpot()];
      for (const spot of spots) if (spot.gateway) add(opKey(spot, ANY_LABEL), () => opTile(spot, ANY_LABEL, "any"), rule, dir);
    };
    // An IP group is one tile per side (and per site) named after the group, listing the addresses it holds there.
    const group = (id, rule, dir, sides) => {
      const g = env.ipGroups[id];
      if (!g) return;
      const name = g.name || id.split("/").pop();
      const tiles = new Map();
      for (const a of arr(g.ips)) {
        const c = classify(env, a);
        if (!c || c.kind === "azure" || c.kind === "tag" || c.kind === "ipv6") continue;
        if (c.kind === "any") {
          anyAddress(rule, dir, sides);
          continue;
        }
        let spots = [];
        if (c.kind === "onprem" && sides.onprem && !(dir === "in" && c.wide)) spots = onpremSpots(c).map((sp) => ({ ...sp, side: "onprem" }));
        else if (c.kind === "internet" && sides.internet) spots = [{ side: "internet" }];
        for (const sp of spots) {
          const k = sp.side === "onprem" ? opKey(sp, name) : inKey(name);
          if (!tiles.has(k)) tiles.set(k, { sp, addresses: [], count: 0, wide: false });
          const b = tiles.get(k);
          b.count++;
          b.wide = b.wide || !!c.wide;
          if (b.addresses.length < MAX_ADDRESSES) b.addresses.push(String(a));
        }
      }
      for (const [k, b] of tiles) {
        const fields = { addresses: b.addresses, addressCount: b.count, groupCount: arr(g.ips).length, ...(b.wide && { wide: true }) };
        add(k, () => (b.sp.side === "onprem" ? opTile(b.sp, name, "group", fields) : inTile(name, "group", fields)), rule, dir);
      }
    };
    // One list of addresses (sources or destinations) and the sides it may open.
    const addresses = (list, groups, rule, dir, sides) => {
      for (const e of arr(list)) {
        const c = classify(env, e);
        if (!c || c.kind === "azure" || c.kind === "ipv6") continue;
        if (c.kind === "any") anyAddress(rule, dir, sides);
        else if (c.kind === "onprem") {
          // A source range that also covers a VNet (10.0.0.0/8) is Azure traffic as much as on-premises: no tile into Azure.
          if (sides.onprem && !(dir === "in" && c.wide)) onprem(c, rule, dir);
        } else if (sides.internet) internet(c, rule, dir);
      }
      for (const id of arr(groups)) group(lc(id), rule, dir, sides);
    };
    const hasOnpremSource = (r) => {
      const srcs = [...arr(r.src), ...arr(r.srcGroups).flatMap((id) => (env.ipGroups[lc(id)] ? arr(env.ipGroups[lc(id)].ips) : []))];
      return srcs.some((s) => {
        const c = classify(env, s);
        return c && c.kind === "onprem" && !c.wide;
      });
    };

    for (const g of arr(policy.view)) {
      for (const c of arr(g.collections)) {
        const nat = c.kind === "nat" || /dnat/i.test(c.action || "");
        if (!nat && !/^allow$/i.test(c.action || "")) continue;
        for (const r of arr(c.rules)) {
          rulesSeen++;
          const row = ruleRow(r, policy, g, c, firewall.name);
          if (r.type === "Nat") {
            // Traffic from the Internet into the firewall's public address, forwarded inside.
            curFrom = azureSide(env, [String(r.translated || "").split(":")[0]], []);
            addresses(r.src, r.srcGroups, row, "in", { internet: true, onprem: false });
            continue;
          }
          // Where the rule lets traffic go, from the Azure side it names.
          curFrom = azureSide(env, r.src, r.srcGroups);
          addresses(r.dst, r.dstGroups, row, "out", { internet: true, onprem: true });
          for (const f of [...arr(r.fqdns), ...arr(r.targets)]) {
            const s = String(f).trim();
            if (!s) continue;
            internet(s === "*" ? { kind: "anyfqdn", label: "Any name (*)" } : { kind: "fqdn", label: s }, row, "out");
          }
          for (const u of arr(r.urls)) internet({ kind: "url", label: String(u) }, row, "out");
          for (const t of arr(r.tags)) internet({ kind: "tag", label: String(t), sub: "FQDN tag" }, row, "out");
          for (const w of arr(r.categories)) internet({ kind: "category", label: String(w), sub: "web category" }, row, "out");
          // Where it lets traffic come from: a named on-premises range (never "*"), into the Azure side it names.
          if (hasOnpremSource(r)) {
            curFrom = azureSide(env, r.dst, r.dstGroups);
            addresses(arr(r.src).filter((s) => !isAny(s)), r.srcGroups, row, "in", { internet: false, onprem: true });
          }
          curFrom = null;
        }
      }
    }
  }
  const list = [...targets.values()];
  if (targets.size >= maxTargets) notes.push(`Only the first ${maxTargets} openings are drawn`);
  if (!firewalls.length && firewallList.length) notes.push("No saved rules match the firewalls on the drawing: run the Firewall policies scan");
  const unplaced = list.filter((t) => t.side === "onprem" && !t.gateway).length;
  if (unplaced) notes.push(`${unplaced} on-premises opening${unplaced === 1 ? "" : "s"} could not be tied to a gateway (several gateways, and no site's address space holds the address)`);
  return { firewalls, targets: list, rules: rulesSeen, notes };
}

module.exports = { compute, _test: { classify, portText, environment, reachableGateways, azureSide } };
