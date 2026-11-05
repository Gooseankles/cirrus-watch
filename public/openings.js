// Firewall openings as the Architecture drawing reads them: which of the tiles /api/architecture/openings returns a
// picked place (a VM with its subnet and VNet) can use. Pure functions over that data, shared the way fixes.js is:
// the browser gets the global Openings (loaded before architecture.js), Node gets module.exports (test/openings.test.js).
//
// A tile is one address, name or group the firewall lets through. Each rule on it carries its own Azure side: `from`
// (the VMs, subnets and VNets the rule's source, or its destination for traffic into Azure, names), `fromAny` for a
// "*" source and `fromWide` with `wideVnets` for a range over more VNets than the drawing starts lines at.
const Openings = {
  // The rules on a tile that name one of the places, each with the place it names: [[rule, place], ...].
  rulesNaming(tile, places) {
    return (tile.rules || []).map((x) => [x, (x.from || []).find((f) => places.has(f.id))]).filter(([, f]) => f);
  },
  // Is a rule open to the place as to every Azure address: a "*" source, or a wide range that covers its VNet (an old
  // scan's wide rule names no VNets; it counts as covering, so a tile stays rather than vanishes).
  openToAll(rule, places) {
    if (rule.fromAny) return true;
    if (!rule.fromWide) return false;
    return !Array.isArray(rule.wideVnets) || rule.wideVnets.some((v) => places.has(v));
  },
  // Can the place use the tile: a rule names it, a rule is open to every address, or the tile lists fewer rules than
  // it has and its own union of places names it (or holds more places than it lists). What cannot be checked keeps
  // the tile; only a tile whose every rule is read and names something else goes.
  reaches(tile, places) {
    const rules = tile.rules || [];
    if (Openings.rulesNaming(tile, places).length) return true;
    if (rules.some((x) => Openings.openToAll(x, places))) return true;
    if (!rules.length && tile.fromAny) return true;
    if (tile.ruleCount > rules.length) return (tile.from || []).some((f) => places.has(f.id)) || tile.fromCount > (tile.from || []).length || !!tile.fromAny;
    return false;
  },
};
if (typeof module !== "undefined") module.exports = Openings;
