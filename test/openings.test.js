// The drawing's reading of the firewall openings (public/openings.js): with something picked, which tiles stay.
const { test } = require("node:test");
const assert = require("node:assert/strict");

const Openings = require("../public/openings.js");

const VNET = "/subscriptions/s1/resourcegroups/rg-net/providers/microsoft.network/virtualnetworks/vnet-web";
const SUBNET = `${VNET}/subnets/snet-web`;
const VM = "/subscriptions/s1/resourcegroups/rg-web/providers/microsoft.compute/virtualmachines/vm-web-01";
const OTHER_SUBNET = "/subscriptions/s1/resourcegroups/rg-net/providers/microsoft.network/virtualnetworks/vnet-data/subnets/snet-sql";
const OTHER_VNET = "/subscriptions/s1/resourcegroups/rg-net/providers/microsoft.network/virtualnetworks/vnet-data";
const mine = new Set([VM, SUBNET]); // a picked VM: itself and its subnet
const wholeVnet = new Set([VNET, SUBNET, OTHER_SUBNET.replace(OTHER_VNET, VNET)]); // the VNet picked through its group

const rule = (name, from, extra = {}) => ({ name, from, fromCount: from.length, fromAny: false, fromWide: false, ...extra });
const tile = (rules, extra = {}) => ({ label: "10.0.109.10", rules, ruleCount: rules.length, from: [], fromCount: 0, fromAny: false, fromWide: false, ...extra });
const byAddress = () => tile([rule("vm-to-dc", [{ id: VM, kind: "resource", name: "vm-web-01", ip: "10.20.1.4", by: ["10.20.1.4"] }])]);
const bySubnet = () => tile([rule("web-to-dc", [{ id: SUBNET, kind: "subnet", by: ["10.20.1.0/24"] }])]);
const byOwnVnet = () => tile([rule("vnet-to-dc", [{ id: VNET, kind: "vnet", own: true, by: ["10.20.0.0/16"] }])]);
const byWiderRange = () => tile([rule("all-to-dc", [{ id: VNET, kind: "vnet", by: ["10.0.0.0/8"] }, { id: OTHER_VNET, kind: "vnet", by: ["10.0.0.0/8"] }])]);
const elsewhere = () => tile([rule("dc-to-sql", [{ id: OTHER_SUBNET, kind: "subnet", by: ["10.30.1.0/24"] }])]);
const star = () => tile([rule("legacy-any", [], { fromAny: true })]);
const wide = (vnets) => tile([rule("wide", [], { fromWide: true, ...(vnets && { wideVnets: vnets }) })]);

test("a rule names a VM by its address or its subnet; one over its whole VNet, a wider range or another subnet does not", () => {
  assert.equal(Openings.reaches(byAddress(), mine, false), true);
  assert.equal(Openings.reaches(bySubnet(), mine, false), true);
  assert.equal(Openings.reaches(byOwnVnet(), mine, false), false, "the VNet's own range names the VNet, not the VM");
  assert.equal(Openings.reaches(byOwnVnet(), mine, true), false, "also with the \"*\" rules on");
  assert.equal(Openings.reaches(byWiderRange(), mine, true), false, "10.0.0.0/8 over a few VNets covers the VM without naming it");
  assert.equal(Openings.reaches(elsewhere(), mine, true), false);
  assert.deepEqual(
    Openings.rulesNaming(byAddress(), mine).map(([x, f]) => [x.name, f.id]),
    [["vm-to-dc", VM]]
  );
  assert.deepEqual(Openings.rulesNaming(byOwnVnet(), mine), []);
  assert.deepEqual(Openings.rulesNaming(elsewhere(), mine), []);
});

test("a VNet picked whole is named by its own range and by its subnets, not by a wider range over it", () => {
  assert.equal(Openings.reaches(byOwnVnet(), wholeVnet, false), true);
  assert.equal(Openings.reaches(bySubnet(), wholeVnet, false), true);
  assert.equal(Openings.reaches(byWiderRange(), wholeVnet, false), false, "a rule written for the whole network is not one written for this VNet");
  assert.equal(Openings.reaches(byAddress(), wholeVnet, false), false, "a VM's address is the VM's, not the VNet's");
  assert.equal(Openings.names({ id: VNET, kind: "vnet", own: true }), true);
  assert.equal(Openings.names({ id: VNET, kind: "vnet" }), false, "an old scan's VNet spot, or a broader range, does not name");
  assert.equal(Openings.names({ id: SUBNET, kind: "subnet" }), true);
  assert.equal(Openings.names(null), false);
});

