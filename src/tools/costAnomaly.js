const { armPost, configuredSubscriptionIds } = require("../armClient");
const settings = require("../settings");

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Compares yesterday's spend per resource group against the day before, per
// subscription, and flags jumps over the configured threshold.
async function costForSubscription(subscriptionId, from, to) {
  const url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
  const body = {
    type: "ActualCost",
    timeframe: "Custom",
    timePeriod: { from: isoDate(from), to: isoDate(to) },
    dataset: {
      granularity: "Daily",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [{ type: "Dimension", name: "ResourceGroupName" }],
    },
  };
  const data = await armPost(url, body, "cost-anomaly");
  return data.properties || { columns: [], rows: [] };
}

function rowsByDayAndGroup(result) {
  const columns = result.columns.map((c) => c.name);
  const dayIdx = columns.indexOf("UsageDate");
  const costIdx = columns.indexOf("Cost");
  const groupIdx = columns.indexOf("ResourceGroupName");
  const out = {};
  for (const row of result.rows || []) {
    const day = String(row[dayIdx]);
    const group = row[groupIdx] || "(none)";
    const cost = Number(row[costIdx]) || 0;
    out[day] = out[day] || {};
    out[day][group] = (out[day][group] || 0) + cost;
  }
  return out;
}

async function run() {
  const subscriptionIds = configuredSubscriptionIds();
  if (!subscriptionIds.length) {
    throw new Error("AZURE_SUBSCRIPTION_IDS is not set — cost anomaly scan needs at least one subscription ID");
  }
  const thresholdPct = Number(settings.get("AZURE_COST_ANOMALY_THRESHOLD_PCT")) || 50;

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const dayBefore = new Date(today);
  dayBefore.setDate(today.getDate() - 2);

  const findings = [];
  for (const subscriptionId of subscriptionIds) {
    const result = await costForSubscription(subscriptionId, dayBefore, today);
    const byDay = rowsByDayAndGroup(result);
    const yKey = isoDate(yesterday);
    const bKey = isoDate(dayBefore);
    const yesterdayCosts = byDay[yKey] || {};
    const beforeCosts = byDay[bKey] || {};

    for (const [group, cost] of Object.entries(yesterdayCosts)) {
      const prior = beforeCosts[group] || 0;
      if (prior <= 0) continue; // new spend with no baseline isn't an "anomaly" to compare against
      const changePct = ((cost - prior) / prior) * 100;
      if (changePct >= thresholdPct) {
        findings.push({
          kind: "cost-jump",
          id: `${subscriptionId}/${group}/${yKey}`,
          name: group,
          resourceGroup: group,
          subscriptionId,
          detail: `${prior.toFixed(2)} -> ${cost.toFixed(2)} (+${changePct.toFixed(0)}%)`,
        });
      }
    }
  }
  return findings;
}

module.exports = {
  id: "cost-anomaly",
  label: "Cost anomalies",
  schedule: "0 7 * * *", // nightly at 07:00, once the prior day's cost data has settled
  run,
};
