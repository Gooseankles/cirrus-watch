// Subscription quotas close to their limit (vCPUs, public IPs, storage
// accounts and the like) in every region the subscription uses, before a
// deployment or scale-out fails on them. Reader is enough.
const { resourceGraphQuery, armGet } = require("../armClient");
const { numberSetting, mapLimit, itemErrors } = require("./util");

const TOOL_ID = "quotas";
const CONCURRENCY = 6;
const AT_LIMIT_PCT = 95;

const PROVIDERS = [
  { key: "compute", label: "Compute", url: (s, l) => `/subscriptions/${s}/providers/Microsoft.Compute/locations/${l}/usages?api-version=2023-07-01` },
  { key: "network", label: "Network", url: (s, l) => `/subscriptions/${s}/providers/Microsoft.Network/locations/${l}/usages?api-version=2023-09-01` },
  { key: "storage", label: "Storage", url: (s, l) => `/subscriptions/${s}/providers/Microsoft.Storage/locations/${l}/usages?api-version=2023-01-01` },
];

// A provider the subscription never registered has no quota to run out of.
const notRegistered = (msg) => /MissingSubscriptionRegistration|SubscriptionNotRegistered|NoRegisteredProviderFound|\(404\)/i.test(msg);

async function run() {
  const warnPct = numberSetting("QUOTA_WARN_PCT", 80, { min: 1, max: 100 });
  const regions = await resourceGraphQuery(
    `Resources
    | where isnotempty(location) and location !in~ ('global', '')
    | summarize by subscriptionId, location = tolower(location)`,
    { toolId: TOOL_ID }
  );
  const calls = regions.flatMap((r) => PROVIDERS.map((p) => ({ ...r, provider: p })));
  const findings = [];
  const failures = await mapLimit(calls, CONCURRENCY, async (c) => {
    let url = `https://management.azure.com${c.provider.url(c.subscriptionId, c.location)}`;
    try {
      while (url) {
        const page = await armGet(url, TOOL_ID);
        for (const u of page.value || []) {
          const limit = Number(u.limit), current = Number(u.currentValue);
          if (!(limit > 0) || !(current > 0) || limit >= 2147483647) continue;
          const pct = (current / limit) * 100;
          if (pct < warnPct) continue;
          const name = (u.name && (u.name.localizedValue || u.name.value)) || "quota";
          findings.push({
            kind: pct >= AT_LIMIT_PCT ? "quota-at-limit" : "quota-near-limit",
            id: `/subscriptions/${c.subscriptionId}/locations/${c.location}/${c.provider.key}/${(u.name && u.name.value) || name}`,
            name: `${name} (${c.location})`,
            subscriptionId: c.subscriptionId,
            usedPct: Math.round(pct),
            detail: `${c.provider.label}: ${current.toLocaleString("en-US")} of ${limit.toLocaleString("en-US")} used (${Math.round(pct)}%) in ${c.location}. Ask for more in Quotas before the next deployment`,
          });
        }
        url = page.nextLink || null;
      }
    } catch (err) {
      if (!notRegistered(err.message)) throw err;
    }
  });
  if (calls.length && failures.length === calls.length) throw new Error(`every usage call failed, e.g. ${failures[0].message}`);
  return [...findings, ...itemErrors(TOOL_ID, "usages", "region quota lists", failures, calls.length)];
}

module.exports = {
  id: TOOL_ID,
  label: "Quotas",
  schedule: "45 4 * * *", // daily at 04:45
  run,
};
