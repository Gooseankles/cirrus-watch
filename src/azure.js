const { armPut, armGet } = require("./armClient");
const settings = require("./settings");

const API_VERSION = "2021-10-01";

// Creates a subscription alias, which Azure resolves into a real subscription.
// displayName: shown in the Azure portal / cost reports.
// ticketNumber: the ServiceNow ticket number, used as the alias name so the
// two systems can be cross-referenced later.
async function createSubscription({ displayName, ticketNumber }) {
  const billingScope = settings.get("AZURE_BILLING_SCOPE");
  if (!billingScope) {
    throw new Error("AZURE_BILLING_SCOPE is not set — see .env.example or the Settings tab");
  }

  const aliasName = `snow-${ticketNumber}`.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const managementGroupId = settings.get("AZURE_MANAGEMENT_GROUP_ID");

  const body = {
    properties: {
      workload: "Production",
      displayName,
      billingScope,
      ...(managementGroupId && {
        additionalProperties: {
          managementGroupId,
        },
      }),
    },
  };

  const url = `https://management.azure.com/providers/Microsoft.Subscription/aliases/${aliasName}?api-version=${API_VERSION}`;
  const data = await armPut(url, body, "subscription-create");

  // Alias creation is asynchronous; caller can poll getAliasStatus(aliasName)
  // until properties.provisioningState is "Succeeded" and a subscriptionId appears.
  return { aliasName, raw: data };
}

async function getAliasStatus(aliasName) {
  const url = `https://management.azure.com/providers/Microsoft.Subscription/aliases/${aliasName}?api-version=${API_VERSION}`;
  return armGet(url, "subscription-create");
}

module.exports = { createSubscription, getAliasStatus };