test("a tile mixing another subnet's rule with one naming the VM stays, and only the VM's rule names it", () => {
  const t = tile([rule("dc-to-sql", [{ id: OTHER_SUBNET, kind: "subnet", by: ["10.30.1.0/24"] }]), rule("vm-to-dc", [{ id: VM, kind: "resource", name: "vm-web-01", by: ["10.20.1.4"] }])]);
  assert.equal(Openings.reaches(t, mine, false), true);
  assert.deepEqual(
    Openings.rulesNaming(t, mine).map(([x]) => x.name),
    ["vm-to-dc"]
  );
});

test('a "*" source is open to every place, and counts only when asked; a wide range is not open to all', () => {
  assert.equal(Openings.reaches(star(), mine, true), true);
  assert.equal(Openings.reaches(star(), mine, false), false);
  assert.equal(Openings.reaches(star(), mine), true, "on by default, as the picked-VM filter uses it");
  assert.equal(Openings.reaches(wide([VNET]), mine, true), false, "a wide range covers the VM's VNet but names nothing");
  assert.equal(Openings.reaches(wide(), mine, true), false);
  assert.equal(Openings.openToAll(star().rules[0]), true);
  assert.equal(Openings.openToAll(wide([VNET]).rules[0]), false);
  assert.equal(Openings.openToAll(rule("plain", [{ id: VM, kind: "resource" }])), false);
  assert.equal(Openings.openToAll(null), false);
});

test("covers: a rule over the VNet's own range, a wider range or a wide one with the VNet among those it covers", () => {
  assert.equal(Openings.covers(byOwnVnet().rules[0], VNET), true);
  assert.equal(Openings.covers(byWiderRange().rules[0], VNET), true);
  assert.equal(Openings.covers(byWiderRange().rules[0], OTHER_VNET), true);
  assert.equal(Openings.covers(wide([OTHER_VNET, VNET]).rules[0], VNET), true);
  assert.equal(Openings.covers(wide([OTHER_VNET]).rules[0], VNET), false);
  assert.equal(Openings.covers(wide().rules[0], VNET), true, "a wide rule from before wideVnets existed counts as covering");
  assert.equal(Openings.covers(bySubnet().rules[0], VNET), false, "a subnet's rule names the subnet; it does not cover the VNet");
  assert.equal(Openings.covers(star().rules[0], VNET), false, 'a "*" rule is open to all, not a range');
  assert.equal(Openings.covers(byOwnVnet().rules[0], ""), false);
});

