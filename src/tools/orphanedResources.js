const { resourceGraphQuery, subscriptionIdsToScan, armGet } = require("../armClient");
const backups = require("./backupCoverage");
const { runChecks, mapLimit, numberSetting, nameOf } = require("./util");
const settings = require("../settings");
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
function snapshotPrice(book, s) {
  const [type, red] = String(s.sku || "Standard_LRS").toLowerCase().split("_");
  const product = SNAPSHOT_PRODUCTS[type];
  const skuName = `Snapshots ${(red || "lrs").toUpperCase()}`;
  if (!product) return Promise.resolve(null);
  return book
    .get(`snap|${s.location}|${product}|${skuName}`, async () => {
      const items = await prices.query(`serviceName eq 'Storage' and armRegionName eq ${prices.lit(s.location)} and productName eq ${prices.lit(product)} and skuName eq ${prices.lit(skuName)}`);
      return prices.monthly(items.find((i) => /Snapshots$/.test(i.meterName) && /GB\/Month/i.test(i.unitOfMeasure)));
    })
    .then((perGb) => (perGb == null ? null : perGb * (Number(s.sizeGb) || 0)));
}
const snapshotCostText = (s, cost, cur) =>
  cost == null ? costText(null, cur) : s.incremental ? `up to ${Math.round(cost).toLocaleString("en-US")} ${cur} a month at list price (billed for the data it holds)` : costText(cost, cur);

// The snapshot list is read once and shared by the orphaned and the old snapshot checks.
function snapshotData() {
  let p = null;
  return () =>
    (p ||= Promise.all([
      resourceGraphQuery(
        `Resources
        | where type == 'microsoft.compute/snapshots'
        | project id, name, resourceGroup, subscriptionId, location, sizeGb = toint(properties.diskSizeGB), sku = tostring(sku.name),
            incremental = tobool(properties.incremental), source = tolower(tostring(properties.creationData.sourceResourceId)), created = tostring(properties.timeCreated)`,
        { toolId: TOOL_ID }
      ),
      resourceGraphQuery(`Resources | where type == 'microsoft.compute/disks' | project id = tolower(id)`, { toolId: TOOL_ID }),
      subscriptionIdsToScan(TOOL_ID),
    ]).then(([snaps, disks, subs]) => {
      const diskIds = new Set(disks.map((d) => d.id));
      const scanned = new Set(subs.map((x) => String(x).toLowerCase()));
      const orphan = (s) => {
        const m = /^\/subscriptions\/([^/]+)\/resourcegroups\/[^/]+\/providers\/microsoft\.compute\/disks\//.exec(s.source || "");
        return Boolean(m && scanned.has(m[1]) && !diskIds.has(s.source));
      };
      return { snaps, orphan };
    }));
}

async function orphanedSnapshots(book, data) {
  const { snaps, orphan } = await data();
  const cur = prices.currency();
  const out = [];
  await mapLimit(snaps.filter(orphan), PRICE_CONCURRENCY, async (s) => {
    const cost = await snapshotPrice(book, s);
    out.push({
      kind: "orphaned-snapshot",
      id: s.id,
      name: s.name,
      resourceGroup: s.resourceGroup,
      subscriptionId: s.subscriptionId,
      location: s.location,
      monthlyCost: cost,
      currency: cur,
      detail: `${s.sizeGb} GB ${/^premium/i.test(s.sku) ? "Premium" : "Standard"} snapshot${s.incremental ? " (incremental)" : ""}, ${s.location}; its disk ${s.source.split("/").pop()} was deleted; ${snapshotCostText(s, cost, cur)}${s.created ? `; taken ${s.created.slice(0, 10)}` : ""}`,
    });
  });
  return out;
}

