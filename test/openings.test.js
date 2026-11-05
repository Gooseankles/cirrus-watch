// The drawing's reading of the firewall openings (public/openings.js): with a VM picked, which tiles stay.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const Openings = require("../public/openings.js");

const VNET = "/subscriptions/s1/resourcegroups/rg-net/providers/microsoft.network/virtualnetworks/vnet-web";
const SUBNET = `${VNET}/subnets/snet-web`;
const VM = "/subscriptions/s1/resourcegroups/rg-web/providers/microsoft.compute/virtualmachines/vm-web-01";
const OTHER_SUBNET = "/subscriptions/s1/resourcegroups/rg-net/providers/microsoft.network/virtualnetworks/vnet-data/subnets/snet-sql";
const OTHER_VNET = "/subscriptions/s1/resourcegroups/rg-net/providers/microsoft.network/virtualnetworks/vnet-data";
const places = new Set([VM, SUBNET, VNET]);

const rule = (name, from, extra = {}) => ({ name, from, fromCount: from.length, fromAny: false, fromWide: false, ...extra });
const tile = (rules, extra = {}) => ({ label: "10.0.109.10", rules, ruleCount: rules.length, from: [], fromCount: 0, fromAny: false, ...extra });

test("a rule naming the VM, its subnet or its VNet keeps the tile; one naming another subnet does not", () => {
  const byAddress = tile([rule("vm-to-dc", [{ id: VM, kind: "resource", name: "vm-web-01", ip: "10.20.1.4", by: ["10.20.1.4"] }])]);
  const bySubnet = tile([rule("web-to-dc", [{ id: SUBNET, kind: "subnet", by: ["10.20.1.0/24"] }])]);
  const byVnet = tile([rule("all-to-dc", [{ id: VNET, kind: "vnet", by: ["10.20.0.0/16"] }])]);
  const elsewhere = tile([rule("dc-to-sql", [{ id: OTHER_SUBNET, kind: "subnet", by: ["10.30.1.0/24"] }])]);
  assert.equal(Openings.reaches(byAddress, places), true);
  assert.equal(Openings.reaches(bySubnet, places), true);
  assert.equal(Openings.reaches(byVnet, places), true);
  assert.equal(Openings.reaches(elsewhere, places), false);
  assert.deepEqual(
    Openings.rulesNaming(byAddress, places).map(([x, f]) => [x.name, f.id]),
    [["vm-to-dc", VM]]
  );
  assert.deepEqual(Openings.rulesNaming(elsewhere, places), []);
});

test("a tile mixing another subnet's rule with one naming the VM stays, and only the VM's rule names it", () => {
  const t = tile([rule("dc-to-sql", [{ id: OTHER_SUBNET, kind: "subnet", by: ["10.30.1.0/24"] }]), rule("vm-to-dc", [{ id: VM, kind: "resource", name: "vm-web-01", by: ["10.20.1.4"] }])]);
  assert.equal(Openings.reaches(t, places), true);
  assert.deepEqual(
    Openings.rulesNaming(t, places).map(([x]) => x.name),
    ["vm-to-dc"]
  );
});

test('a "*" source is open to every place; a wide range only to the VNets it covers', () => {
  const any = tile([rule("legacy-any", [], { fromAny: true })]);
  const wideOverMine = tile([rule("wide", [], { fromWide: true, wideVnets: [OTHER_VNET, VNET] })]);
  const wideElsewhere = tile([rule("wide", [], { fromWide: true, wideVnets: [OTHER_VNET] })]);
  const wideOldScan = tile([rule("wide", [], { fromWide: true })]);
  assert.equal(Openings.reaches(any, places), true);
  assert.equal(Openings.reaches(wideOverMine, places), true);
  assert.equal(Openings.reaches(wideElsewhere, places), false);
  assert.equal(Openings.reaches(wideOldScan, places), true, "a wide rule from before wideVnets existed keeps the tile");
  assert.equal(Openings.openToAll(any.rules[0], places), true);
  assert.equal(Openings.openToAll(wideElsewhere.rules[0], places), false);
  assert.equal(Openings.openToAll(rule("plain", [{ id: VM, kind: "resource" }]), places), false);
});

