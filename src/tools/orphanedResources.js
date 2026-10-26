const { resourceGraphQuery, subscriptionIdsToScan } = require("../armClient");
const { runChecks, mapLimit } = require("./util");
const prices = require("../retailPrices");
const log = require("../log");
const store = require("../findingsStore");
const tenantContext = require("../tenantContext");

const TOOL_ID = "orphaned-resources";
const PRICE_CONCURRENCY = 4;

// Each finding: { kind, id, name, resourceGroup, subscriptionId, location, detail, monthlyCost, currency }.
// monthlyCost is Azure's list price for the region, tier and redundancy (Retail Prices API), null when no price
// was found; discounts and reservations are not in it.

// Managed disks are billed per tier, by the provisioned size rounded up to the tier's size.
const TIER_SIZES = [
  [4, 1], [8, 2], [16, 3], [32, 4], [64, 6], [128, 10], [256, 15], [512, 20],
  [1024, 30], [2048, 40], [4096, 50], [8192, 60], [16384, 70], [32767, 80],
];
const DISK_TYPES = {
  standard: { prefix: "S", product: "Standard HDD Managed Disks", label: "Standard HDD", minTier: 4 },
  standardssd: { prefix: "E", product: "Standard SSD Managed Disks", label: "Standard SSD", minTier: 1 },
  premium: { prefix: "P", product: "Premium SSD Managed Disks", label: "Premium SSD", minTier: 1 },
  premiumv2: { label: "Premium SSD v2" },
  ultrassd: { label: "Ultra Disk" },
};

// "Premium_ZRS" -> { type, redundancy: "ZRS" }
function diskSku(skuName) {
  const [type, red] = String(skuName || "").toLowerCase().split("_");
  return { type: DISK_TYPES[type] ? type : null, redundancy: (red || "lrs").toUpperCase() };
}

// The billed tier ("P10") of a disk: from its size, or its performance tier when that is set higher (Premium).
function diskTier(sizeGb, skuName, perfTier) {
  const { type } = diskSku(skuName);
  const t = type && DISK_TYPES[type];
  if (!t || !t.prefix) return null;
  const n = Number(sizeGb) || 0;
  const bySize = TIER_SIZES.find(([gb, tier]) => gb >= n && tier >= t.minTier) || TIER_SIZES[TIER_SIZES.length - 1];
  let tier = bySize[1];
  const m = String(perfTier || "").match(/^([PES])(\d+)$/i);
  if (m && m[1].toUpperCase() === t.prefix && Number(m[2]) > tier) tier = Number(m[2]);
  return `${t.prefix}${tier}`;
}

// Price lookups, each one remembered for the run: key -> Promise<number|null>.
function priceBook() {
  const seen = new Map();
  const failures = [];
  const get = (key, fn) => {
    if (!seen.has(key))
      seen.set(
        key,
        fn().catch((err) => {
          failures.push(err.message);
          return null;
        })
      );
    return seen.get(key);
  };
  return { get, failures };
}

function diskPrice(book, r) {
  const { type, redundancy } = diskSku(r.sku);
  const t = type && DISK_TYPES[type];
  const tier = diskTier(r.sizeGb, r.sku, r.tier);
  if (!t || !t.product || !tier || !r.location) return Promise.resolve(null);
  const skuName = `${tier} ${redundancy}`;
  return book.get(`disk|${r.location}|${skuName}`, async () => {
    const items = await prices.query(`serviceName eq 'Storage' and armRegionName eq ${prices.lit(r.location)} and productName eq ${prices.lit(t.product)} and skuName eq ${prices.lit(skuName)}`);
    return prices.monthly(items.find((i) => i.meterName === `${skuName} Disk`));
  });
}

function diskDescription(r) {
  const { type, redundancy } = diskSku(r.sku);
  const t = type ? DISK_TYPES[type] : null;
  const tier = diskTier(r.sizeGb, r.sku, r.tier);
  return `${r.sizeGb} GB ${t ? t.label : r.sku}${tier ? ` (${tier}, ${redundancy})` : ` (${redundancy})`}`;
}

const costText = (cost, cur, what) =>
  cost == null ? `no list price found${what ? " for " + what : ""}` : cost === 0 ? "no charge while unattached" : `about ${Math.round(cost).toLocaleString("en-US")} ${cur} a month at list price`;

