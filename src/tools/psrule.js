// Shared by the Resilience and Resource settings scans: each finding names
// the PSRule for Azure rule it follows (https://azure.github.io/PSRule.Rules.Azure/),
// so the page can link to the rule's "how to fix" page.

// Regions with availability zones (Azure docs, "Azure regions with availability
// zone support", checked October 2026). A zone check is skipped elsewhere,
// since a resource there cannot use zones. Add new regions here.
const ZONE_REGIONS = new Set([
  "australiaeast", "austriaeast", "belgiumcentral", "brazilsouth", "canadacentral", "centralindia", "centralus",
  "chilecentral", "denmarkeast", "eastasia", "eastus", "eastus2", "francecentral", "germanywestcentral",
  "indonesiacentral", "israelcentral", "italynorth", "japaneast", "japanwest", "koreacentral", "malaysiawest",
  "mexicocentral", "newzealandnorth", "northeurope", "norwayeast", "polandcentral", "qatarcentral",
  "southafricanorth", "southcentralus", "southeastasia", "spaincentral", "swedencentral", "switzerlandnorth",
  "uaenorth", "uksouth", "westeurope", "westus2", "westus3", "usgovvirginia",
]);
const hasZones = (location) => ZONE_REGIONS.has(String(location || "").toLowerCase().replace(/\s+/g, ""));

// rule: { name, severity, pillar } as in the PSRule docs.
function ruleFinding(r, kind, area, rule, detail) {
  return {
    kind,
    id: `${r.id}#${kind}`,
    name: r.name,
    resourceGroup: r.resourceGroup,
    subscriptionId: r.subscriptionId,
    area,
    rule,
    detail,
  };
}

// Builds rule objects from "Name|Severity|Pillar" shorthand.
function rules(table) {
  const out = {};
  for (const [key, spec] of Object.entries(table)) {
    const [name, severity, pillar] = spec.split("|");
    out[key] = { name, severity, pillar };
  }
  return out;
}

const zoneList = (z) => (Array.isArray(z) ? z.filter(Boolean).map(String) : []);

module.exports = { ZONE_REGIONS, hasZones, ruleFinding, rules, zoneList };
