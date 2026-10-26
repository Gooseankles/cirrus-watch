// Backup coverage: VMs no Recovery Services vault protects, backups that
// stopped, failed or have not run lately, backups of VMs that were deleted,
// and vaults without soft delete.
// Reader is enough.
// Resource Graph's copy of a protected item is not refreshed after every
// backup (its lastBackupTime can be months old), so items it shows as stale,
// failing or stopped are read again from the vault before they count.
const { resourceGraphQuery, armGet } = require("../armClient");
const { numberSetting, runChecks, nameOf, mapLimit, itemErrors, scanError } = require("./util");

const TOOL_ID = "backup-coverage";
const ITEM_API = "2023-04-01";
const MAX_LIVE_READS = 1000;
const MAX_POINT_PAGES = 5;

async function protectedItems(toolId = TOOL_ID) {
  return resourceGraphQuery(
    `RecoveryServicesResources
    | where type =~ 'microsoft.recoveryservices/vaults/backupfabrics/protectioncontainers/protecteditems'
    | project id, subscriptionId, resourceGroup,
        vault = tostring(split(id, '/backupFabrics/')[0]),
        source = tolower(tostring(properties.sourceResourceId)), friendly = tostring(properties.friendlyName),
        workload = tostring(properties.workloadType), state = tostring(properties.protectionState),
        lastStatus = tostring(properties.lastBackupStatus), lastTime = tostring(properties.lastBackupTime),
        lastPoint = tostring(properties.lastRecoveryPoint), deferredDelete = tobool(properties.isScheduledForDeferredDelete)`,
    { toolId }
  );
}

// The newer of the last backup and the last recovery point.
function lastOf(p) {
  const times = [p.lastBackupTime, p.lastRecoveryPoint].filter((t) => t && !Number.isNaN(Date.parse(t)));
  return times.sort((a, b) => Date.parse(b) - Date.parse(a))[0] || "";
}

// Would this item give a finding, by the given values?
function suspicious(it, maxAgeHours) {
  if (/ProtectionStopped|BackupsSuspended/i.test(it.state)) return true;
  if (!/Protected/i.test(it.state) || /IRPending/i.test(it.state)) return false;
  if (/Failed/i.test(it.lastStatus)) return true;
  return Boolean(it.lastTime) && (Date.now() - Date.parse(it.lastTime)) / 3600000 > maxAgeHours;
}

// The newest recovery point the vault holds for an item. The item's own
// lastBackupTime and lastRecoveryPoint can stay old even on a direct read, but
// a recovery point only exists if a backup really ran.
async function newestRecoveryPoint(itemId) {
  let url = `https://management.azure.com${itemId}/recoveryPoints?api-version=${ITEM_API}`;
  let newest = "";
  for (let page = 0; url && page < MAX_POINT_PAGES; page++) {
    const body = (await armGet(url, TOOL_ID)) || {};
    for (const rp of body.value || []) {
      const t = (rp.properties || {}).recoveryPointTime;
      if (t && !Number.isNaN(Date.parse(t)) && (!newest || Date.parse(t) > Date.parse(newest))) newest = t;
    }
    url = body.nextLink;
  }
  return newest;
}

// How many recovery points the vault holds for an item, and the oldest and
// newest. capped: more pages than are read.
async function recoveryPointSummary(itemId, toolId = TOOL_ID) {
  let url = `https://management.azure.com${itemId}/recoveryPoints?api-version=${ITEM_API}`;
  const times = [];
  let page = 0;
  for (; url && page < MAX_POINT_PAGES; page++) {
    const body = (await armGet(url, toolId)) || {};
    for (const rp of body.value || []) {
      const t = (rp.properties || {}).recoveryPointTime;
      if (t && !Number.isNaN(Date.parse(t))) times.push(t);
    }
    url = body.nextLink;
  }
  times.sort((a, b) => Date.parse(a) - Date.parse(b));
  return { count: times.length, capped: Boolean(url), oldest: times[0] || "", newest: times[times.length - 1] || "" };
}

// Replaces the Resource Graph values of suspicious items with the vault's own.
// Items that look overdue go first: old stopped items (often many) must not use
// up the reads. Items left unchecked are marked so their rows say so.
async function refreshFromVault(items, maxAgeHours) {
  for (const it of items) it.lastTime = lastOf({ lastBackupTime: it.lastTime, lastRecoveryPoint: it.lastPoint });
  const rank = (it) => (/ProtectionStopped|BackupsSuspended/i.test(it.state) ? 2 : /Failed/i.test(it.lastStatus) ? 1 : 0);
  const all = items.filter((it) => suspicious(it, maxAgeHours)).sort((a, b) => rank(a) - rank(b));
  const check = all.slice(0, MAX_LIVE_READS);
  for (const it of all.slice(MAX_LIVE_READS)) it.notChecked = true;
  const failures = await mapLimit(check, 6, async (it) => {
    const p = ((await armGet(`https://management.azure.com${it.id}?api-version=${ITEM_API}`, TOOL_ID)) || {}).properties || {};
    if (p.protectionState) it.state = p.protectionState;
    if (p.lastBackupStatus) it.lastStatus = p.lastBackupStatus;
    const newer = (t) => t && (!it.lastTime || Date.parse(t) > Date.parse(it.lastTime));
    const live = lastOf(p);
    if (newer(live)) it.lastTime = live;
    if (!suspicious(it, maxAgeHours) || /ProtectionStopped|BackupsSuspended|Failed/i.test(`${it.state} ${it.lastStatus}`)) return;
    const point = await newestRecoveryPoint(it.id);
    if (newer(point)) it.lastTime = point;
    it.pointsChecked = true;
  });
  for (const f of failures) f.item.notChecked = true;
  const errors = itemErrors(TOOL_ID, "live-items", "backup items' live status (Resource Graph's possibly old values used)", failures, check.length);
  if (all.length > check.length) {
    errors.push(scanError(TOOL_ID, "live-items-limit", `${all.length - check.length} of ${all.length} backup items not checked against the vault`, `At most ${MAX_LIVE_READS} are read per run (overdue-looking ones first); the rest use Resource Graph's values, which can be months old`));
  }
  return errors;
}

