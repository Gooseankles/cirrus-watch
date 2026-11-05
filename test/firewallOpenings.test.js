// The firewall openings behind the Architecture drawing: where each Allow or
// DNAT rule points (on-premises site, Internet or inside Azure) and which
// gateway or firewall the line starts from. Pure data, no Azure.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const env = require("./_env");
after(env.cleanup);
const { compute, _test } = require("../src/tools/firewallOpenings");
const flows = require("../src/tools/trafficFlow");

const SUB = "/subscriptions/00000000-0000-4000-8000-000000000001";
const HUB = `${SUB}/resourcegroups/rg-hub/providers/microsoft.network/virtualnetworks/vnet-hub`;
const SPOKE = `${SUB}/resourcegroups/rg-app/providers/microsoft.network/virtualnetworks/vnet-app`;
const FW = `${SUB}/resourcegroups/rg-hub/providers/microsoft.network/azurefirewalls/fw-hub`;
const GW = `${SUB}/resourcegroups/rg-hub/providers/microsoft.network/virtualnetworkgateways/er-gw`;
const VPN = `${SUB}/resourcegroups/rg-hub/providers/microsoft.network/virtualnetworkgateways/vpn-gw`;
const ER = `${SUB}/resourcegroups/rg-hub/providers/microsoft.network/expressroutecircuits/er-oslo`;
const LNG = `${SUB}/resourcegroups/rg-hub/providers/microsoft.network/localnetworkgateways/lng-bergen`;
const POLICY = `${SUB}/resourcegroups/rg-hub/providers/microsoft.network/firewallpolicies/fwp-hub`;
const GROUP = `${SUB}/resourcegroups/rg-hub/providers/microsoft.network/ipgroups/ipg-onprem-dcs`;

