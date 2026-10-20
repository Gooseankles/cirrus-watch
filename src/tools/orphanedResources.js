const { resourceGraphQuery } = require("../armClient");

const TOOL_ID = "orphaned-resources";

// Each finding: { kind, id, name, resourceGroup, subscriptionId, detail }
// Cost is intentionally left out rather than guessed — wiring up the Azure
// Retail Prices API for a real estimate is a follow-up, not a fabricated number.

async function unattachedDisks() {
  const rows = await resourceGraphQuery(
    `
    Resources
    | where type == 'microsoft.compute/disks' and properties.diskState == 'Unattached'
    | project id, name, resourceGroup, subscriptionId, sizeGb = properties.diskSizeGB, sku = sku.name
  `,
    { toolId: TOOL_ID }
  );
  return rows.map((r) => ({
    kind: "unattached-disk",
    id: r.id,
    name: r.name,
    resourceGroup: r.resourceGroup,
    subscriptionId: r.subscriptionId,
    detail: `${r.sizeGb} GB, ${r.sku}`,
  }));
}

async function unusedPublicIps() {
  const rows = await resourceGraphQuery(
    `
    Resources
    | where type == 'microsoft.network/publicipaddresses' and isnull(properties.ipConfiguration)
    | project id, name, resourceGroup, subscriptionId, allocation = properties.publicIPAllocationMethod
  `,
    { toolId: TOOL_ID }
  );
  return rows.map((r) => ({
    kind: "unused-public-ip",
    id: r.id,
    name: r.name,
    resourceGroup: r.resourceGroup,
    subscriptionId: r.subscriptionId,
    detail: r.allocation,
  }));
}

async function orphanedNics() {
  const rows = await resourceGraphQuery(
    `
    Resources
    | where type == 'microsoft.network/networkinterfaces' and isnull(properties.virtualMachine)
    | project id, name, resourceGroup, subscriptionId
  `,
    { toolId: TOOL_ID }
  );
  return rows.map((r) => ({
    kind: "orphaned-nic",
    id: r.id,
    name: r.name,
    resourceGroup: r.resourceGroup,
    subscriptionId: r.subscriptionId,
    detail: "not attached to any VM",
  }));
}

async function emptyResourceGroups() {
  const rows = await resourceGraphQuery(
    `
    ResourceContainers
    | where type == 'microsoft.resources/subscriptions/resourcegroups'
    | join kind=leftouter (
        Resources | summarize resourceCount = count() by resourceGroup, subscriptionId
      ) on $left.name == $right.resourceGroup, $left.subscriptionId == $right.subscriptionId
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

async function run() {
  const results = await Promise.allSettled([
    unattachedDisks(),
    unusedPublicIps(),
    orphanedNics(),
    emptyResourceGroups(),
  ]);

  const findings = [];
  for (const r of results) {
    if (r.status === "fulfilled") findings.push(...r.value);
    // A single failed query (e.g. missing Reader role on a subscription)
    // shouldn't blank out the other three; it surfaces as fewer findings
    // plus the error logged by toolRegistry's catch-all, since run() still
    // throws if ALL queries fail together below.
  }
  if (results.every((r) => r.status === "rejected")) {
    throw results[0].reason;
  }
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Orphaned resources",
  schedule: "0 3 * * *", // nightly at 03:00
  run,
};