test("a tile with more rules than it lists falls back to its union of places, and keeps what it cannot check", () => {
  const listed = [rule("dc-to-sql", [{ id: OTHER_SUBNET, kind: "subnet", by: ["10.30.1.0/24"] }])];
  const unionNamesMe = tile(listed, { ruleCount: 20, from: [{ id: OTHER_SUBNET, kind: "subnet" }, { id: SUBNET, kind: "subnet" }], fromCount: 2 });
  const unionElsewhere = tile(listed, { ruleCount: 20, from: [{ id: OTHER_SUBNET, kind: "subnet" }], fromCount: 1 });
  const unionCut = tile(listed, { ruleCount: 20, from: [{ id: OTHER_SUBNET, kind: "subnet" }], fromCount: 30 });
  const unionAny = tile(listed, { ruleCount: 20, from: [{ id: OTHER_SUBNET, kind: "subnet" }], fromCount: 1, fromAny: true });
  assert.equal(Openings.reaches(unionNamesMe, places), true);
  assert.equal(Openings.reaches(unionElsewhere, places), false);
  assert.equal(Openings.reaches(unionCut, places), true, "places the tile did not list might be mine");
  assert.equal(Openings.reaches(unionAny, places), true);
  assert.equal(Openings.reaches(tile([], { ruleCount: 0 }), places), false, "a tile without rules names nothing");
  assert.equal(Openings.reaches(tile([], { ruleCount: 0, fromAny: true }), places), true);
});

test('with "any" off, only a rule naming a place or its subnet keeps the tile; a "*", wide or whole-VNet rule does not', () => {
  const named = tile([rule("vm-to-dc", [{ id: VM, kind: "resource", by: ["10.20.1.4"] }])]);
  const subnet = tile([rule("web-to-dc", [{ id: SUBNET, kind: "subnet", by: ["10.20.1.0/24"] }])]);
  const vnet = tile([rule("all-azure", [{ id: VNET, kind: "vnet", by: ["10.0.0.0/8"] }])]);
  const unionVnet = tile([rule("all-azure", [{ id: VNET, kind: "vnet" }])], { ruleCount: 20, from: [{ id: VNET, kind: "vnet" }], fromCount: 1 });
  const any = tile([rule("legacy-any", [], { fromAny: true })]);
  const wide = tile([rule("wide", [], { fromWide: true, wideVnets: [VNET] })]);
  const bare = tile([], { ruleCount: 0, fromAny: true });
  const unionAny = tile([rule("dc-to-sql", [{ id: OTHER_SUBNET, kind: "subnet" }])], { ruleCount: 20, from: [{ id: OTHER_SUBNET, kind: "subnet" }], fromCount: 1, fromAny: true });
  const unionCut = tile([rule("dc-to-sql", [{ id: OTHER_SUBNET, kind: "subnet" }])], { ruleCount: 20, from: [{ id: OTHER_SUBNET, kind: "subnet" }], fromCount: 30 });
  assert.equal(Openings.reaches(named, places, false), true);
  assert.equal(Openings.reaches(subnet, places, false), true);
  assert.equal(Openings.reaches(vnet, places, false), false, "a range over the whole VNet is open to every address in it");
  assert.equal(Openings.reaches(vnet, places), true);
  assert.equal(Openings.reaches(unionVnet, places, false), false, "also in a tile's union of places");
  assert.equal(Openings.reaches(unionVnet, places), true);
  assert.equal(Openings.reaches(any, places, false), false);
  assert.equal(Openings.reaches(wide, places, false), false);
  assert.equal(Openings.reaches(bare, places, false), false);
  assert.equal(Openings.reaches(unionAny, places, false), false);
  assert.equal(Openings.reaches(unionCut, places, false), true, "places the tile did not list might still be named");
  assert.equal(Openings.reaches(any, places), true, "on by default, as the picked-VM filter uses it");
});