// A VM item whose VM is gone. Only said when the VM's subscription was
// scanned (the vault may back up VMs in a subscription this scan cannot see).
// Items already scheduled for deletion need no decision. Orphaned resources
// lists these backups with what they cost; this scan leaves them out.
function vmGone(it, vmIds, subIds) {
  if (!/vm/i.test(it.workload) || !it.source || it.deferredDelete) return false;
  const sub = (it.source.match(/^\/subscriptions\/([^/]+)\//) || [])[1];
  return Boolean(sub && subIds.has(sub) && !vmIds.has(it.source));
}

async function itemFindings(allItems, vmIds, subIds) {
  const maxAgeHours = numberSetting("BACKUP_MAX_AGE_HOURS", 48, { min: 1, max: 24 * 365 });
  const items = allItems.filter((it) => !vmGone(it, vmIds, subIds));
  const findings = await refreshFromVault(items, maxAgeHours);
  for (const it of items) {
    const base = { name: it.friendly || nameOf(it.source) || nameOf(it.id), resourceGroup: it.resourceGroup, subscriptionId: it.subscriptionId };
    const where = `${it.workload || "item"} in vault ${nameOf(it.vault)}`;
    if (/ProtectionStopped|BackupsSuspended/i.test(it.state)) {
      findings.push({ ...base, kind: "backup-stopped", id: `${it.id}#stopped`, detail: `Backup ${it.state === "BackupsSuspended" ? "suspended" : "stopped"} for this ${where}; old recovery points are kept but no new ones are made` });
      continue;
    }
    if (!/Protected/i.test(it.state) || /IRPending/i.test(it.state)) continue;
    if (/Failed/i.test(it.lastStatus)) {
      findings.push({ ...base, kind: "backup-failing", id: `${it.id}#failing`, detail: `Last backup failed (${where})${it.lastTime ? `, last attempt ${it.lastTime.slice(0, 16).replace("T", " ")}` : ""}` });
      continue;
    }
    const age = it.lastTime ? (Date.now() - Date.parse(it.lastTime)) / 3600000 : null;
    if (age != null && age > maxAgeHours) {
      const why = it.pointsChecked
          ? "; the vault holds no newer recovery point"
          : it.notChecked
            ? "; not checked against the vault this run, so this date may be old"
            : "";
      findings.push({ ...base, kind: "backup-stale", id: `${it.id}#stale`, detail: `No backup for ${Math.round(age)} hours (${where}); last ${it.lastTime.slice(0, 10)}${why}` });
    }
  }
  return findings;
}

async function coverageFindings() {
  const [vms, items, subs] = await Promise.all([
    resourceGraphQuery(
      `Resources | where type =~ 'microsoft.compute/virtualmachines' | project id, name, resourceGroup, subscriptionId`,
      { toolId: TOOL_ID }
    ),
    protectedItems(),
    resourceGraphQuery(`ResourceContainers | where type =~ 'microsoft.resources/subscriptions' | project subscriptionId`, { toolId: TOOL_ID }),
  ]);
  const covered = new Set(items.map((i) => i.source).filter(Boolean));
  const findings = vms
    .filter((vm) => !covered.has(vm.id.toLowerCase()))
    .map((vm) => ({
      kind: "vm-no-backup",
      id: `${vm.id}#no-backup`,
      name: vm.name,
      resourceGroup: vm.resourceGroup,
      subscriptionId: vm.subscriptionId,
      detail: "No Recovery Services vault backs up this VM. Accept it if it holds nothing worth restoring",
    }));
  const subIds = new Set(subs.map((s) => String(s.subscriptionId).toLowerCase()));
  return [...findings, ...(await itemFindings(items, new Set(vms.map((vm) => vm.id.toLowerCase())), subIds))];
}

async function vaultFindings() {
  const vaults = await resourceGraphQuery(
    `Resources
    | where type =~ 'microsoft.recoveryservices/vaults'
    | project id, name, resourceGroup, subscriptionId,
        softDelete = tostring(properties.securitySettings.softDeleteSettings.softDeleteState),
        redundancy = tostring(properties.redundancySettings.standardTierStorageRedundancy)`,
    { toolId: TOOL_ID }
  );
  const findings = [];
  for (const v of vaults) {
    const base = { name: v.name, resourceGroup: v.resourceGroup, subscriptionId: v.subscriptionId };
    if (/^disabled$/i.test(v.softDelete)) findings.push({ ...base, kind: "vault-soft-delete-off", id: `${v.id}#soft-delete`, detail: "Soft delete is off: anyone who can delete backups deletes them for good (ransomware can too)" });
    if (/^locallyredundant$/i.test(v.redundancy)) findings.push({ ...base, kind: "vault-lrs", id: `${v.id}#lrs`, detail: "Backups are kept in one datacenter only (LRS); a zone or region outage takes them with it" });
  }
  return findings;
}

function run() {
  return runChecks(TOOL_ID, { "VM backups": coverageFindings, "Vault settings": vaultFindings });
}

module.exports = {
  id: TOOL_ID,
  label: "Backup coverage",
  schedule: "15 7 * * *", // daily at 07:15, after the night's backups
  run,
  // Used by Orphaned resources for backups of deleted VMs.
  protectedItems,
  vmGone,
  recoveryPointSummary,
  _test: { vmGone },
};
