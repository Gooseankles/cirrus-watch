// Azure news: what Microsoft announces for Azure (new and generally
// available features, previews, retirements) from the public Azure Updates
// feed (src/releaseFeeds.js), with the updates about services the tenant uses
// marked "in use". For information: no findings.
//
// "In use" is a plain lookup: each update names its products ("App Service",
// "Azure Kubernetes Service (AKS)"); PRODUCT_TYPES below maps a product name to
// the Azure resource types it means, and an update is in use when one of its
// products maps to a type the tenant has in the resource list the Architecture
// scan saves (architecture/inventory.json, every resource with its type).
// Products not in the table are never marked; nothing is guessed from titles.
// No Architecture scan yet = "in use" unknown for that tenant.
const store = require("../findingsStore");
const tenants = require("../tenants");
const feeds = require("../releaseFeeds");

const TOOL_ID = "azure-updates";
const IN_USE_KEY = "azure-updates/in-use.json";
const INVENTORY_KEY = "architecture/inventory.json"; // saved by the Architecture scan

// Product name (lower case, as Azure Updates writes it) -> resource types. A type ending in "/" matches every type
// under that provider; "type#word" matches only resources of that type whose kind contains the word.
const STORAGE = ["microsoft.storage/storageaccounts"];
const VMS = ["microsoft.compute/virtualmachines"];
const PRODUCT_TYPES = {
  "virtual machines": VMS,
  "linux virtual machines": VMS,
  "windows virtual machines": VMS,
  "virtual machine scale sets": ["microsoft.compute/virtualmachinescalesets"],
  "azure disk storage": ["microsoft.compute/disks"],
  "sql server on azure virtual machines": ["microsoft.sqlvirtualmachine/sqlvirtualmachines"],
  "azure kubernetes service (aks)": ["microsoft.containerservice/managedclusters"],
  "azure kubernetes fleet manager": ["microsoft.containerservice/fleets"],
  "azure container apps": ["microsoft.app/containerapps", "microsoft.app/managedenvironments"],
  "azure container registry": ["microsoft.containerregistry/registries"],
  "azure container instances": ["microsoft.containerinstance/containergroups"],
  "app service": ["microsoft.web/sites", "microsoft.web/serverfarms"],
  "azure functions": ["microsoft.web/sites#functionapp"],
  "azure static web apps": ["microsoft.web/staticsites"],
  "azure spring apps": ["microsoft.appplatform/spring"],
  "azure sql database": ["microsoft.sql/servers"],
  "azure sql": ["microsoft.sql/servers", "microsoft.sql/managedinstances"],
  "azure sql managed instance": ["microsoft.sql/managedinstances"],
  "azure database for postgresql": ["microsoft.dbforpostgresql/"],
  "azure database for mysql": ["microsoft.dbformysql/"],
  "azure cosmos db": ["microsoft.documentdb/"],
  "azure cache for redis": ["microsoft.cache/redis", "microsoft.cache/redisenterprise"],
  "storage accounts": STORAGE,
  "azure blob storage": STORAGE,
  "azure files": STORAGE,
  "queue storage": STORAGE,
  "table storage": STORAGE,
  "archive storage": STORAGE,
  "azure data lake storage": STORAGE,
  "azure netapp files": ["microsoft.netapp/"],
  "azure elastic san": ["microsoft.elasticsan/"],
  "key vault": ["microsoft.keyvault/vaults"],
  "azure key vault": ["microsoft.keyvault/vaults"],
  "azure key vault managed hsm": ["microsoft.keyvault/managedhsms"],
  "virtual network": ["microsoft.network/virtualnetworks"],
  "azure firewall": ["microsoft.network/azurefirewalls", "microsoft.network/firewallpolicies"],
  "azure firewall manager": ["microsoft.network/firewallpolicies"],
  "application gateway": ["microsoft.network/applicationgateways"],
  "web application firewall": ["microsoft.network/applicationgatewaywebapplicationfirewallpolicies", "microsoft.network/frontdoorwebapplicationfirewallpolicies"],
  "azure front door": ["microsoft.cdn/profiles", "microsoft.network/frontdoors"],
  "content delivery network": ["microsoft.cdn/profiles"],
  "load balancer": ["microsoft.network/loadbalancers"],
  "azure load balancer": ["microsoft.network/loadbalancers"],
  "azure nat gateway": ["microsoft.network/natgateways"],
  "vpn gateway": ["microsoft.network/virtualnetworkgateways", "microsoft.network/vpngateways"],
  "azure vpn gateway": ["microsoft.network/virtualnetworkgateways", "microsoft.network/vpngateways"],
  "azure expressroute": ["microsoft.network/expressroutecircuits"],
  expressroute: ["microsoft.network/expressroutecircuits"],
  "azure bastion": ["microsoft.network/bastionhosts"],
  "virtual wan": ["microsoft.network/virtualwans"],
  "azure virtual wan": ["microsoft.network/virtualwans"],
  "azure dns": ["microsoft.network/dnszones", "microsoft.network/privatednszones"],
  "azure private link": ["microsoft.network/privateendpoints"],
  "traffic manager": ["microsoft.network/trafficmanagerprofiles"],
  "network watcher": ["microsoft.network/networkwatchers"],
  "azure ddos protection": ["microsoft.network/ddosprotectionplans"],
  "api management": ["microsoft.apimanagement/service"],
  "azure monitor": ["microsoft.operationalinsights/workspaces", "microsoft.insights/components"],
  "log analytics": ["microsoft.operationalinsights/workspaces"],
  "application insights": ["microsoft.insights/components"],
  "azure managed grafana": ["microsoft.dashboard/grafana"],
  "azure backup": ["microsoft.recoveryservices/vaults", "microsoft.dataprotection/backupvaults"],
  "azure site recovery": ["microsoft.recoveryservices/vaults"],
  automation: ["microsoft.automation/automationaccounts"],
  "azure logic apps": ["microsoft.logic/workflows", "microsoft.web/sites#workflowapp"],
  "logic apps": ["microsoft.logic/workflows", "microsoft.web/sites#workflowapp"],
  "service bus": ["microsoft.servicebus/namespaces"],
  "azure service bus": ["microsoft.servicebus/namespaces"],
  "event hubs": ["microsoft.eventhub/namespaces"],
  "azure event hubs": ["microsoft.eventhub/namespaces"],
  "event grid": ["microsoft.eventgrid/"],
  "azure event grid": ["microsoft.eventgrid/"],
  "azure signalr service": ["microsoft.signalrservice/signalr"],
  "azure communication services": ["microsoft.communication/communicationservices"],
  "azure databricks": ["microsoft.databricks/workspaces"],
  "azure data factory": ["microsoft.datafactory/factories"],
  "azure synapse analytics": ["microsoft.synapse/workspaces"],
  "azure data explorer": ["microsoft.kusto/clusters"],
  "azure stream analytics": ["microsoft.streamanalytics/streamingjobs"],
  hdinsight: ["microsoft.hdinsight/clusters"],
  "azure machine learning": ["microsoft.machinelearningservices/workspaces"],
  "microsoft foundry": ["microsoft.cognitiveservices/accounts"],
  "azure openai service": ["microsoft.cognitiveservices/accounts#openai"],
  "azure ai search": ["microsoft.search/searchservices"],
  "azure virtual desktop": ["microsoft.desktopvirtualization/"],
  "microsoft dev box": ["microsoft.devcenter/"],
  "azure deployment environments": ["microsoft.devcenter/"],
  "azure load testing": ["microsoft.loadtestservice/"],
  batch: ["microsoft.batch/batchaccounts"],
  "azure arc": ["microsoft.hybridcompute/machines"],
  "cloud services": ["microsoft.classiccompute/domainnames", "microsoft.compute/cloudservices"],
  "azure maps": ["microsoft.maps/accounts"],
  "azure iot hub": ["microsoft.devices/iothubs"],
  "iot hub": ["microsoft.devices/iothubs"],
};

