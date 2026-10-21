// Backup coverage: VMs no Recovery Services vault protects, backups that
// stopped, failed or have not run lately, and vaults without soft delete.
// Reader is enough.
const { resourceGraphQuery } = require("../armClient");
const { numberSetting, runChecks, nameOf } = require("./util");

const TOOL_ID = "backup-coverage";

async function protectedItems() {
  return resourceGraphQuery(
    `RecoveryServicesResources
    | where type =~ 'microsoft.recoveryservices/vaults/backupfabrics/protectioncontainers/protecteditems'
    | project id, subscriptionId, resourceGroup,
        vault = tostring(split(id, '/backupFabrics/')[0]),
        source = tolower(tostring(properties.sourceResourceId)), friendly = tostring(properties.friendlyName),
        workload = tostring(properties.workloadType), state = tostring(properties.protectionState),
        lastStatus = tostring(properties.lastBackupStatus), lastTime = tostring(properties.lastBackupTime)`,
    { toolId: TOOL_ID }
  );
}

async function itemFindings(items) {
  const maxAgeHours = numberSetting("BACKUP_MAX_AGE_HOURS", 48, { min: 1, max: 24 * 365 });
  const findings = [];
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
      findings.push({ ...base, kind: "backup-stale", id: `${it.id}#stale`, detail: `No backup for ${Math.round(age)} hours (${where}); last ${it.lastTime.slice(0, 10)}` });
    }
  }
  return findings;
}

async function coverageFindings() {
  const [vms, items] = await Promise.all([
    resourceGraphQuery(
      `Resources | where type =~ 'microsoft.compute/virtualmachines' | project id, name, resourceGroup, subscriptionId`,
      { toolId: TOOL_ID }
    ),
    protectedItems(),
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
  return [...findings, ...(await itemFindings(items))];
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
};