async function unattachedDisks(book) {
  const rows = await resourceGraphQuery(
    `
    Resources
    | where type == 'microsoft.compute/disks' and properties.diskState == 'Unattached'
    | project id, name, resourceGroup, subscriptionId, location, sizeGb = toint(properties.diskSizeGB), sku = tostring(sku.name),
        tier = tostring(properties.tier), since = tostring(properties.LastOwnershipUpdateTime), created = tostring(properties.timeCreated)
  `,
    { toolId: TOOL_ID }
  );
  const cur = prices.currency();
  const out = [];
  await mapLimit(rows, PRICE_CONCURRENCY, async (r) => {
    const { type } = diskSku(r.sku);
    const special = type === "premiumv2" || type === "ultrassd";
    const cost = special ? null : await diskPrice(book, r);
    out.push({
      kind: "unattached-disk",
      id: r.id,
      name: r.name,
      resourceGroup: r.resourceGroup,
      subscriptionId: r.subscriptionId,
      location: r.location,
      monthlyCost: cost,
      currency: cur,
      detail: `${diskDescription(r)}, ${r.location}; ${special ? "billed for capacity, IOPS and throughput even when unattached (not estimated)" : costText(cost, cur, "this tier")}${r.since ? `; unattached since ${r.since.slice(0, 10)}` : r.created ? `; created ${r.created.slice(0, 10)}` : ""}`,
    });
  });
  return out;
}

// A NAT gateway's public IP has no ipConfiguration but is in use.
async function unusedPublicIps(book) {
  const rows = await resourceGraphQuery(
    `
    Resources
    | where type == 'microsoft.network/publicipaddresses' and isnull(properties.ipConfiguration) and isnull(properties.natGateway)
    | project id, name, resourceGroup, subscriptionId, location, allocation = tostring(properties.publicIPAllocationMethod),
        sku = tostring(sku.name), skuTier = tostring(sku.tier), version = tostring(properties.publicIPAddressVersion), ip = tostring(properties.ipAddress)
  `,
    { toolId: TOOL_ID }
  );
  const cur = prices.currency();
  const out = [];
  await mapLimit(rows, PRICE_CONCURRENCY, async (r) => {
    const sku = r.skuTier === "Global" ? "Global" : r.sku || "Basic";
    const version = /ipv6/i.test(r.version) ? "IPv6" : "IPv4";
    // A dynamic Basic address holds no IP while unattached and is not billed.
    const free = sku === "Basic" && /dynamic/i.test(r.allocation);
    const meter = `${sku} ${version} Static Public IP`;
    const cost = free
      ? 0
      : await book.get(`ip|${r.location}|${meter}`, async () => {
          const items = await prices.query(`serviceName eq 'Virtual Network' and armRegionName eq ${prices.lit(r.location)} and productName eq 'IP Addresses'`);
          return prices.monthly(items.find((i) => i.meterName === meter));
        });
    out.push({
      kind: "unused-public-ip",
      id: r.id,
      name: r.name,
      resourceGroup: r.resourceGroup,
      subscriptionId: r.subscriptionId,
      location: r.location,
      monthlyCost: cost,
      currency: cur,
      detail: `${sku} ${version}, ${r.allocation || "?"}${r.ip ? ` ${r.ip}` : ""}, ${r.location}; ${costText(cost, cur)}`,
    });
  });
  return out;
}

// Private endpoints and private link services own NICs with no VM.
async function orphanedNics() {
  const rows = await resourceGraphQuery(
    `
    Resources
    | where type == 'microsoft.network/networkinterfaces' and isnull(properties.virtualMachine)
    | where isnull(properties.privateEndpoint) and isnull(properties.privateLinkService)
    | project id, name, resourceGroup, subscriptionId, location
  `,
    { toolId: TOOL_ID }
  );
  return rows.map((r) => ({
    kind: "orphaned-nic",
    id: r.id,
    name: r.name,
    resourceGroup: r.resourceGroup,
    subscriptionId: r.subscriptionId,
    location: r.location,
    monthlyCost: 0,
    detail: "not attached to any VM; no charge, only clutter",
  }));
}

