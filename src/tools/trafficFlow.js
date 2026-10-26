// Traffic lines for the Architecture drawing: can one resource reach another on
// some ports, and which way does the traffic go? Works on the network the
// Architecture scan saves (architecture/network.json: subnets, peerings, NSGs,
// route tables, NIC addresses, Azure Firewall addresses) and, for traffic a
// route sends to an Azure Firewall, on the rules the Firewall policies scan
// saves (firewall/inventory.json). Plain functions; no Azure calls.
//
// What it models: the route Azure picks (longest prefix, a user-defined route
// beats a system route of the same length), NSGs on both subnets and both NICs
// (first matching rule decides; application security groups; the VirtualNetwork
// tag), and Azure Firewall network rules (first match in processing order,
// anything else denied). What it does not: application rules (they match names),
// on-premises routes, NVAs that are not Azure Firewalls, return traffic.
const ip = require("./ipv4");

const lc = (s) => String(s || "").toLowerCase();
const arr = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);

/* ---------- port spans: sorted [lo, hi] lists ---------- */
function cut(spans, by) {
  let out = spans;
  for (const [c1, c2] of by) {
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
function both(x, y) {
  const out = [];
  for (const [a1, b1] of x) for (const [a2, b2] of y) if (Math.max(a1, a2) <= Math.min(b1, b2)) out.push([Math.max(a1, a2), Math.min(b1, b2)]);
  return out;
}
const size = (spans) => spans.reduce((n, [a, b]) => n + b - a + 1, 0);
function portSpans(list) {
  const out = [];
  for (const p of arr(list)) {
    const s = String(p).trim();
    if (s === "*" || /^any$/i.test(s)) return [[0, 65535]];
    const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(s);
    if (m) out.push([Number(m[1]), Number(m[2] || m[1])]);
  }
  return out;
}

/* ---------- addresses ---------- */
const one = (text) => ip.parseEntry(text);
const inside = (r, a) => !!r && !!a && r.start <= a.start && a.end <= r.end;
const DEFAULT_RULES = {
  in: [
    { n: "AllowVnetInBound", a: true, pr: "*", s: ["VirtualNetwork"], t: ["VirtualNetwork"], dp: ["*"] },
    { n: "AllowAzureLoadBalancerInBound", a: true, pr: "*", s: ["AzureLoadBalancer"], t: ["*"], dp: ["*"] },
    { n: "DenyAllInBound", a: false, pr: "*", s: ["*"], t: ["*"], dp: ["*"] },
  ],
  out: [
    { n: "AllowVnetOutBound", a: true, pr: "*", s: ["VirtualNetwork"], t: ["VirtualNetwork"], dp: ["*"] },
    { n: "AllowInternetOutBound", a: true, pr: "*", s: ["*"], t: ["Internet"], dp: ["*"] },
    { n: "DenyAllOutBound", a: false, pr: "*", s: ["*"], t: ["*"], dp: ["*"] },
  ],
};

/* ---------- the saved network, made quick to look up ---------- */
function index(net) {
  const subnets = new Map(arr(net.subnets).map((s) => [s.id, { ...s, ranges: arr(s.prefixes).map(one).filter(Boolean) }]));
  const vnets = new Map(arr(net.vnets).map((v) => [v.id, { ...v, ranges: arr(v.prefixes).map(one).filter(Boolean), peers: new Set(arr(v.peers)) }]));
  const nsgs = new Map(arr(net.nsgs).map((n) => [n.id, n]));
  const routeTables = new Map(arr(net.routeTables).map((r) => [r.id, r]));
  const nics = new Map(arr(net.nics).map((n) => [n.owner, n]));
  const firewalls = arr(net.firewalls);
  const addrs = new Map(arr(net.addrs));
  return { subnets, vnets, nsgs, routeTables, nics, firewalls, addrs };
}

// The VirtualNetwork service tag as seen from a subnet: its VNet, peered VNets and the prefixes of its routes.
function vnetTag(x, subnet) {
  const v = x.vnets.get(subnet.vnet);
  const out = v ? [...v.ranges] : [];
  if (v) for (const p of v.peers) out.push(...((x.vnets.get(p) || {}).ranges || []));
  const rt = subnet.rt && x.routeTables.get(subnet.rt);
  if (rt) for (const r of arr(rt.routes)) if (one(r.prefix)) out.push(one(r.prefix));
  return out;
}
function sideMatch(prefixes, asgs, addr, nicAsgs, tag) {
  if (arr(asgs).length) return arr(asgs).some((a) => nicAsgs.has(a));
  return arr(prefixes).some((s) => {
    const v = lc(s);
    if (v === "*" || v === "any" || v === "0.0.0.0/0") return true;
    if (v === "virtualnetwork") return tag.some((r) => inside(r, addr));
    if (v === "internet") return !tag.some((r) => inside(r, addr)) && !ip.isPrivate(addr);
    const r = one(s);
    return r ? inside(r, addr) : false; // other service tags never hold a VM's private address
  });
}
const protoMatch = (pr, proto) => pr === "*" || lc(pr) === "any" || lc(pr) === lc(proto);

// One NSG on one direction for one flow: the ports it lets through and the rule that stops the rest.
function nsgPass(x, nsgId, dir, f, spans, subnetOfTag) {
  const nsg = x.nsgs.get(nsgId);
  if (!nsg) return { spans, unknown: true, label: `NSG ${nsgId.split("/").pop()} (not read)` };
  const rules = [...arr(nsg.rules).filter((r) => r.d === dir), ...(arr(nsg.defaults).some((r) => r.d === dir) ? nsg.defaults.filter((r) => r.d === dir) : DEFAULT_RULES[dir])];
  const tag = vnetTag(x, subnetOfTag);
  let left = spans;
  let allowed = [];
  let stop = null;
  for (const r of rules) {
    if (!left.length) break;
    if (!protoMatch(r.pr, f.proto)) continue;
    if (!sideMatch(r.s, r.sa, f.src, f.srcAsgs, tag) || !sideMatch(r.t, r.ta, f.dst, f.dstAsgs, tag)) continue;
    const hit = both(left, portSpans(r.dp));
    if (!hit.length) continue;
    if (r.a) allowed = allowed.concat(hit);
    else stop = stop || r.n;
    left = cut(left, hit);
  }
  return { spans: allowed, stop, label: nsg.name };
}

/* ---------- routes ---------- */
// The route the source subnet uses for an address: { kind: "direct" | "appliance" | "drop", ... }.
// A private endpoint adds its own /32 system route unless its subnet has route-table policies on.
function route(x, from, dst, pe) {
  const v = x.vnets.get(from.vnet);
  const cands = [];
  if (pe) cands.push({ bits: 32, kind: "direct", sys: true, prefix: `${pe}/32 (private endpoint)`, hit: true });
  if (v) {
    for (const r of v.ranges) cands.push({ bits: r.bits, kind: "direct", sys: true, prefix: r.text, hit: inside(r, dst) });
    for (const p of v.peers) for (const r of (x.vnets.get(p) || { ranges: [] }).ranges) cands.push({ bits: r.bits, kind: "direct", sys: true, prefix: r.text, peer: p, hit: inside(r, dst) });
  }
  const rt = from.rt && x.routeTables.get(from.rt);
  for (const r of rt ? arr(rt.routes) : []) {
    const c = ip.parse(r.prefix);
    if (!c || !inside(c, dst)) continue;
    const hop = lc(r.hop);
    const kind = hop === "virtualappliance" ? "appliance" : hop === "vnetlocal" ? "direct" : hop === "none" ? "drop" : hop === "virtualnetworkgateway" ? "gateway" : hop === "internet" ? "internet" : "drop";
    cands.push({ bits: c.bits, kind, prefix: r.prefix, hopIp: r.hopIp, name: r.name, table: rt.name, hit: true });
  }
  let best = null;
  for (const c of cands.filter((c) => c.hit)) if (!best || c.bits > best.bits || (c.bits === best.bits && best.sys && !c.sys)) best = c;
  return best || { kind: "none" };
}
const routeText = (r) => (r.sys ? `system route ${r.prefix}${r.peer ? " (peering)" : ""}` : `route ${r.name || r.prefix} (${r.prefix}) in ${r.table}`);

/* ---------- Azure Firewall network rules ---------- */
function fwSet(entries, groups, ipGroups) {
  const ranges = [];
  let all = false;
  let names = false;
  for (const e of [...arr(entries), ...arr(groups).flatMap((g) => (ipGroups[g] ? arr(ipGroups[g].ips) : []))]) {
    const s = String(e).trim();
    if (s === "*" || s === "0.0.0.0/0" || /^any$/i.test(s)) all = true;
    else if (one(s)) ranges.push(one(s));
    else names = true;
  }
  return { all, ranges, names };
}
function firewallPass(policy, ipGroups, f, spans) {
  const rules = [];
  for (const g of arr(policy.view)) for (const c of arr(g.collections)) for (const r of arr(c.rules)) if (r.type === "Network") rules.push({ r, c, g });
  let left = spans;
  let allowed = [];
  let stop = null;
  let allowBy = null;
  let names = false;
  for (const { r, c, g } of rules) {
    if (!left.length) break;
    const protos = arr(r.protocols).map(lc);
    if (!protos.includes("any") && !protos.includes(lc(f.proto))) continue;
    const s = fwSet(r.src, r.srcGroups, ipGroups);
    if (!s.all && !s.ranges.some((x) => inside(x, f.src))) continue;
    const d = fwSet(r.dst, r.dstGroups, ipGroups);
    if (arr(r.fqdns).length) names = true;
    if (!d.all && !d.ranges.some((x) => inside(x, f.dst))) continue;
    const hit = both(left, portSpans(r.ports));
    if (!hit.length) continue;
    const where = `${r.name} (${g.name} › ${c.name})`;
    if (c.action === "Deny") stop = stop || where;
    else {
      allowed = allowed.concat(hit);
      allowBy = allowBy || where;
    }
    left = cut(left, hit);
  }
  return { spans: allowed, stop: stop || (left.length ? "no network rule (default deny)" : null), allowBy, names };
}

/* ---------- one flow ---------- */
// src/dst: { ip, subnet, nsg, asgs } from the saved NICs. checks: [{ label, proto, lo, hi }].
function evaluate(x, fw, srcNic, dstNic, checks) {
  const from = x.subnets.get(srcNic.subnet);
  const to = x.subnets.get(dstNic.subnet);
  const src = one(srcNic.ip), dst = one(dstNic.ip);
  if (!from || !to || !src || !dst) return { state: "unknown", why: "The network of one side was not read" };
  const steps = [];
  const peRoute = dstNic.pe && !/^(enabled|routetableenabled)$/i.test(to.pePolicies || "") ? dstNic.ip : null;
  const r = route(x, from, dst, peRoute);
  let via = "direct";
  let fwId = null;
  const stages = []; // [{ where, f(spans, check) -> { spans, stop } }]
  const flow = (proto) => ({ proto, src, dst, srcAsgs: new Set(arr(srcNic.asgs)), dstAsgs: new Set(arr(dstNic.asgs)) });
  if (srcNic.nsg) stages.push({ where: "source NIC", run: (f, s) => nsgPass(x, srcNic.nsg, "out", f, s, from) });
  if (from.nsg) stages.push({ where: `subnet ${from.name}`, run: (f, s) => nsgPass(x, from.nsg, "out", f, s, from) });
  if (r.kind === "appliance") {
    const firewall = x.firewalls.find((w) => w.ip === r.hopIp);
    steps.push(`${routeText(r)} sends it to ${firewall ? `firewall ${firewall.name}` : `appliance ${r.hopIp}`}`);
    if (!firewall) {
      // A firewall VM (Palo Alto, Fortinet...): the line goes through it, but its rules are not known here.
      const owner = x.addrs && x.addrs.get(r.hopIp);
      const who = owner ? owner.split("/").pop() : r.hopIp;
      return { state: "unknown", via: `appliance ${who}`, ...(owner && { hop: owner }), steps: [...steps, `${who} is not an Azure Firewall, so its rules are not known here`] };
    }
    via = `firewall ${firewall.name}`;
    fwId = firewall.id;
    const policy = fw && arr(fw.policies).find((p) => p.id === firewall.policy || arr(p.firewalls).includes(firewall.name));
    if (!policy) return { state: "unknown", via, steps: [...steps, "The firewall's rules are not saved yet: run the Firewall policies scan"] };
    stages.push({ where: `firewall ${firewall.name} (${policy.name})`, fw: true, run: (f, s) => firewallPass(policy, (fw && fw.ipGroups) || {}, f, s) });
    // From the firewall on: its own subnet's route to the target.
    const fwSubnet = x.subnets.get(firewall.subnet);
    if (fwSubnet) {
      const r2 = route(x, fwSubnet, dst, peRoute);
      if (r2.kind !== "direct") return { state: "deny", via, steps: [...steps, `The firewall has no route to ${dstNic.ip} (its VNet is not peered with the target's)`], checks: checks.map((c) => ({ label: c.label, ok: "none", by: "no route from the firewall" })) };
    }
  } else if (r.kind === "direct") {
    steps.push(`${routeText(r)}: straight there, no firewall`);
  } else {
    const why = r.kind === "none" ? `No route: ${to.vnet === from.vnet ? "" : "the VNets are not peered and "}no route sends it anywhere` : r.kind === "drop" ? `${routeText(r)} drops it (next hop None)` : r.kind === "gateway" ? `${routeText(r)} sends it to the VPN gateway` : `${routeText(r)} sends it to the internet`;
    return { state: r.kind === "gateway" ? "unknown" : "deny", via: r.kind === "gateway" ? "gateway" : "none", steps: [why], checks: checks.map((c) => ({ label: c.label, ok: "none", by: "no route" })) };
  }
  if (to.nsg) stages.push({ where: `subnet ${to.name}`, run: (f, s) => (dstNic.pe && !/^(enabled|networksecuritygroupenabled)$/i.test(to.pePolicies || "") ? { spans: s } : nsgPass(x, to.nsg, "in", f, s, to)) });
  if (dstNic.nsg) stages.push({ where: "target NIC", run: (f, s) => nsgPass(x, dstNic.nsg, "in", f, s, to) });
  if (!from.nsg && !srcNic.nsg) steps.push(`No NSG on the source subnet ${from.name}`);
  if (!to.nsg && !dstNic.nsg) steps.push(`No NSG on the target subnet ${to.name}`);
  let names = false;
  const out = checks.map((c) => {
    const f = flow(c.proto);
    let spans = [[c.lo, c.hi]];
    let by = null;
    let rule = null;
    for (const st of stages) {
      const res = st.run(f, spans);
      if (res.names) names = true;
      if (res.allowBy && res.spans.length) rule = res.allowBy;
      if (res.stop && size(res.spans) < size(spans)) by = by || `${st.where}: ${res.stop}`;
      else if (size(res.spans) < size(spans)) by = by || `${st.where}: ${res.label || "blocked"}`;
      spans = res.spans;
      if (!spans.length) break;
    }
    const got = size(spans), want = c.hi - c.lo + 1;
    // What is left open of a range, in short ("53, 88, 49152-65535").
    const open = got && got < want ? [...spans].sort((x, y) => x[0] - y[0]).slice(0, 12).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ") + (spans.length > 12 ? ` and ${spans.length - 12} more` : "") : null;
    return { label: c.label, ok: got === want ? "all" : got ? "part" : "none", ...(by && { by }), ...(rule && { rule }), ...(open && c.hi > c.lo && { open }) };
  });
  if (names) steps.push("Some firewall rules use names (FQDNs); those are not matched here");
  const n = out.filter((c) => c.ok === "all").length;
  const state = n === out.length ? "allow" : out.some((c) => c.ok !== "none") ? "part" : "deny";
  return { state, via, ...(fwId && { fw: fwId }), steps, checks: out };
}

/* ---------- port sets the page offers ---------- */
const PRESETS = {
  all: { label: "All ports", checks: [["All", "TCP", 0, 65535], ["All", "UDP", 0, 65535]] },
  ad: { label: "Domain controller (AD)", checks: [["DNS", "TCP", 53], ["DNS", "UDP", 53], ["Kerberos", "TCP", 88], ["Kerberos", "UDP", 88], ["NTP", "UDP", 123], ["RPC", "TCP", 135], ["LDAP", "TCP", 389], ["LDAP", "UDP", 389], ["SMB", "TCP", 445], ["Kerberos password", "TCP", 464], ["LDAPS", "TCP", 636], ["Global catalog", "TCP", 3268, 3269], ["RPC dynamic", "TCP", 49152, 65535]] },
  rdp: { label: "RDP", checks: [["RDP", "TCP", 3389]] },
  ssh: { label: "SSH", checks: [["SSH", "TCP", 22]] },
  smb: { label: "File share (SMB)", checks: [["SMB", "TCP", 445]] },
  sql: { label: "SQL Server", checks: [["SQL", "TCP", 1433]] },
  web: { label: "Web", checks: [["HTTP", "TCP", 80], ["HTTPS", "TCP", 443]] },
  winrm: { label: "WinRM", checks: [["WinRM", "TCP", 5985, 5986]] },
};
const checksOf = (preset) => PRESETS[preset].checks.map(([label, proto, lo, hi]) => ({ label: `${label} ${proto} ${hi && hi !== lo ? `${lo}-${hi}` : lo}`, proto, lo, hi: hi || lo }));
// "tcp 8080, udp 500-510, 443" (TCP when no protocol is given).
function customChecks(text) {
  const out = [];
  for (const part of String(text || "").split(/[,;]+/).map((s) => s.trim()).filter(Boolean).slice(0, 20)) {
    const m = /^(?:(tcp|udp)\s*)?(\d{1,5})(?:\s*-\s*(\d{1,5}))?$/i.exec(part);
    if (!m) return null;
    const lo = Number(m[2]), hi = Number(m[3] || m[2]);
    if (lo > 65535 || hi > 65535 || hi < lo) return null;
    const proto = (m[1] || "tcp").toUpperCase();
    out.push({ label: `${proto} ${hi !== lo ? `${lo}-${hi}` : lo}`, proto, lo, hi });
  }
  return out.length ? out : null;
}

module.exports = { index, evaluate, route, nsgPass, firewallPass, PRESETS, checksOf, customChecks };