// Snapshots older than OLD_SNAPSHOT_DAYS whose disk still exists (or is elsewhere): often a one-off copy nobody needs.
async function oldSnapshots(book, data) {
  const days = numberSetting("OLD_SNAPSHOT_DAYS", 180, { min: 0, max: 3650 });
  if (!days) return [];
  const { snaps, orphan } = await data();
  const cutoff = Date.now() - days * 86400000;
  const cur = prices.currency();
  const out = [];
  await mapLimit(snaps.filter((s) => !orphan(s) && s.created && Date.parse(s.created) < cutoff), PRICE_CONCURRENCY, async (s) => {
    const cost = await snapshotPrice(book, s);
    const age = Math.floor((Date.now() - Date.parse(s.created)) / 86400000);
    out.push({
      kind: "old-snapshot",
      id: s.id,
      name: s.name,
      resourceGroup: s.resourceGroup,
      subscriptionId: s.subscriptionId,
      location: s.location,
      monthlyCost: cost,
      currency: cur,
      detail: `${s.sizeGb} GB ${/^premium/i.test(s.sku) ? "Premium" : "Standard"} snapshot${s.incremental ? " (incremental)" : ""}${s.source ? ` of ${nameOf(s.source)}` : ""}, ${age} days old (taken ${s.created.slice(0, 10)}); ${snapshotCostText(s, cost, cur)}`,
    });
  });
  return out;
}

const finding = (kind, r, cost, cur, detail) => ({
  kind, id: r.id, name: r.name, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId, location: r.location,
  monthlyCost: cost, ...(cur && { currency: cur }), detail,
});

// A price for one exact meter, remembered for the run. Region 'Global' for meters Azure prices the same everywhere.
function meterPrice(book, key, filter) {
  return book.get(key, async () => prices.monthly((await prices.query(filter))[0]));
}

// VMs shut down from inside the OS (or stopped without deallocating) still bill the full compute price. Azure
// Hybrid Benefit (licenseType Windows_Server) pays the Linux price.
async function stoppedVms(book) {
  const rows = await resourceGraphQuery(
    `Resources
    | where type == 'microsoft.compute/virtualmachines' and tostring(properties.extended.instanceView.powerState.code) =~ 'PowerState/stopped'
    | project id, name, resourceGroup, subscriptionId, location, size = tostring(properties.hardwareProfile.vmSize),
        os = tostring(properties.storageProfile.osDisk.osType), license = tostring(properties.licenseType)`,
    { toolId: TOOL_ID }
  );
  const cur = prices.currency();
  const out = [];
  await mapLimit(rows, PRICE_CONCURRENCY, async (r) => {
    const windows = /windows/i.test(r.os) && !/^Windows_(Server|Client)$/i.test(r.license);
    const cost = r.size
      ? await book.get(`vm|${r.location}|${r.size}|${windows}`, async () => {
          const items = await prices.query(`serviceName eq 'Virtual Machines' and armRegionName eq ${prices.lit(r.location)} and armSkuName eq ${prices.lit(r.size)}`);
          return prices.monthly(items.find((i) => !/Spot|Low Priority/i.test(i.skuName) && !/Cloud Services|Dedicated Host/i.test(i.productName) && / Windows$/.test(i.productName) === windows));
        })
      : null;
    out.push(finding("stopped-vm", r, cost, cur, `${r.size} ${windows ? "Windows" : "Linux"}, ${r.location}; stopped but not deallocated, so compute is still billed: ${cost == null ? costText(null, cur, r.size) : costText(cost, cur)}. Stop it from the portal (that deallocates it) or delete it`));
  });
  return out;
}

// Backups of deleted VMs: the vault keeps the recovery points, and bills a
// protected instance fee plus storage for them, until someone deletes them.
// Azure does not say how much storage one item holds, so the vault's backup
// storage is shared out evenly over its items. The fee assumes a VM of 50 to
// 500 GB (one unit; half a unit under 50 GB). Items Azure already deletes
// (soft-deleted) are left out.
const MAX_BACKUP_READS = 300;
const BACKUP_STORAGE_METER = { locallyredundant: "Standard LRS Data Stored", zoneredundant: "Standard ZRS Data Stored", georedundant: "Standard GRS Data Stored" };

// Bytes of backup storage a vault uses (every "...Storage..." usage counted in bytes).
async function vaultStorageBytes(vaultId) {
  const body = (await armGet(`https://management.azure.com${vaultId}/usages?api-version=2016-06-01`, TOOL_ID)) || {};
  const rows = (body.value || []).filter((u) => /^bytes$/i.test(u.unit) && /storage/i.test((u.name && u.name.value) || ""));
  return rows.length ? rows.reduce((n, u) => n + (Number(u.currentValue) || 0), 0) : null;
}