// Resources may spell their group's name in another case than the group
// itself, so both sides are matched in lower case.
async function emptyResourceGroups() {
  const rows = await resourceGraphQuery(
    `
    ResourceContainers
    | where type == 'microsoft.resources/subscriptions/resourcegroups'
    | extend rg = tolower(name)
    | join kind=leftouter (
        Resources | summarize resourceCount = count() by rg = tolower(resourceGroup), subscriptionId
      ) on rg, subscriptionId
    | where isnull(resourceCount) or resourceCount == 0
    | project id, name, subscriptionId
  `,
    { toolId: TOOL_ID }
  );
  return rows.map((r) => ({
    kind: "empty-resource-group",
    id: r.id,
    name: r.name,
    resourceGroup: r.name,
    subscriptionId: r.subscriptionId,
    detail: "no resources",
  }));
}

// Snapshots whose source disk is gone. Only sources in a scanned subscription are judged (a disk elsewhere may exist).
const SNAPSHOT_PRODUCTS = { standard: "Standard HDD Managed Disks", premium: "Premium SSD Managed Disks" };
async function orphanedSnapshots(book) {
  const [snaps, disks, subs] = await Promise.all([
    resourceGraphQuery(
      `Resources
      | where type == 'microsoft.compute/snapshots'
      | project id, name, resourceGroup, subscriptionId, location, sizeGb = toint(properties.diskSizeGB), sku = tostring(sku.name),
          incremental = tobool(properties.incremental), source = tolower(tostring(properties.creationData.sourceResourceId)), created = tostring(properties.timeCreated)`,
      { toolId: TOOL_ID }
    ),
    resourceGraphQuery(`Resources | where type == 'microsoft.compute/disks' | project id = tolower(id)`, { toolId: TOOL_ID }),
    subscriptionIdsToScan(TOOL_ID),
  ]);
  const diskIds = new Set(disks.map((d) => d.id));
  const scanned = new Set(subs.map((s) => String(s).toLowerCase()));
  const cur = prices.currency();
  const out = [];
  const orphans = snaps.filter((s) => {
    const m = /^\/subscriptions\/([^/]+)\/resourcegroups\/[^/]+\/providers\/microsoft\.compute\/disks\//.exec(s.source || "");
    return m && scanned.has(m[1]) && !diskIds.has(s.source);
  });
  await mapLimit(orphans, PRICE_CONCURRENCY, async (s) => {
    const [type, red] = String(s.sku || "Standard_LRS").toLowerCase().split("_");
    const product = SNAPSHOT_PRODUCTS[type];
    const skuName = `Snapshots ${(red || "lrs").toUpperCase()}`;
    const perGb = product
      ? await book.get(`snap|${s.location}|${product}|${skuName}`, async () => {
          const items = await prices.query(`serviceName eq 'Storage' and armRegionName eq ${prices.lit(s.location)} and productName eq ${prices.lit(product)} and skuName eq ${prices.lit(skuName)}`);
          return prices.monthly(items.find((i) => /Snapshots$/.test(i.meterName) && /GB\/Month/i.test(i.unitOfMeasure)));
        })
      : null;
    const cost = perGb == null ? null : perGb * (Number(s.sizeGb) || 0);
    out.push({
      kind: "orphaned-snapshot",
      id: s.id,
      name: s.name,
      resourceGroup: s.resourceGroup,
      subscriptionId: s.subscriptionId,
      location: s.location,
      monthlyCost: cost,
      currency: cur,
      detail: `${s.sizeGb} GB ${/^premium/i.test(s.sku) ? "Premium" : "Standard"} snapshot${s.incremental ? " (incremental)" : ""}, ${s.location}; its disk ${s.source.split("/").pop()} was deleted; ${
        cost == null ? costText(null, cur) : s.incremental ? `up to ${Math.round(cost).toLocaleString("en-US")} ${cur} a month at list price (billed for the data it holds)` : costText(cost, cur)
      }${s.created ? `; taken ${s.created.slice(0, 10)}` : ""}`,
    });
  });
  return out;
}