const SN_APP = `${SPOKE}/subnets/snet-app`;
const SN_DB = `${SPOKE}/subnets/snet-db`;
const VM = `${SUB}/resourcegroups/rg-app/providers/microsoft.compute/virtualmachines/vm-app`;
const VM2 = `${SUB}/resourcegroups/rg-app/providers/microsoft.compute/virtualmachines/vm-app-2`;
const net = {
  complete: true,
  vnets: [
    { id: HUB, prefixes: ["10.10.0.0/16"], peers: [SPOKE] },
    { id: SPOKE, prefixes: ["10.20.0.0/16"], peers: [HUB] },
  ],
  subnets: [
    { id: SN_APP, name: "snet-app", vnet: SPOKE, prefixes: ["10.20.1.0/24"] },
    { id: SN_DB, name: "snet-db", vnet: SPOKE, prefixes: ["10.20.2.0/24"] },
  ],
  nics: [{ owner: VM2, ip: "10.20.1.20", subnet: SN_APP }],
  firewalls: [{ id: FW, name: "fw-hub", ip: "10.10.1.4", policy: POLICY, subnet: `${HUB}/subnets/azurefirewallsubnet` }],
};
const inv = {
  resources: [
    { id: FW, name: "fw-hub", type: "microsoft.network/azurefirewalls", subnet: `${HUB}/subnets/azurefirewallsubnet`, publicIps: ["20.50.60.70"] },
    { id: GW, name: "er-gw", type: "microsoft.network/virtualnetworkgateways", subnet: `${HUB}/subnets/gatewaysubnet` },
    { id: VM, name: "vm-app", type: "microsoft.compute/virtualmachines", subnet: SN_APP, ip: "10.20.1.10" },
    { id: VM2, name: "vm-app-2", type: "microsoft.compute/virtualmachines", subnet: SN_APP },
  ],
  sites: [{ id: ER, name: "er-oslo", type: "microsoft.network/expressroutecircuits", prefixes: ["192.168.0.0/16", "172.16.0.0/12"], provider: "Telenor" }],
  connections: [{ id: `${GW}/connections/er-oslo`, name: "er-oslo", kind: "ExpressRoute", gateway: GW, site: ER }],
};
const rule = (name, fields) => ({ name, type: "Network", src: ["*"], srcGroups: [], dst: [], dstGroups: [], fqdns: [], ports: ["443"], protocols: ["TCP"], targets: [], urls: [], tags: [], categories: [], ...fields });
const fw = {
  policies: [
    {
      id: POLICY,
      name: "fwp-hub",
      firewalls: ["fw-hub"],
      view: [
        {
          name: "DefaultNetworkRuleCollectionGroup",
          priority: 200,
          collections: [
            {
              name: "allow-out",
              priority: 100,
              kind: "filter",
              action: "Allow",
              rules: [
                rule("to-dc", { dst: ["192.168.10.5"], ports: ["445", "88"] }),
                rule("to-spoke", { dst: ["10.20.1.4"] }),
                rule("to-dns", { dst: ["8.8.8.8"], ports: ["53"], protocols: ["UDP"] }),
                rule("to-storage", { dst: ["Storage"] }),
                rule("from-branch", { src: ["192.168.50.0/24"], dst: ["10.20.0.0/16"], ports: ["3389"] }),
                rule("to-dcs-group", { dstGroups: [GROUP], ports: ["389"] }),
                rule("to-unknown", { dst: ["10.99.0.0/16"] }),
                rule("to-fw-own-ip", { dst: ["20.50.60.70"] }),
              ],
            },
            { name: "deny-bad", priority: 110, kind: "filter", action: "Deny", rules: [rule("deny-this", { dst: ["1.2.3.4"] })] },
          ],
        },
        {
          name: "DefaultApplicationRuleCollectionGroup",
          priority: 300,
          collections: [
            {
              name: "web",
              priority: 100,
              kind: "filter",
              action: "Allow",
              rules: [{ name: "ms", type: "Application", src: ["10.20.0.0/16"], srcGroups: [], dst: [], dstGroups: [], fqdns: [], ports: [], protocols: ["Https:443"], targets: ["*.microsoft.com", "login.microsoftonline.com"], urls: [], tags: ["WindowsUpdate"], categories: ["Business"] }],
            },
          ],
        },
        {
          name: "DefaultDnatRuleCollectionGroup",
          priority: 100,
          collections: [{ name: "inbound", priority: 100, kind: "nat", action: "DNAT", rules: [{ name: "rdp-in", type: "Nat", src: ["*"], srcGroups: [], dst: ["20.50.60.70"], dstGroups: [], fqdns: [], ports: ["3389"], protocols: ["TCP"], targets: [], urls: [], tags: [], categories: [], translated: "10.20.1.10:3389" }] }],
        },
      ],
    },
  ],
  ipGroups: { [GROUP]: { name: "ipg-onprem-dcs", count: 4, ips: ["192.168.10.5", "192.168.10.6", "10.20.5.5", "40.80.1.1"] } },
};

const byLabel = (out, label, side) => out.targets.filter((t) => t.label === label && (!side || t.side === side));

test("on-premises destinations hang under their site with a line from its gateway", () => {
  const out = compute({ net, fw, inv });
  assert.deepEqual(out.firewalls, [{ id: FW.toLowerCase(), name: "fw-hub", policy: "fwp-hub" }]);
  const [dc] = byLabel(out, "192.168.10.5");
  assert.equal(dc.side, "onprem");
  assert.equal(dc.site, ER.toLowerCase());
  assert.equal(dc.gateway, GW.toLowerCase());
  assert.equal(dc.firewall, FW.toLowerCase());
  assert.deepEqual(dc.firewalls, [FW.toLowerCase()]);
  assert.equal(dc.dir, "out");
  assert.deepEqual(dc.ports, ["TCP 445, 88"]);
  assert.equal(dc.rules[0].name, "to-dc");
  assert.equal(dc.rules[0].collection, "allow-out");
  assert.equal(dc.rules[0].firewall, "fw-hub");
});

test("addresses inside a VNet and Deny rules make no tile", () => {
  const out = compute({ net, fw, inv });
  assert.equal(byLabel(out, "10.20.1.4").length, 0);
  assert.equal(byLabel(out, "1.2.3.4").length, 0);
  assert.equal(byLabel(out, "10.20.0.0/16").length, 0, "the destination of the inbound rule is Azure");
});

