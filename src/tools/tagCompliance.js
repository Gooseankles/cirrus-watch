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

  // Every resource (resourceGraphQuery follows the pages).
  const rows = await resourceGraphQuery(
    `
    Resources
    | project id, name, type, resourceGroup, subscriptionId, tags
  `,
    { toolId: TOOL_ID }
  );

  const findings = [];
  for (const r of rows) {
    // Azure treats tag names case-insensitively ("owner" is "Owner").
    const tags = new Map(Object.entries(r.tags || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const missing = required.filter((t) => String(tags.get(t.toLowerCase()) ?? "").trim() === "");
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