async function deletedVmBackups(book) {
  const [items, vms, subs, vaults] = await Promise.all([
    backups.protectedItems(TOOL_ID),
    resourceGraphQuery(`Resources | where type =~ 'microsoft.compute/virtualmachines' | project id = tolower(id)`, { toolId: TOOL_ID }),
    resourceGraphQuery(`ResourceContainers | where type =~ 'microsoft.resources/subscriptions' | project subscriptionId`, { toolId: TOOL_ID }),
    resourceGraphQuery(
      `Resources | where type =~ 'microsoft.recoveryservices/vaults'
      | project id = tolower(id), location, redundancy = tolower(tostring(properties.redundancySettings.standardTierStorageRedundancy)),
          crossRegionRestore = tostring(properties.redundancySettings.crossRegionRestore)`,
      { toolId: TOOL_ID }
    ),
  ]);
  const vmIds = new Set(vms.map((v) => v.id));
  const subIds = new Set(subs.map((x) => String(x.subscriptionId).toLowerCase()));
  const gone = items.filter((it) => backups.vmGone(it, vmIds, subIds));
  if (!gone.length) return [];
  const vaultOf = new Map(vaults.map((v) => [v.id, v]));
  const perVault = new Map();
  for (const it of items) perVault.set(it.vault.toLowerCase(), (perVault.get(it.vault.toLowerCase()) || 0) + 1);
  const storage = new Map(); // vault id -> Promise<bytes|null>
  const cur = prices.currency();
  const out = [];
  const checked = gone.slice(0, MAX_BACKUP_READS);
  const failures = await mapLimit(checked, PRICE_CONCURRENCY, async (it) => {
    const vid = it.vault.toLowerCase();
    const v = vaultOf.get(vid) || {};
    if (!storage.has(vid)) storage.set(vid, vaultStorageBytes(it.vault).catch(() => null));
    const [points, bytes] = await Promise.all([backups.recoveryPointSummary(it.id, TOOL_ID), storage.get(vid)]);
    const loc = v.location || "";
    const fee = loc ? await meterPrice(book, `backup-pi|${loc}`, `serviceName eq 'Backup' and armRegionName eq ${prices.lit(loc)} and meterName eq 'Azure VM Protected Instance'`) : null;
    const meter = /^enabled$/i.test(v.crossRegionRestore) ? "Standard RA-GRS Data Stored" : BACKUP_STORAGE_METER[v.redundancy];
    const perGb = loc && meter ? await meterPrice(book, `backup-gb|${loc}|${meter}`, `serviceName eq 'Backup' and armRegionName eq ${prices.lit(loc)} and meterName eq ${prices.lit(meter)}`) : null;
    const gb = bytes == null ? null : bytes / 1024 ** 3 / (perVault.get(vid) || 1);
    const storageCost = gb != null && perGb != null ? gb * perGb : null;
    const cost = !points.count ? 0 : fee == null ? null : fee + (storageCost || 0);
    const pts = !points.count ? "no recovery points left"
      : `${points.capped ? "over " : ""}${points.count} recovery point${points.count === 1 ? "" : "s"}, ${points.oldest.slice(0, 10)} to ${points.newest.slice(0, 10)}`;
    const state = /ProtectionStopped|BackupsSuspended/i.test(it.state) ? "backups are stopped" : "protection is still on, so the vault keeps trying to back up a VM that is gone";
    const price = cost == null ? costText(null, cur, "Azure VM Protected Instance")
      : !points.count ? "nothing left to pay for; stop protection to remove the item"
      : `${costText(cost, cur)} (protected instance fee${storageCost != null ? ` plus about ${Math.round(gb)} GB, the vault's storage shared over its ${perVault.get(vid)} item${perVault.get(vid) === 1 ? "" : "s"}` : "; storage not known"})`;
    out.push({
      kind: "backup-vm-deleted", id: it.id, name: it.friendly || nameOf(it.source), resourceGroup: it.resourceGroup, subscriptionId: it.subscriptionId, location: loc,
      monthlyCost: cost, ...(cur && { currency: cur }),
      detail: `The VM was deleted, but vault ${nameOf(it.vault)} still holds its backup (${pts}); ${state}. ${price}. Keep it (accept with a reason) or stop protection and delete the backup data`,
    });
  });
  for (const f of failures) out.push({ kind: "scan-error", id: `${TOOL_ID}/scan-errors/backup-${nameOf(f.item.id)}`, name: `Backup of deleted VM ${f.item.friendly || nameOf(f.item.source)} not checked`, detail: f.message, subscriptionId: f.item.subscriptionId });
  if (gone.length > checked.length) out.push({ kind: "scan-error", id: `${TOOL_ID}/scan-errors/backup-limit`, name: `${gone.length - checked.length} backups of deleted VMs not checked`, detail: `At most ${MAX_BACKUP_READS} are read per run` });
  return out;
}