test("a sender is a resource in a subnet that is not a network part or a firewall VM", () => {
  const vm = { subnet: SUBNET, t: { cat: "compute" } };
  assert.equal(Openings.sender(vm), true);
  assert.equal(Openings.sender({ subnet: SUBNET, t: { cat: "web" } }), true, "a web app with VNet integration");
  assert.equal(Openings.sender({ subnet: SUBNET, t: { cat: "network" } }), false, "a bastion, private endpoint or load balancer");
  assert.equal(Openings.sender({ ...vm, appliance: true }), false, "a firewall VM forwards for others");
  assert.equal(Openings.sender({ t: { cat: "compute" } }), false, "outside a subnet");
  assert.equal(Openings.sender(null), false);
});

test("drawn: nothing picked draws nothing; a bastion alone brings the rules naming it or its subnet; a VM brings its VNet's and the open-to-all ones too", () => {
  const HUB_VNET = "/subscriptions/s1/resourcegroups/rg-hub/providers/microsoft.network/virtualnetworks/vnet-hub";
  const BAS_SUBNET = `${HUB_VNET}/subnets/azurebastionsubnet`;
  const BAS = "/subscriptions/s1/resourcegroups/rg-hub/providers/microsoft.network/bastionhosts/bas-hub";
  const JUMP_SUBNET = `${HUB_VNET}/subnets/snet-jump`;
  const JUMP = "/subscriptions/s1/resourcegroups/rg-hub/providers/microsoft.compute/virtualmachines/vm-jump";
  const any = tile([rule("legacy-any", [], { fromAny: true })]);
  const namesVm = tile([rule("vm-to-dc", [{ id: VM, kind: "resource", by: ["10.20.1.4"] }])]);
  const namesBastion = tile([rule("bastion-to-dc", [{ id: BAS_SUBNET, kind: "subnet", by: ["10.0.3.0/26"] }])]);
  const overHub = tile([rule("hub-to-dc", [{ id: HUB_VNET, kind: "vnet", by: ["10.0.0.0/16"] }])]);
  const overAzure = tile([rule("azure-to-dns", [{ id: HUB_VNET, kind: "vnet", by: ["10.0.0.0/8"] }, { id: VNET, kind: "vnet", by: ["10.0.0.0/8"] }])]);
  const wideOverWeb = tile([rule("wide", [], { fromWide: true, wideVnets: [VNET] })]);
  const none = new Set();
  for (const t of [any, namesVm, namesBastion, overHub, overAzure, wideOverWeb]) assert.equal(Openings.drawn(t, none, none), false, "nothing picked");
  const hubOnly = new Set([BAS, BAS_SUBNET, HUB_VNET]); // the hub's group picked: its bastion, no sender
  assert.equal(Openings.drawn(any, hubOnly, none), false, 'a "*" rule is not drawn for a bastion');
  assert.equal(Openings.drawn(namesBastion, hubOnly, none), true, "a rule naming the bastion subnet is");
  assert.equal(Openings.drawn(overHub, hubOnly, none), false, "a range over the whole hub VNet is not: it is for the VMs in it");
  assert.equal(Openings.drawn(overAzure, hubOnly, none), false, "nor one over every VNet");
  assert.equal(Openings.drawn(namesVm, hubOnly, none), false);
  const hubVm = new Set([JUMP, JUMP_SUBNET, HUB_VNET]); // a jump VM in the hub picked
  assert.equal(Openings.drawn(overHub, new Set([...hubOnly, ...hubVm]), hubVm), true, "a VM in the hub brings the whole-VNet rules");
  assert.equal(Openings.drawn(overAzure, new Set([...hubOnly, ...hubVm]), hubVm), true);
  const withVm = new Set([...hubOnly, VM, SUBNET, VNET]); // a web VM picked as well
  assert.equal(Openings.drawn(any, withVm, places), true);
  assert.equal(Openings.drawn(namesVm, withVm, places), true);
  assert.equal(Openings.drawn(wideOverWeb, withVm, places), true);
  assert.equal(Openings.drawn(wideOverWeb, new Set([...hubOnly, VM, SUBNET, VNET]), new Set([BAS, BAS_SUBNET, HUB_VNET])), false, "a wide rule counts only against the senders' VNets");
});