// App Service plans with no apps still bill every instance. Free, shared and consumption plans cost nothing.
function appServiceSkuName(sku) {
  return String(sku || "").replace(/^([A-Z]+\d+)(v\d)$/i, "$1 $2");
}
async function emptyAppServicePlans(book) {
  const rows = await resourceGraphQuery(
    `Resources
    | where type == 'microsoft.web/serverfarms' and toint(properties.numberOfSites) == 0
    | where tostring(sku.tier) !in~ ('Free', 'Shared', 'Dynamic', 'FlexConsumption')
    | project id, name, resourceGroup, subscriptionId, location, sku = tostring(sku.name), skuTier = tostring(sku.tier),
        instances = toint(sku.capacity), linux = tobool(properties.reserved)`,
    { toolId: TOOL_ID }
  );
  const cur = prices.currency();
  const out = [];
  await mapLimit(rows, PRICE_CONCURRENCY, async (r) => {
    const skuName = appServiceSkuName(r.sku);
    const os = r.linux ? "Linux" : "Windows";
    const hourly = await book.get(`asp|${r.location}|${skuName}|${os}`, async () => {
      const items = await prices.query(`serviceName eq 'Azure App Service' and armRegionName eq ${prices.lit(r.location)} and skuName eq ${prices.lit(skuName)}`);
      const fit = items.filter((i) => / - Linux$/.test(i.productName) === Boolean(r.linux) && (i.meterName === `${skuName} App` || i.meterName === skuName));
      return prices.monthly(fit[0]);
    });
    const n = Math.max(1, Number(r.instances) || 1);
    const cost = hourly == null ? null : hourly * n;
    out.push({
      kind: "empty-app-service-plan",
      id: r.id,
      name: r.name,
      resourceGroup: r.resourceGroup,
      subscriptionId: r.subscriptionId,
      location: r.location,
      monthlyCost: cost,
      currency: cur,
      detail: `${r.sku} (${r.skuTier}) ${os}, ${n} instance${n === 1 ? "" : "s"}, ${r.location}; no apps; ${costText(cost, cur)}`,
    });
  });
  return out;
}

// --- Savings: what cleaning up has saved ---
// A priced finding that is gone from this run counts as saved only when the resource itself is gone (deleted):
// a disk attached again or a plan given an app still costs money. Each saving keeps its monthly list price and the
// day it went; the page adds up a month's worth and what it has saved since. Kept per tenant, never pruned.
const SAVINGS_KEY = "savings/orphaned-resources.json";
const CHECK_OF_KIND = {
  "unattached-disk": "Unattached disks",
  "unused-public-ip": "Unused public IPs",
  "orphaned-snapshot": "Orphaned snapshots",
  "empty-app-service-plan": "Empty App Service plans",
};
const PENDING_DAYS = 30; // a gone finding not confirmed in this time (its subscription no longer scanned) is dropped
const ID_BATCH = 200;

// prev: last run's findings; now: this run's; scanned: subscription ids this run covered; exists(ids) -> Set of the
// ids (lowercase) that still exist. Returns the new ledger.
async function updateSavings(ledger, prev, now, scanned, exists, at) {
  const doc = { since: ledger.since || at, entries: ledger.entries || [], pending: [] };
  const key = (f) => String(f.id || "").toLowerCase();
  const nowKeys = new Set(now.map(key));
  const failed = new Set(now.filter((f) => f.kind === "scan-error").map((f) => f.name));
  const saved = new Set(doc.entries.map((e) => key(e)));
  const subs = new Set(scanned.map((x) => String(x).toLowerCase()));
  const cutoff = Date.parse(at) - PENDING_DAYS * 86400000;
  const seen = new Set();
  const candidates = [];
  for (const f of [...(ledger.pending || []), ...prev.map((x) => ({ ...x, goneAt: at }))]) {
    const k = key(f);
    if (!k || seen.has(k) || saved.has(k) || nowKeys.has(k) || !(f.monthlyCost > 0) || !CHECK_OF_KIND[f.kind]) continue;
    seen.add(k);
    if (Date.parse(f.goneAt || at) < cutoff) continue;
    // Not looked at this run (its check failed or its subscription was not scanned): try again next run.
    if (failed.has(`${CHECK_OF_KIND[f.kind]} check failed`) || !subs.has(String(f.subscriptionId || "").toLowerCase())) doc.pending.push(f);
    else candidates.push(f);
  }
  if (!candidates.length) return doc;
  let still;
  try {
    still = await exists(candidates.map((f) => f.id));
  } catch (err) {
    log.record({ tool: TOOL_ID, level: "warn", message: `could not check whether cleaned-up resources are deleted; tried again next run: ${err.message}` });
    doc.pending.push(...candidates);
    return doc;
  }
  for (const f of candidates) {
    if (still.has(key(f))) continue; // in use again, not deleted
    doc.entries.push({
      id: f.id, kind: f.kind, name: f.name, resourceGroup: f.resourceGroup, subscriptionId: f.subscriptionId, location: f.location,
      monthlyCost: f.monthlyCost, currency: f.currency, firstSeen: f.firstSeen || null, savedAt: f.goneAt || at,
    });
  }
  return doc;
}