async function idleNatGateways(book) {
  const rows = await resourceGraphQuery(
    `Resources
    | where type == 'microsoft.network/natgateways' and array_length(properties.subnets) == 0
    | project id, name, resourceGroup, subscriptionId, location`,
    { toolId: TOOL_ID }
  );
  const cur = prices.currency();
  const cost = rows.length ? await meterPrice(book, "nat", "productName eq 'NAT Gateway' and armRegionName eq 'Global' and meterName eq 'Standard Gateway'") : null;
  return rows.map((r) => finding("idle-nat-gateway", r, cost, cur, `${r.location}; attached to no subnet; ${costText(cost, cur)} (plus its public IPs)`));
}

// Backend pools with no NIC or address in any of them.
const poolSize = (p) => {
  const x = (p && p.properties) || {};
  return (x.backendIPConfigurations || []).length + (x.loadBalancerBackendAddresses || []).length + (x.backendAddresses || []).length;
};
const allEmpty = (pools) => (pools || []).every((p) => poolSize(p) === 0);

// A Standard load balancer bills for its rules; one with no rules costs nothing. Basic ones are free and retiring.
async function emptyLoadBalancers(book) {
  const rows = await resourceGraphQuery(
    `Resources
    | where type == 'microsoft.network/loadbalancers' and tostring(sku.name) =~ 'Standard'
    | project id, name, resourceGroup, subscriptionId, location, pools = properties.backendAddressPools,
        rules = coalesce(array_length(properties.loadBalancingRules), 0) + coalesce(array_length(properties.outboundRules), 0)`,
    { toolId: TOOL_ID }
  );
  const empty = rows.filter((r) => allEmpty(r.pools));
  const cur = prices.currency();
  const ruled = empty.some((r) => r.rules > 0)
    ? await meterPrice(book, "lb", "productName eq 'Load Balancer' and armRegionName eq 'Global' and meterName eq 'Standard Included LB Rules and Outbound Rules'")
    : null;
  return empty.map((r) => {
    const cost = r.rules > 0 ? ruled : 0;
    return finding("empty-load-balancer", r, cost, cur, `Standard, ${r.location}; ${(r.pools || []).length ? "every backend pool is empty" : "no backend pool"}, ${r.rules} rule${r.rules === 1 ? "" : "s"}; ${cost === 0 ? "no charge without rules, only clutter" : costText(cost, cur)}`);
  });
}

// v2 gateways bill a fixed hourly price plus capacity units (at least the minimum) with nothing behind them.
// A stopped gateway is not billed. v1 gateways are being retired and are not estimated.
const AGW_PRODUCTS = { standard_v2: "Application Gateway Standard v2", waf_v2: "Application Gateway WAF v2" };
async function idleAppGateways(book) {
  const rows = await resourceGraphQuery(
    `Resources
    | where type == 'microsoft.network/applicationgateways'
    | project id, name, resourceGroup, subscriptionId, location, tier = tostring(properties.sku.tier), capacity = toint(properties.sku.capacity),
        minCapacity = toint(properties.autoscaleConfiguration.minCapacity), state = tostring(properties.operationalState), pools = properties.backendAddressPools`,
    { toolId: TOOL_ID }
  );
  const cur = prices.currency();
  const out = [];
  await mapLimit(rows.filter((r) => allEmpty(r.pools)), PRICE_CONCURRENCY, async (r) => {
    const stopped = /stopped/i.test(r.state);
    const product = AGW_PRODUCTS[String(r.tier).toLowerCase()];
    let cost = stopped ? 0 : null;
    if (!stopped && product) {
      const items = (await book.get(`agw|${r.location}|${product}`, () => prices.query(`productName eq ${prices.lit(product)} and armRegionName eq ${prices.lit(r.location)}`))) || [];
      const fixed = prices.monthly(items.find((i) => /Fixed Cost$/.test(i.meterName)));
      const cu = prices.monthly(items.find((i) => /Capacity Units$/.test(i.meterName)));
      const units = Math.max(0, Number(r.minCapacity ?? r.capacity) || 0);
      cost = fixed == null ? null : fixed + units * (cu || 0);
    }
    const price = stopped ? "stopped, so not billed" : product ? costText(cost, cur) : "v1 gateway (being retired), not estimated";
    out.push(finding("idle-app-gateway", r, cost, cur, `${r.tier}, ${r.location}; every backend pool is empty; ${price}`));
  });
  return out;
}