const low = (s) => String(s || "").toLowerCase();

// The tenant's resources as { type -> [kinds] }, from the Architecture scan's saved list.
function typesOf(resources) {
  const out = new Map();
  for (const r of Array.isArray(resources) ? resources : []) {
    const t = low(r && r.type);
    if (!t) continue;
    if (!out.has(t)) out.set(t, []);
    if (r.kind) out.get(t).push(low(r.kind));
  }
  return out;
}

// Does the tenant have something this rule ("type", "provider/" or "type#word") names?
function ruleHit(rule, present) {
  const [type, word] = rule.split("#");
  if (type.endsWith("/")) return [...present.keys()].some((t) => t.startsWith(type));
  const kinds = present.get(type);
  if (!kinds) return false;
  return !word || kinds.some((k) => k.includes(word));
}

// The products of an update that the tenant uses.
function productsInUse(products, present) {
  return (products || []).filter((p) => (PRODUCT_TYPES[low(p).trim()] || []).some((rule) => ruleHit(rule, present)));
}

// { itemId: [products in use] } for every update that touches the tenant's resources.
function inUseMap(items, resources) {
  const present = typesOf(resources);
  const out = {};
  if (!present.size) return out;
  for (const it of items) {
    const hit = productsInUse(it.products, present);
    if (hit.length) out[it.id] = hit;
  }
  return out;
}