test("Internet addresses, names, tags and categories start from the firewall", () => {
  const out = compute({ net, fw, inv });
  const [dns] = byLabel(out, "8.8.8.8", "internet");
  assert.equal(dns.firewall, FW.toLowerCase());
  assert.equal(dns.kind, "ip");
  assert.deepEqual(dns.ports, ["UDP 53"]);
  assert.equal(byLabel(out, "Storage", "internet")[0].kind, "tag");
  const [ms] = byLabel(out, "*.microsoft.com", "internet");
  assert.equal(ms.kind, "fqdn");
  assert.deepEqual(ms.ports, ["https 443"]);
  assert.equal(byLabel(out, "login.microsoftonline.com", "internet").length, 1);
  assert.equal(byLabel(out, "WindowsUpdate", "internet")[0].sub, "FQDN tag");
  assert.equal(byLabel(out, "Business", "internet")[0].sub, "web category");
  const [own] = byLabel(out, "20.50.60.70", "internet");
  assert.equal(own.owner, "fw-hub", "a public address that belongs to a resource says whose it is");
});

test("a named on-premises source makes a line into the gateway", () => {
  const out = compute({ net, fw, inv });
  const [branch] = byLabel(out, "192.168.50.0/24");
  assert.equal(branch.side, "onprem");
  assert.equal(branch.dir, "in");
  assert.equal(branch.gateway, GW.toLowerCase());
  assert.deepEqual(branch.ports, ["TCP 3389"]);
  assert.deepEqual(branch.from, [{ id: SPOKE.toLowerCase(), kind: "vnet" }], "the line ends at the VNet the rule's destination covers");
});

test("a source range that also covers a VNet makes no inbound tile", () => {
  const wide = { ...fw, policies: [{ ...fw.policies[0], view: [{ name: "g", priority: 100, collections: [{ name: "c", priority: 100, kind: "filter", action: "Allow", rules: [rule("ntp-to-dc", { src: ["10.0.0.0/8"], dst: ["192.168.10.10"], ports: ["123"], protocols: ["UDP"] }), rule("mgmt-in", { src: ["10.0.0.0/8", "192.168.50.0/24"], dst: ["10.20.0.0/16"] })] }] }] }] };
  const out = compute({ net, fw: wide, inv });
  assert.equal(byLabel(out, "10.0.0.0/8").length, 0, "10.0.0.0/8 as a source is Azure traffic as much as on-premises");
  const [dc] = byLabel(out, "192.168.10.10");
  assert.equal(dc.dir, "out");
  assert.equal(dc.fromAny, false);
  assert.deepEqual(dc.from.map((f) => f.kind), ["vnet", "vnet"], "a source over a few whole VNets starts a line at each");
  const many = { ...net, vnets: [...net.vnets, ...[1, 2, 3].map((i) => ({ id: `${HUB}-${i}`, prefixes: [`10.${30 + i}.0.0/16`], peers: [] }))] };
  const [far] = byLabel(compute({ net: many, fw: wide, inv }), "192.168.10.10");
  assert.equal(far.fromAny, true, "over more than four VNets the line starts at the firewall");
  assert.deepEqual(far.from, []);
  assert.equal(far.rules[0].fromWide, true);
  assert.equal(far.rules[0].fromAny, false);
  assert.deepEqual(byLabel(out, "192.168.50.0/24").map((t) => t.dir), ["in"], "the narrow source still makes its tile");
});