// VPN and ExpressRoute gateways with no connection (and, for VPN, no point-to-site clients) bill by the hour for nothing.
async function idleVnetGateways(book) {
  const [gws, conns] = await Promise.all([
    resourceGraphQuery(
      `Resources
      | where type == 'microsoft.network/virtualnetworkgateways'
      | project id, name, resourceGroup, subscriptionId, location, gatewayType = tostring(properties.gatewayType), sku = tostring(properties.sku.name),
          p2s = coalesce(array_length(properties.vpnClientConfiguration.vpnClientAddressPool.addressPrefixes), 0) > 0`,
      { toolId: TOOL_ID }
    ),
    resourceGraphQuery(
      `Resources
      | where type == 'microsoft.network/connections'
      | project g1 = tolower(tostring(properties.virtualNetworkGateway1.id)), g2 = tolower(tostring(properties.virtualNetworkGateway2.id))`,
      { toolId: TOOL_ID }
    ),
  ]);
  const used = new Set(conns.flatMap((c) => [c.g1, c.g2]).filter(Boolean));
  const cur = prices.currency();
  const out = [];
  await mapLimit(gws.filter((g) => !used.has(String(g.id).toLowerCase()) && !g.p2s), PRICE_CONCURRENCY, async (g) => {
    const er = /expressroute/i.test(g.gatewayType);
    const filter = er
      ? `armRegionName eq ${prices.lit(g.location)} and meterName eq ${prices.lit(`${g.sku} Gateway`)}`
      : `serviceName eq 'VPN Gateway' and armRegionName eq ${prices.lit(g.location)} and meterName eq ${prices.lit(g.sku)}`;
    const cost = g.sku ? await meterPrice(book, `vgw|${g.location}|${er}|${g.sku}`, filter) : null;
    out.push(finding("idle-vnet-gateway", g, cost, cur, `${er ? "ExpressRoute" : "VPN"} gateway ${g.sku}, ${g.location}; no connections${er ? "" : " and no point-to-site setup"}; ${costText(cost, cur, g.sku)}`));
  });
  return out;
}

// Private endpoints whose target was deleted, or that the target's owner rejected or cut off.
async function disconnectedPrivateEndpoints(book) {
  const rows = await resourceGraphQuery(
    `Resources
    | where type == 'microsoft.network/privateendpoints'
    | extend c = iff(array_length(properties.privateLinkServiceConnections) > 0, properties.privateLinkServiceConnections[0], properties.manualPrivateLinkServiceConnections[0])
    | extend status = tostring(c.properties.privateLinkServiceConnectionState.status), target = tostring(c.properties.privateLinkServiceId)
    | where status in~ ('Disconnected', 'Rejected')
    | project id, name, resourceGroup, subscriptionId, location, status, target`,
    { toolId: TOOL_ID }
  );
  const cur = prices.currency();
  const cost = rows.length ? await meterPrice(book, "pe", "armRegionName eq 'Global' and meterName eq 'Standard Private Endpoint'") : null;
  return rows.map((r) => finding("disconnected-private-endpoint", r, cost, cur, `${r.status} by ${nameOf(r.target) || "its target"}, ${r.location}; carries no traffic; ${costText(cost, cur)}`));
}

// Private DNS zones linked to no virtual network answer nobody. Priced at the first-25-zones rate (billed per zone a month).
async function unlinkedPrivateDnsZones(book) {
  const rows = await resourceGraphQuery(
    `Resources
    | where type == 'microsoft.network/privatednszones' and toint(properties.numberOfVirtualNetworkLinks) == 0
    | project id, name, resourceGroup, subscriptionId, location, records = toint(properties.numberOfRecordSets)`,
    { toolId: TOOL_ID }
  );
  const cur = prices.currency();
  const cost = rows.length
    ? await book.get("pdns", async () => {
        const it = (await prices.query("serviceName eq 'Azure DNS' and meterName eq 'Private Zone' and armRegionName eq 'Zone 1'")).find((i) => !i.tierMinimumUnits);
        return it ? it.retailPrice : null;
      })
    : null;
  return rows.map((r) => finding("unlinked-private-dns-zone", r, cost, cur, `${r.records || 0} record sets; linked to no virtual network, so nothing resolves it; ${costText(cost, cur)}`));
}

