// Firewall openings as the Architecture drawing reads them: which of the tiles /api/architecture/openings returns a
// picked place (a VM with its subnet and VNet) can use. Pure functions over that data, shared the way fixes.js is:
// the browser gets the global Openings (loaded before architecture.js), Node gets module.exports (test/openings.test.js).
//
// A tile is one address, name or group the firewall lets through. Each rule on it carries its own Azure side: `from`
// (the VMs, subnets and VNets the rule's source, or its destination for traffic into Azure, names: a "vnet" spot is a
// range over the whole VNet, the VNet's own or a broader one), `fromAny` for a "*" source and `fromWide` with
// `wideVnets` for a range over more VNets than the drawing starts lines at.
const Openings = {
  // The rules on a tile that name one of the places, each with the place it names: [[rule, place], ...]. With `vnets`
  // off, a range over a whole VNet does not count as naming it: only an address or a subnet does.
  rulesNaming(tile, places, vnets = true) {
    return (tile.rules || []).map((x) => [x, (x.from || []).find((f) => places.has(f.id) && (vnets || f.kind !== "vnet"))]).filter(([, f]) => f);
  },
  // Is a rule open to the place as to every Azure address: a "*" source, or a wide range that covers its VNet (an old
  // scan's wide rule names no VNets; it counts as covering, so a tile stays rather than vanishes).
  openToAll(rule, places) {
    if (rule.fromAny) return true;
    if (!rule.fromWide) return false;
    return !Array.isArray(rule.wideVnets) || rule.wideVnets.some((v) => places.has(v));
  },
  // Can the place use the tile: a rule names it, a rule is open to it as to every address (only when `any` is on: a
  // "*" source, a wide range, or a range over its whole VNet), or the tile lists fewer rules than it has and its own
  // union of places names it (or holds more places than it lists). What cannot be checked keeps the tile; only a tile
  // whose every rule is read and names something else goes.
  reaches(tile, places, any = true) {
    const rules = tile.rules || [];
    if (Openings.rulesNaming(tile, places, any).length) return true;
    if (any && rules.some((x) => Openings.openToAll(x, places))) return true;
    if (any && !rules.length && tile.fromAny) return true;
    if (tile.ruleCount > rules.length) return (tile.from || []).some((f) => places.has(f.id) && (any || f.kind !== "vnet")) || tile.fromCount > (tile.from || []).length || (any && !!tile.fromAny);
    return false;
  },
  // A resource that sends its own traffic through the firewall: in a subnet, not a network part (the firewall and
  // gateways, a bastion, a private endpoint, a load balancer, an application gateway) and not a firewall VM. Rules
  // open to every Azure address, or to its whole VNet, are drawn for these only; a network part alone brings just the
  // rules that name its address or its subnet.
  sender(r) {
    return !!(r && r.subnet && r.t && r.t.cat !== "network" && !r.appliance);
  },
  // Is the tile drawn: `named` holds the places everything picked stands for (a resource, its subnet, and the subnets
  // of the VNets picked whole), `senders` those of the picked resources that send their own traffic, with their VNets.
  // A rule naming a picked address or subnet keeps the tile; one over a sender's whole VNet or open to every address
  // keeps it when that sender is picked. Nothing picked, nothing.
  drawn(tile, named, senders) {
    return Openings.reaches(tile, named, false) || (senders.size > 0 && Openings.reaches(tile, senders, true));
  },
};
if (typeof module !== "undefined") module.exports = Openings;