test("the Azure side of a rule names the VM, subnet or VNet its line starts at", () => {
  const rules = [
    rule("vm-to-dc", { src: ["10.20.1.10"], dst: ["192.168.10.5"] }),
    rule("nic-to-dc", { src: ["10.20.1.16/28"], dst: ["192.168.10.5"] }),
    rule("db-to-dc", { src: ["10.20.2.0/24"], dst: ["192.168.10.5"] }),
    rule("spoke-to-dns", { src: ["10.20.0.0/16"], dst: ["8.8.8.8"] }),
    rule("hub-part-to-dns", { src: ["10.10.5.0/24"], dst: ["8.8.8.8"] }),
    rule("all-to-ntp", { src: ["*"], dst: ["9.9.9.9"] }),
    rule("group-to-time", { src: [], srcGroups: [GROUP], dst: ["1.1.1.1"] }),
  ];
  const own = { ...fw, ipGroups: { [GROUP]: { name: "ipg-onprem-dcs", ips: ["10.20.2.5"] } }, policies: [{ ...fw.policies[0], view: [{ name: "g", priority: 100, collections: [{ name: "c", priority: 100, kind: "filter", action: "Allow", rules }] }] }] };
  const out = compute({ net, fw: own, inv });
  const [dc] = byLabel(out, "192.168.10.5");
  assert.deepEqual(
    dc.from.map((f) => [f.kind, f.id]).sort(),
    [["resource", VM.toLowerCase()], ["resource", VM2.toLowerCase()], ["subnet", SN_DB.toLowerCase()]].sort(),
    "an address is its VM, a small range the VMs in it (also from the NIC list), a whole subnet the subnet"
  );
  assert.equal(dc.from.find((f) => f.kind === "resource").name, "vm-app");
  assert.equal(dc.fromCount, 3);
  assert.equal(dc.fromAny, false);
  const [dns] = byLabel(out, "8.8.8.8", "internet");
  assert.deepEqual(dns.from.map((f) => [f.kind, f.id]).sort(), [["vnet", HUB.toLowerCase()], ["vnet", SPOKE.toLowerCase()]].sort(), "a whole VNet, and a range in a VNet with no subnet drawn there, is the VNet");
  const [ntp] = byLabel(out, "9.9.9.9", "internet");
  assert.deepEqual(ntp.from, []);
  assert.equal(ntp.fromAny, true);
  const [time] = byLabel(out, "1.1.1.1", "internet");
  assert.deepEqual(time.from, [{ id: SN_DB.toLowerCase(), kind: "subnet" }], "an IP group source is read address by address");
});

test("each rule on a tile keeps its own Azure side, with the entry that put a place there", () => {
  // Five rules to one on-premises address merge into one tile; the tile's Azure side is the union, but each rule
  // says which VM, subnet or VNet it names and why, so a VM is never shown under a rule that does not name it.
  const rules = [
    rule("vm-to-dc", { src: ["10.20.1.10"], dst: ["192.168.10.5"] }),
    rule("nic-to-dc", { src: ["10.20.1.16/28"], dst: ["192.168.10.5"] }),
    rule("db-to-dc", { src: ["10.20.2.0/24"], dst: ["192.168.10.5"] }),
    rule("all-to-dc", { src: ["*"], dst: ["192.168.10.5"] }),
    rule("group-to-dc", { src: [], srcGroups: [GROUP], dst: ["192.168.10.5"] }),
  ];
  const own = { ...fw, ipGroups: { [GROUP]: { name: "ipg-onprem-dcs", ips: ["10.20.2.5", "10.20.1.10"] } }, policies: [{ ...fw.policies[0], view: [{ name: "g", priority: 100, collections: [{ name: "c", priority: 100, kind: "filter", action: "Allow", rules }] }] }] };
  const out = compute({ net, fw: own, inv });
  const [dc] = byLabel(out, "192.168.10.5");
  assert.equal(dc.ruleCount, 5);
  const by = (name) => dc.rules.find((x) => x.name === name);
  assert.deepEqual(by("vm-to-dc").from, [{ id: VM.toLowerCase(), kind: "resource", name: "vm-app", ip: "10.20.1.10", by: ["10.20.1.10"] }], "the rule that names the VM's address is on that VM only");
  assert.equal(by("vm-to-dc").fromCount, 1);
  assert.equal(by("vm-to-dc").fromAny, false);
  assert.deepEqual(by("nic-to-dc").from, [{ id: VM2.toLowerCase(), kind: "resource", name: "vm-app-2", ip: "10.20.1.20", by: ["10.20.1.16/28"] }], "a small range names the VMs in it and says which range");
  assert.deepEqual(by("db-to-dc").from, [{ id: SN_DB.toLowerCase(), kind: "subnet", by: ["10.20.2.0/24"] }]);
  assert.deepEqual(by("all-to-dc").from, []);
  assert.equal(by("all-to-dc").fromAny, true, "a '*' source is on no VM in particular");
  assert.deepEqual(
    by("group-to-dc").from.map((f) => [f.kind, f.by]),
    [["subnet", ["10.20.2.5 in group ipg-onprem-dcs"]], ["resource", ["10.20.1.10 in group ipg-onprem-dcs"]]],
    "an IP group member says which group it came from"
  );
  assert.deepEqual(dc.from.map((f) => f.id).sort(), [VM, VM2, SN_DB].map((s) => s.toLowerCase()).sort(), "the tile's own Azure side is the union over its rules");
  assert.ok(dc.from.every((f) => !("by" in f) && !("ip" in f)), "without the reasons");
  assert.equal(dc.fromAny, true);
  assert.equal(dc.rules.filter((x) => x.from.some((f) => f.id === VM2.toLowerCase())).length, 1, "vm-app-2 is named by one rule, not by the five on the tile");
});

