const { resourceGraphQuery } = require("../armClient");
const settings = require("../settings");

const TOOL_ID = "tag-compliance";

function requiredTags() {
  return (settings.get("AZURE_REQUIRED_TAGS") || "CostCenter,Owner,Environment")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

async function run() {
  const required = requiredTags();

  // Resource Graph pages at 1000 rows per call; a single page is enough to
  // start finding violators without building out $skipToken paging yet.
  const rows = await resourceGraphQuery(
    `
    Resources
    | project id, name, type, resourceGroup, subscriptionId, tags
    | limit 1000
  `,
    { toolId: TOOL_ID }
  );

  const findings = [];
  for (const r of rows) {
    const tags = r.tags || {};
    const missing = required.filter((t) => !tags[t] || String(tags[t]).trim() === "");
    if (missing.length) {
      findings.push({
        kind: "missing-tags",
        id: r.id,
        name: r.name,
        resourceGroup: r.resourceGroup,
        subscriptionId: r.subscriptionId,
        detail: `missing: ${missing.join(", ")}`,
      });
    }
  }
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Tag compliance",
  schedule: "0 4 * * *", // nightly at 04:00
  run,
};
