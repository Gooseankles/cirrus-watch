// Azure features and services being retired that resources here still use,
// from Azure Advisor's "Service upgrade and retirement" recommendations.
// Reader is enough.
const { resourceGraphQuery } = require("../armClient");
const { numberSetting, daysUntil, nameOf } = require("./util");

const TOOL_ID = "service-retirements";

async function run() {
  const rows = await resourceGraphQuery(
    `advisorresources
    | where type =~ 'microsoft.advisor/recommendations'
    | extend ep = properties.extendedProperties
    | where tostring(ep.recommendationSubCategory) =~ 'ServiceUpgradeAndRetirement' or isnotempty(ep.retirementDate)
    | project id, subscriptionId, resourceGroup,
        resourceId = tostring(properties.resourceMetadata.resourceId), impacted = tostring(properties.impactedValue),
        problem = tostring(properties.shortDescription.problem), solution = tostring(properties.shortDescription.solution),
        retirementDate = tostring(ep.retirementDate), feature = tostring(ep.retirementFeatureName), link = tostring(properties.learnMoreLink)`,
    { toolId: TOOL_ID }
  );
  const warn = numberSetting("RETIREMENT_WARN_DAYS", 180, { min: 0, max: 3650 });
  return rows.map((r) => {
    const date = Date.parse(r.retirementDate) ? new Date(r.retirementDate).toISOString().slice(0, 10) : null;
    const days = date ? daysUntil(date) : null;
    const kind = days == null || days > warn ? "retirement-planned" : days < 0 ? "retirement-past" : "retirement-soon";
    const what = r.feature || r.problem || "Retirement";
    return {
      kind,
      id: r.id,
      name: r.impacted || nameOf(r.resourceId) || what,
      resourceGroup: r.resourceGroup || null,
      subscriptionId: r.subscriptionId || null,
      ...(date && { expires: date }),
      detail: [what, r.solution && r.solution !== what ? r.solution : "", r.link || ""].filter(Boolean).join(". "),
    };
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Service retirements",
  schedule: "15 6 * * *", // daily at 06:15
  run,
};