test("an IP group is one tile per side, listing the addresses that side holds", () => {
  const out = compute({ net, fw, inv });
  const op = byLabel(out, "ipg-onprem-dcs", "onprem");
  assert.equal(op.length, 1);
  assert.equal(op[0].kind, "group");
  assert.deepEqual(op[0].addresses, ["192.168.10.5", "192.168.10.6"]);
  assert.equal(op[0].addressCount, 2);
  assert.equal(op[0].groupCount, 4);
  assert.equal(op[0].site, ER.toLowerCase());
  const inet = byLabel(out, "ipg-onprem-dcs", "internet");
  assert.deepEqual(inet[0].addresses, ["40.80.1.1"]);
});

test("a private range no site holds goes to the only gateway, marked as a guess", () => {
  const out = compute({ net, fw, inv });
  const [u] = byLabel(out, "10.99.0.0/16");
  assert.equal(u.gateway, GW.toLowerCase());
  assert.equal(u.site, ER.toLowerCase());
  assert.equal(u.siteGuess, true);
  assert.deepEqual(out.notes, []);
});

test("a DNAT rule is an inbound Internet opening with its translation", () => {
  const out = compute({ net, fw, inv });
  const [any] = byLabel(out, "Any address (*)", "internet");
  assert.equal(any.kind, "any");
  assert.equal(any.dir, "in");
  assert.deepEqual(any.ports, ["TCP 3389 → 10.20.1.10:3389"]);
  assert.equal(any.rules[0].type, "Nat");
  assert.deepEqual(any.from, [{ id: VM.toLowerCase(), kind: "resource", name: "vm-app" }], "the line ends at the VM the rule translates to");
  assert.deepEqual(any.rules[0].from, [{ id: VM.toLowerCase(), kind: "resource", name: "vm-app", ip: "10.20.1.10", by: ["10.20.1.10"] }], "the rule says so too");
  assert.equal(byLabel(out, "Any address (*)", "onprem").length, 0, "a '*' source never makes an on-premises tile");
});

test("a '*' destination reaches every site and the Internet", () => {
  const star = { ...fw, policies: [{ ...fw.policies[0], view: [{ name: "g", priority: 100, collections: [{ name: "all", priority: 100, kind: "filter", action: "Allow", rules: [rule("allow-all", { dst: ["*"], ports: ["*"], protocols: ["Any"] })] }] }] }] };
  const out = compute({ net, fw: star, inv });
  const op = byLabel(out, "Any address (*)", "onprem");
  assert.equal(op.length, 1);
  assert.equal(op[0].site, ER.toLowerCase());
  assert.equal(op[0].gateway, GW.toLowerCase());
  assert.equal(op[0].kind, "any");
  assert.deepEqual(op[0].ports, ["any protocol all ports"]);
  const inet = byLabel(out, "Any address (*)", "internet");
  assert.equal(inet.length, 1);
  assert.equal(inet[0].dir, "out");
  assert.equal(out.targets.length, 2);
});