test("a tile with more rules than it lists falls back to its union of places, and keeps what it cannot check", () => {
  const listed = [rule("dc-to-sql", [{ id: OTHER_SUBNET, kind: "subnet", by: ["10.30.1.0/24"] }])];
  const unionNamesMe = tile(listed, { ruleCount: 20, from: [{ id: OTHER_SUBNET, kind: "subnet" }, { id: SUBNET, kind: "subnet" }], fromCount: 2 });
  const unionOwnVnet = tile(listed, { ruleCount: 20, from: [{ id: VNET, kind: "vnet", own: true }], fromCount: 1 });
  const unionWider = tile(listed, { ruleCount: 20, from: [{ id: VNET, kind: "vnet" }], fromCount: 1 });
  const unionElsewhere = tile(listed, { ruleCount: 20, from: [{ id: OTHER_SUBNET, kind: "subnet" }], fromCount: 1 });
  const unionCut = tile(listed, { ruleCount: 20, from: [{ id: OTHER_SUBNET, kind: "subnet" }], fromCount: 30 });
  const unionAny = tile(listed, { ruleCount: 20, from: [{ id: OTHER_SUBNET, kind: "subnet" }], fromCount: 1, fromAny: true });
  const unionWide = tile(listed, { ruleCount: 20, from: [{ id: OTHER_SUBNET, kind: "subnet" }], fromCount: 1, fromWide: true });
  assert.equal(Openings.reaches(unionNamesMe, mine, false), true);
  assert.equal(Openings.reaches(unionOwnVnet, mine, true), false, "the VNet's own range in the union names the VNet, not the VM");
  assert.equal(Openings.reaches(unionOwnVnet, wholeVnet, false), true);
  assert.equal(Openings.reaches(unionWider, wholeVnet, false), false);
  assert.equal(Openings.reaches(unionElsewhere, mine, true), false);
  assert.equal(Openings.reaches(unionCut, mine, false), true, "places the tile did not list might be mine");
  assert.equal(Openings.reaches(unionAny, mine, true), true);
  assert.equal(Openings.reaches(unionAny, mine, false), false);
  assert.equal(Openings.reaches(unionWide, mine, true), false, "a wide rule among the unlisted ones names nothing");
  assert.equal(Openings.reaches(tile([], { ruleCount: 0 }), mine, true), false, "a tile without rules names nothing");
  assert.equal(Openings.reaches(tile([], { ruleCount: 0, fromAny: true }), mine, true), true);
  assert.equal(Openings.reaches(tile([], { ruleCount: 0, fromAny: true }), mine, false), false);
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

test('drawn: nothing picked draws nothing; a hub picked whole brings the rules naming it; a VM brings those naming it and the "*" ones, not its VNet\'s', () => {
  const HUB_VNET = "/subscriptions/s1/resourcegroups/rg-hub/providers/microsoft.network/virtualnetworks/vnet-hub";
  const BAS_SUBNET = `${HUB_VNET}/subnets/azurebastionsubnet`;
  const BAS = "/subscriptions/s1/resourcegroups/rg-hub/providers/microsoft.network/bastionhosts/bas-hub";
  const JUMP_SUBNET = `${HUB_VNET}/subnets/snet-jump`;
  const JUMP = "/subscriptions/s1/resourcegroups/rg-hub/providers/microsoft.compute/virtualmachines/vm-jump";
  const any = star();
  const namesVm = byAddress();
  const namesBastion = tile([rule("bastion-to-dc", [{ id: BAS_SUBNET, kind: "subnet", by: ["10.0.3.0/26"] }])]);
  const forHub = tile([rule("hub-to-dc", [{ id: HUB_VNET, kind: "vnet", own: true, by: ["10.0.0.0/16"] }])]);
  const overAzure = tile([rule("azure-to-dns", [{ id: HUB_VNET, kind: "vnet", by: ["10.0.0.0/8"] }, { id: VNET, kind: "vnet", by: ["10.0.0.0/8"] }])]);
  const forWeb = byOwnVnet();
  const wideOverWeb = wide([VNET]);
  const none = new Set();
  for (const t of [any, namesVm, namesBastion, forHub, overAzure, forWeb, wideOverWeb]) assert.equal(Openings.drawn(t, none, false), false, "nothing picked");
  const hubOnly = new Set([HUB_VNET, BAS_SUBNET, JUMP_SUBNET, BAS]); // the hub's group picked: its VNet whole, its bastion, no sender
  assert.equal(Openings.drawn(any, hubOnly, false), false, 'a "*" rule is not drawn for a bastion');
  assert.equal(Openings.drawn(namesBastion, hubOnly, false), true, "a rule naming the bastion subnet is");
  assert.equal(Openings.drawn(forHub, hubOnly, false), true, "a rule written for the hub VNet is: the VNet is picked whole");
  assert.equal(Openings.drawn(overAzure, hubOnly, false), false, "one over every VNet is not");
  assert.equal(Openings.drawn(namesVm, hubOnly, false), false);
  assert.equal(Openings.drawn(forWeb, hubOnly, false), false);
  const hubAndJump = new Set([...hubOnly, JUMP]); // a jump VM in the hub picked as well
  assert.equal(Openings.drawn(any, hubAndJump, true), true, 'a VM brings the "*" rules');
  assert.equal(Openings.drawn(forHub, hubAndJump, true), true);
  assert.equal(Openings.drawn(overAzure, hubAndJump, true), false, "a VM does not bring the rules over the whole network");
  const vmOnly = new Set([VM, SUBNET]); // a web VM picked from its group, its VNet not
  assert.equal(Openings.drawn(namesVm, vmOnly, true), true);
  assert.equal(Openings.drawn(any, vmOnly, true), true);
  assert.equal(Openings.drawn(forWeb, vmOnly, true), false, "a rule written for the VM's whole VNet names the VNet; pick the VNet for it");
  assert.equal(Openings.drawn(wideOverWeb, vmOnly, true), false);
  assert.equal(Openings.drawn(overAzure, vmOnly, true), false);
  assert.equal(Openings.drawn(forWeb, new Set([...vmOnly, VNET]), true), true, "the VM and its VNet picked: the VNet's rules come along");
});