// Free leftovers: network security groups and route tables attached to nothing, availability sets with no VM.
const UNUSED_KINDS = {
  "microsoft.network/networksecuritygroups": ["unused-nsg", "attached to no subnet or network interface"],
  "microsoft.network/routetables": ["unused-route-table", "attached to no subnet"],
  "microsoft.compute/availabilitysets": ["empty-availability-set", "holds no VM"],
};
async function unusedNetworkBits() {
  const rows = await resourceGraphQuery(
    `Resources
    | where (type == 'microsoft.network/networksecuritygroups' and coalesce(array_length(properties.subnets), 0) == 0 and coalesce(array_length(properties.networkInterfaces), 0) == 0)
        or (type == 'microsoft.network/routetables' and coalesce(array_length(properties.subnets), 0) == 0)
        or (type == 'microsoft.compute/availabilitysets' and coalesce(array_length(properties.virtualMachines), 0) == 0)
    | project id, name, resourceGroup, subscriptionId, location, type`,
    { toolId: TOOL_ID }
  );
  return rows.map((r) => {
    const [kind, what] = UNUSED_KINDS[r.type];
    return finding(kind, r, 0, null, `${what}; no charge, only clutter`);
  });
}

// Elastic pools bill for their size whether or not they hold databases. Their price depends on the model (DTU or
// vCore), tier and size, so it is not estimated.
async function emptyElasticPools() {
  const [pools, dbs] = await Promise.all([
    resourceGraphQuery(
      `Resources
      | where type == 'microsoft.sql/servers/elasticpools'
      | project id, name, resourceGroup, subscriptionId, location, sku = tostring(sku.name), capacity = toint(sku.capacity)`,
      { toolId: TOOL_ID }
    ),
    resourceGraphQuery(
      `Resources
      | where type == 'microsoft.sql/servers/databases' and isnotempty(properties.elasticPoolId)
      | summarize by pool = tolower(tostring(properties.elasticPoolId))`,
      { toolId: TOOL_ID }
    ),
  ]);
  const used = new Set(dbs.map((d) => d.pool));
  return pools
    .filter((p) => !used.has(String(p.id).toLowerCase()))
    .map((p) => finding("empty-elastic-pool", p, null, null, `${p.sku}${p.capacity ? ` (${p.capacity})` : ""}, ${p.location}; holds no databases but is billed for its size (not estimated)`));
}

// Azure Advisor's own cost tips (resize or shut down underused VMs and the like) with its estimate of the monthly
// saving, in the currency Advisor gives. Reservation and savings plan advice for a whole subscription is left out: it
// is a purchase, not waste. run() drops tips about a resource another check already lists.
const isOff = (v) => /^(off|no|false|0)$/i.test(String(v || "").trim());
async function advisorCostTips() {
  if (isOff(settings.get("ADVISOR_COST_TIPS"))) return [];
  const rows = await resourceGraphQuery(
    `AdvisorResources
    | where type == 'microsoft.advisor/recommendations' and tostring(properties.category) == 'Cost'
    | where tostring(properties.impactedField) !~ 'Microsoft.Subscriptions/subscriptions'
    | project id, subscriptionId, target = tostring(properties.resourceMetadata.resourceId), value = tostring(properties.impactedValue),
        problem = tostring(properties.shortDescription.problem), solution = tostring(properties.shortDescription.solution),
        impact = tostring(properties.impact), ext = properties.extendedProperties`,
    { toolId: TOOL_ID }
  );
  return rows.map(advisorFinding);
}
function advisorFinding(r) {
  const ext = r.ext || {};
  const monthly = Number(ext.savingsAmount) || Number(ext.annualSavingsAmount) / 12 || null;
  const cur = ext.savingsCurrency || "USD";
  const rg = /\/resourcegroups\/([^/]+)/i.exec(r.target || "");
  return {
    kind: "advisor-cost",
    id: r.id,
    target: r.target || null,
    name: r.value || nameOf(r.target) || "Advisor tip",
    resourceGroup: rg ? rg[1] : undefined,
    subscriptionId: r.subscriptionId,
    location: ext.location || ext.region || undefined,
    monthlyCost: monthly,
    currency: cur,
    detail: `Azure Advisor, ${String(r.impact || "unknown").toLowerCase()} impact: ${r.solution || r.problem || "see Advisor"}${monthly ? `; Advisor's estimate: about ${Math.round(monthly).toLocaleString("en-US")} ${cur} a month` : ""}`,
  };
}