async function existingIds(ids) {
  const out = new Set();
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const list = ids.slice(i, i + ID_BATCH).map((id) => `'${String(id).toLowerCase().replace(/'/g, "")}'`).join(",");
    const rows = await resourceGraphQuery(`Resources | where tolower(id) in (${list}) | project id`, { toolId: TOOL_ID });
    for (const r of rows) out.add(String(r.id).toLowerCase());
  }
  return out;
}

async function recordSavings(findings) {
  const t = tenantContext.current();
  const k = t && !tenantContext.isHome(t) ? t.key : store.HOME;
  const [latest, ledger, scanned] = await Promise.all([store.read(TOOL_ID, [k]), store.getDoc(SAVINGS_KEY), subscriptionIdsToScan(TOOL_ID)]);
  if (!latest.ranAt && !ledger) return; // first run here: nothing to compare with
  const doc = await updateSavings(ledger || {}, latest.findings || [], findings, scanned, existingIds, new Date().toISOString());
  await store.putDoc(SAVINGS_KEY, doc);
  const fresh = doc.entries.length - ((ledger && ledger.entries) || []).length;
  if (fresh) log.record({ tool: TOOL_ID, level: "info", message: `${fresh} cleaned-up resource(s) counted as saved` });
}

async function savings(keys) {
  const out = { since: null, entries: [], failures: [] };
  for (const k of keys) {
    try {
      const doc = await store.getDoc(SAVINGS_KEY, k);
      if (!doc) continue;
      if (doc.since && (!out.since || doc.since < out.since)) out.since = doc.since;
      out.entries.push(...(doc.entries || []).map((e) => ({ ...e, ...(k !== store.HOME && { tenant: k }) })));
    } catch (err) {
      out.failures.push({ tenant: k, error: `could not read the savings: ${err.message}` });
    }
  }
  return out;
}

function registerRoutes(app, { readKeys, decorate }) {
  app.get("/api/orphaned-resources/savings", async (req, res) => {
    try {
      const out = await savings(readKeys(req));
      await decorate(TOOL_ID, out.entries);
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// A failed check shows as a scan-error finding instead of silently fewer
// findings; run() throws only when every check fails.
async function run() {
  const book = priceBook();
  const findings = await runChecks(TOOL_ID, {
    "Unattached disks": () => unattachedDisks(book),
    "Unused public IPs": () => unusedPublicIps(book),
    "Orphaned NICs": orphanedNics,
    "Empty resource groups": emptyResourceGroups,
    "Orphaned snapshots": () => orphanedSnapshots(book),
    "Empty App Service plans": () => emptyAppServicePlans(book),
  });
  if (book.failures.length) {
    log.record({ tool: TOOL_ID, level: "warn", message: `${book.failures.length} price lookup(s) failed: ${book.failures[0]}` });
  }
  const total = findings.reduce((s, f) => s + (f.monthlyCost || 0), 0);
  log.record({ tool: TOOL_ID, level: "info", message: `${findings.length} finding(s), about ${Math.round(total)} ${prices.currency()} a month at list price` });
  await recordSavings(findings).catch((err) => log.record({ tool: TOOL_ID, level: "warn", message: `savings not updated: ${err.message}` }));
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Orphaned resources",
  schedule: "0 3 * * *", // nightly at 03:00
  run,
  registerRoutes,
  _test: { diskTier, diskSku, appServiceSkuName, diskDescription, updateSavings },
};
