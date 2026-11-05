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