async function run() {
  const feed = await feeds.load("azure");
  if (!feed.items.length && feed.source === "none" && !/turned off/.test(feed.note)) throw new Error(feed.note || "no Azure news");
  let inv = null;
  try {
    inv = await store.getDoc(INVENTORY_KEY);
  } catch {
    inv = null;
  }
  await store.putDoc(IN_USE_KEY, {
    updatedAt: new Date().toISOString(),
    inventoryAt: (inv && inv.updatedAt) || null,
    resources: inv && Array.isArray(inv.resources) ? inv.resources.length : 0,
    inUse: inv ? inUseMap(feed.items, inv.resources) : {},
  });
  return [];
}

/* ---------- read route ---------- */

// The kept feed with "in use" merged over the tenants this person may see.
async function view(keys) {
  const feed = feeds.kept("azure");
  const inUse = new Map(); // id -> { products: Set, tenants: Set }
  const unknown = [];
  let checked = 0;
  for (const k of keys) {
    let doc = null;
    try {
      doc = await store.getDoc(IN_USE_KEY, k);
    } catch {
      doc = null;
    }
    if (!doc || !doc.inventoryAt) {
      unknown.push(tenants.nameOf(k));
      continue;
    }
    checked++;
    for (const [id, products] of Object.entries(doc.inUse || {})) {
      if (!inUse.has(id)) inUse.set(id, { products: new Set(), tenants: new Set() });
      for (const p of products) inUse.get(id).products.add(p);
      inUse.get(id).tenants.add(tenants.nameOf(k));
    }
  }
  const items = feed.items.map((it) => {
    const u = inUse.get(it.id);
    return u ? { ...it, inUse: [...u.products], ...(keys.length > 1 && { inUseTenants: [...u.tenants] }) } : it;
  });
  return { fetchedAt: feed.fetchedAt, note: feed.note, days: feeds.AZURE_DAYS, items, inUseChecked: checked, inUseUnknown: unknown };
}

function registerRoutes(app, { readKeys }) {
  app.get("/api/azure-updates", async (req, res) => {
    try {
      const keys = readKeys(req);
      if (!keys.length) return res.status(403).json({ error: "needs a role that can see this scan" });
      res.json(await view(keys));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Azure news",
  schedule: "10 5 * * *", // daily at 05:10
  info: true,
  run,
  registerRoutes,
  _test: { PRODUCT_TYPES, typesOf, ruleHit, productsInUse, inUseMap },
};
