// Firewall openings as the Architecture drawing reads them: which of the tiles /api/architecture/openings returns
// name what is picked. Pure functions over that data, shared the way fixes.js is: the browser gets the global
// Openings (loaded before architecture.js), Node gets module.exports (test/openings.test.js).
//
// A tile is one address, name or group the firewall lets through. Each rule on it carries its own Azure side: `from`
// (the VMs, subnets and VNets the rule's source, or its destination for traffic into Azure, covers: a "vnet" spot is
// a range over the whole VNet, `own` when it is the VNet's own range rather than a broader one), `fromAny` for a "*"
// source and `fromWide` with `wideVnets` for a range over more VNets than the drawing starts lines at.
const Openings = {
  // Does a spot name its place: an address, a subnet, or a VNet by its own range. A broader range over a VNet
  // (10.0.0.0/8) covers it without naming it.
  names(f) {
    return !!f && (f.kind !== "vnet" || !!f.own);
  },
  // The rules on a tile that name one of the places, each with the place it names: [[rule, place], ...].
  rulesNaming(tile, places) {
    return (tile.rules || []).map((x) => [x, (x.from || []).find((f) => places.has(f.id) && Openings.names(f))]).filter(([, f]) => f);
  },
  // Is a rule open to every Azure address: a "*" source.
  openToAll(rule) {
    return !!(rule && rule.fromAny);
  },
  // Does a rule's source cover the whole VNet without naming a place in it: a range over the VNet (its own or a
  // broader one), or a wide range with the VNet among those it covers (an old scan's wide rule names no VNets; it
  // counts as covering, so a reader is told rather than left out).
  covers(rule, vnet) {
    if (!rule || !vnet) return false;
    if ((rule.from || []).some((f) => f.kind === "vnet" && f.id === vnet)) return true;
    if (!rule.fromWide) return false;
    return !Array.isArray(rule.wideVnets) || rule.wideVnets.includes(vnet);
  },
  // Does the tile name one of the places: a rule names it, a rule is a "*" source (only when `any` is on), or the
  // tile lists fewer rules than it has and its own union of places names it (or holds more places than it lists).
  // What cannot be checked keeps the tile; only a tile whose every rule is read and names something else goes.
  reaches(tile, places, any = true) {
    const rules = tile.rules || [];
    if (Openings.rulesNaming(tile, places).length) return true;
    if (any && rules.some((x) => Openings.openToAll(x))) return true;
    if (any && !rules.length && tile.fromAny) return true;
    if (tile.ruleCount > rules.length) return (tile.from || []).some((f) => places.has(f.id) && Openings.names(f)) || tile.fromCount > (tile.from || []).length || (any && !!tile.fromAny);
    return false;
  },
  // A resource that sends its own traffic through the firewall: in a subnet, not a network part (the firewall and
  // gateways, a bastion, a private endpoint, a load balancer, an application gateway) and not a firewall VM. The "*"
  // rules are drawn for these only; a network part alone brings just the rules that name its address or its subnet.
  sender(r) {
    return !!(r && r.subnet && r.t && r.t.cat !== "network" && !r.appliance);
  },
  // Is the tile drawn: `named` holds the places everything picked stands for (a resource and its subnet; a VNet picked
  // whole, with its subnets), `sender` whether something picked sends its own traffic. A rule naming a picked place
  // keeps the tile; a "*" rule keeps it when a sender is picked. A rule over a picked VM's whole VNet, or a wider
  // range, names the VNet and not the VM: it is drawn when the VNet is picked. Nothing picked, nothing.
  drawn(tile, named, sender) {
    return Openings.reaches(tile, named, !!sender);
  },
};
if (typeof module !== "undefined") module.exports = Openings;
