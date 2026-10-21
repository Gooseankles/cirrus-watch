const { resourceGraphQuery } = require("../armClient");
const { runChecks } = require("./util");

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

// A NAT gateway's public IP has no ipConfiguration but is in use.
async function unusedPublicIps() {
  const rows = await resourceGraphQuery(
    `
    Resources
    | where type == 'microsoft.network/publicipaddresses' and isnull(properties.ipConfiguration) and isnull(properties.natGateway)
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

// Private endpoints and private link services own NICs with no VM.
async function orphanedNics() {
  const rows = await resourceGraphQuery(
    `
    Resources
    | where type == 'microsoft.network/networkinterfaces' and isnull(properties.virtualMachine)
    | where isnull(properties.privateEndpoint) and isnull(properties.privateLinkService)
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

// A failed check shows as a scan-error finding instead of silently fewer
// findings; run() throws only when every check fails.
function run() {
  return runChecks(TOOL_ID, {
    "Unattached disks": unattachedDisks,
    "Unused public IPs": unusedPublicIps,
    "Orphaned NICs": orphanedNics,
    "Empty resource groups": emptyResourceGroups,
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Orphaned resources",
  schedule: "0 3 * * *", // nightly at 03:00
  run,
};
