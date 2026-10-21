const { armPost, subscriptionIdsToScan } = require("../armClient");
const settings = require("../settings");

const TOOL_ID = "cost-anomaly";

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
  // Large results come in pages: properties.nextLink is posted again with the
  // same body until it is gone (the first page alone missed resource groups).
  const result = { columns: [], rows: [] };
  for (let next = url, pages = 0; next && pages < 50; pages++) {
    const props = (await armPost(next, body, TOOL_ID)).properties || {};
    if (!result.columns.length) result.columns = props.columns || [];
    result.rows.push(...(props.rows || []));
    next = props.nextLink || null;
  }
  return result;
}

// Cost Management returns UsageDate as a number like 20261019.
function normalizeDay(value) {
  const s = String(value);
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s.slice(0, 10);
}

function rowsByDayAndGroup(result) {
  const columns = result.columns.map((c) => c.name);
  const dayIdx = columns.indexOf("UsageDate");
  const costIdx = columns.indexOf("Cost");
  const groupIdx = columns.indexOf("ResourceGroupName");
  const out = {};
  for (const row of result.rows || []) {
    const day = normalizeDay(row[dayIdx]);
    const group = row[groupIdx] || "(none)";
    const cost = Number(row[costIdx]) || 0;
    out[day] = out[day] || {};
    out[day][group] = (out[day][group] || 0) + cost;
  }
  return out;
}

// Cost Management throttles hard per tenant; a few parallel queries plus the
// 429 retries in armClient keep a scan of hundreds of subscriptions steady.
const CONCURRENCY = 4;

async function run() {
  const subscriptionIds = await subscriptionIdsToScan(TOOL_ID);
  const thresholdPct = Number(settings.get("AZURE_COST_ANOMALY_THRESHOLD_PCT")) || 50;

  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const dayBefore = new Date(today);
  dayBefore.setDate(today.getDate() - 2);

  const findings = [];
  const failures = [];
  const queue = [...subscriptionIds];
  const worker = async () => {
    while (queue.length) {
      const subscriptionId = queue.shift();
      try {
        scanSubscription(subscriptionId, await costForSubscription(subscriptionId, dayBefore, today));
      } catch (err) {
        failures.push({ subscriptionId, message: String(err.message || err).slice(0, 300) });
      }
    }
  };

  function scanSubscription(subscriptionId, result) {
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

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

  // One subscription without Cost Management access must not hide the rest.
  if (failures.length) {
    if (failures.length === subscriptionIds.length) {
      throw new Error(`Cost query failed for all ${failures.length} subscriptions, e.g. ${failures[0].message}`);
    }
    findings.push({
      kind: "scan-error",
      id: "cost-anomaly/scan-errors",
      name: `${failures.length} of ${subscriptionIds.length} subscriptions not scanned`,
      subscriptionId: failures[0].subscriptionId,
      detail: failures[0].message,
    });
  }
  return findings;
}

module.exports = {
  id: "cost-anomaly",
  label: "Cost anomalies",
  schedule: "0 7 * * *", // nightly at 07:00, once the prior day's cost data has settled
  run,
};