test("a second site on a VPN gateway gets its own tiles; an address with no site and two gateways is left unplaced", () => {
  const inv2 = {
    resources: [...inv.resources, { id: VPN, name: "vpn-gw", type: "microsoft.network/virtualnetworkgateways", subnet: `${HUB}/subnets/gatewaysubnet` }],
    sites: [...inv.sites, { id: LNG, name: "lng-bergen", type: "microsoft.network/localnetworkgateways", prefixes: ["10.200.0.0/16"], address: "80.90.100.110" }],
    connections: [...inv.connections, { id: `${VPN}/connections/bergen`, name: "bergen", kind: "IPsec", gateway: VPN, site: LNG }],
  };
  const two = { ...fw, policies: [{ ...fw.policies[0], view: [{ name: "g", priority: 100, collections: [{ name: "c", priority: 100, kind: "filter", action: "Allow", rules: [rule("all", { dst: ["*"] }), rule("bergen-dc", { dst: ["10.200.1.1"] }), rule("lost", { dst: ["10.99.0.1"] })] }] }] }] };
  const out = compute({ net, fw: two, inv: inv2 });
  const any = byLabel(out, "Any address (*)", "onprem");
  assert.deepEqual(any.map((t) => [t.site, t.gateway]).sort(), [[ER.toLowerCase(), GW.toLowerCase()], [LNG.toLowerCase(), VPN.toLowerCase()]].sort());
  const [bergen] = byLabel(out, "10.200.1.1");
  assert.equal(bergen.site, LNG.toLowerCase());
  assert.equal(bergen.gateway, VPN.toLowerCase());
  const [lost] = byLabel(out, "10.99.0.1");
  assert.equal(lost.gateway, null);
  assert.equal(lost.site, null);
  assert.match(out.notes.join(" "), /1 on-premises opening could not be tied/);
});

test("a firewall whose policy is not saved gives a note and no tiles", () => {
  const out = compute({ net, fw: { policies: [], ipGroups: {} }, inv });
  assert.deepEqual(out.targets, []);
  assert.deepEqual(out.firewalls, []);
  assert.match(out.notes[0], /Firewall policies scan/);
  assert.deepEqual(compute({ net: null, fw: null, inv: null }), { firewalls: [], targets: [], rules: 0, notes: [] });
});

test("the indexed network from trafficFlow gives the same answer as the saved one", () => {
  const a = compute({ net, fw, inv });
  const b = compute({ net: flows.index(net), fw, inv });
  assert.deepEqual(b.targets.map((t) => t.key).sort(), a.targets.map((t) => t.key).sort());
});

test("rule text: ports and protocols, application protocols, DNAT translation", () => {
  assert.equal(_test.portText({ type: "Network", protocols: ["TCP", "UDP"], ports: ["53"] }), "TCP/UDP 53");
  assert.equal(_test.portText({ type: "Network", protocols: ["Any"], ports: ["*"] }), "any protocol all ports");
  assert.equal(_test.portText({ type: "Application", protocols: ["Https:443", "Http:80"] }), "https 443, http 80");
  assert.equal(_test.portText({ type: "Nat", protocols: ["TCP"], ports: ["443"], translated: "10.0.0.4:8443" }), "TCP 443 → 10.0.0.4:8443");
});

test("classify sorts entries into any, Azure, on-premises, Internet and service tags", () => {
  const e = _test.environment({ net, fw, inv });
  assert.equal(_test.classify(e, "*").kind, "any");
  assert.equal(_test.classify(e, "0.0.0.0/0").kind, "any");
  assert.equal(_test.classify(e, "10.10.5.5").kind, "azure");
  assert.equal(_test.classify(e, "192.168.1.1").kind, "onprem");
  assert.equal(_test.classify(e, "10.0.0.0/8").wide, true, "a range that also covers a VNet is marked wide");
  assert.equal(_test.classify(e, "1.1.1.1").kind, "internet");
  assert.equal(_test.classify(e, "AzureCloud.WestEurope").kind, "tag");
  assert.equal(_test.classify(e, "Internet").sub, "service tag: any public address");
  assert.equal(_test.classify(e, "2001:db8::1").kind, "ipv6");
  assert.equal(_test.classify(e, ""), null);
});

test("reachable gateways: the firewall's own VNet first, then peered VNets, then any", () => {
  const e = _test.environment({ net, fw, inv });
  assert.deepEqual(_test.reachableGateways(e, net.firewalls[0]).map((g) => g.name), ["er-gw"]);
  const spokeFw = { ...net.firewalls[0], subnet: `${SPOKE}/subnets/azurefirewallsubnet` };
  assert.deepEqual(_test.reachableGateways(e, spokeFw).map((g) => g.name), ["er-gw"], "through the peering");
  assert.deepEqual(_test.reachableGateways(e, { ...net.firewalls[0], subnet: "" }).map((g) => g.name), ["er-gw"], "no subnet known: every connected gateway");
});