// An Advisor tip about a resource another check already lists says the same thing twice.
function dropAdvisorRepeats(findings) {
  const listed = new Set(findings.filter((f) => f.kind !== "advisor-cost" && f.id).map((f) => String(f.id).toLowerCase()));
  return findings.filter((f) => f.kind !== "advisor-cost" || !f.target || !listed.has(String(f.target).toLowerCase()));
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
// A stopped VM counts as saved once it is deallocated (or deleted).
const SAVINGS_KEY = "savings/orphaned-resources.json";
const CHECK_OF_KIND = {
  "unattached-disk": "Unattached disks",
  "unused-public-ip": "Unused public IPs",
  "orphaned-snapshot": "Orphaned snapshots",
  "old-snapshot": "Old snapshots",
  "empty-app-service-plan": "Empty App Service plans",
  "stopped-vm": "Stopped VMs",
  "idle-nat-gateway": "Idle NAT gateways",
  "empty-load-balancer": "Empty load balancers",
  "idle-app-gateway": "Idle application gateways",
  "idle-vnet-gateway": "Idle VPN and ExpressRoute gateways",
  "disconnected-private-endpoint": "Disconnected private endpoints",
  "unlinked-private-dns-zone": "Unlinked private DNS zones",
  "backup-vm-deleted": "Backups of deleted VMs",
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
    const rows = await resourceGraphQuery(
      `Resources | where tolower(id) in (${list})
      | where not(type == 'microsoft.compute/virtualmachines' and tostring(properties.extended.instanceView.powerState.code) =~ 'PowerState/deallocated')
      | project id`,
      { toolId: TOOL_ID }
    );
    for (const r of rows) out.add(String(r.id).toLowerCase());
  }
  // Backup items (backups of deleted VMs) live in another table; one being deleted
  // (soft delete) counts as gone.
  const items = ids.filter((id) => /\/backupfabrics\//i.test(id));
  for (let i = 0; i < items.length; i += ID_BATCH) {
    const list = items.slice(i, i + ID_BATCH).map((id) => `'${String(id).toLowerCase().replace(/'/g, "")}'`).join(",");
    const rows = await resourceGraphQuery(
      `RecoveryServicesResources | where tolower(id) in (${list}) and tobool(properties.isScheduledForDeferredDelete) != true | project id`,
      { toolId: TOOL_ID }
    );
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
  const snaps = snapshotData();
  const findings = dropAdvisorRepeats(
    await runChecks(TOOL_ID, {
      "Unattached disks": () => unattachedDisks(book),
      "Unused public IPs": () => unusedPublicIps(book),
      "Orphaned NICs": orphanedNics,
      "Empty resource groups": emptyResourceGroups,
      "Orphaned snapshots": () => orphanedSnapshots(book, snaps),
      "Old snapshots": () => oldSnapshots(book, snaps),
      "Empty App Service plans": () => emptyAppServicePlans(book),
      "Stopped VMs": () => stoppedVms(book),
      "Idle NAT gateways": () => idleNatGateways(book),
      "Empty load balancers": () => emptyLoadBalancers(book),
      "Idle application gateways": () => idleAppGateways(book),
      "Idle VPN and ExpressRoute gateways": () => idleVnetGateways(book),
      "Disconnected private endpoints": () => disconnectedPrivateEndpoints(book),
      "Unlinked private DNS zones": () => unlinkedPrivateDnsZones(book),
      "Backups of deleted VMs": () => deletedVmBackups(book),
      "Unused NSGs, route tables and availability sets": unusedNetworkBits,
      "Empty SQL elastic pools": emptyElasticPools,
      "Azure Advisor cost tips": advisorCostTips,
    })
  );
  if (book.failures.length) {
    log.record({ tool: TOOL_ID, level: "warn", message: `${book.failures.length} price lookup(s) failed: ${book.failures[0]}` });
  }
  const total = findings.filter((f) => !f.currency || f.currency === prices.currency()).reduce((s, f) => s + (f.monthlyCost || 0), 0);
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
  _test: { diskTier, diskSku, appServiceSkuName, diskDescription, updateSavings, poolSize, dropAdvisorRepeats, advisorFinding },
};
