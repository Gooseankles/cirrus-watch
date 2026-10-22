// Microsoft Defender for Cloud in short: each subscription's secure score,
// the unhealthy recommendations (one finding per recommendation and
// subscription, with how many resources it hits) and Defender plans that are
// off although they should be on. Reader is enough; the free tier (Foundational
// CSPM) gives the score and recommendations.
const { resourceGraphQuery, armGet, subscriptionIdsToScan } = require("../armClient");
const settings = require("../settings");
const { numberSetting, mapLimit, itemErrors, runChecks } = require("./util");

const TOOL_ID = "defender";
const CONCURRENCY = 6;
const PRICINGS_API = "2024-01-01";
const SEVERITIES = ["low", "medium", "high"];
const recommendationLink = (key) => `https://portal.azure.com/#view/Microsoft_Azure_Security/GenericRecommendationDetailsBlade/assessmentKey/${key}`;

async function scores() {
  const min = numberSetting("DEFENDER_MIN_SCORE", 70, { min: 0, max: 100 });
  if (!min) return [];
  const rows = await resourceGraphQuery(
    `securityresources
    | where type =~ 'microsoft.security/securescores' and name =~ 'ascScore'
    | project subscriptionId, current = todouble(properties.score.current), maxScore = todouble(properties.score.max), pct = todouble(properties.score.percentage)`,
    { toolId: TOOL_ID }
  );
  return rows
    .map((r) => ({ ...r, pctNum: Math.round((Number(r.pct) || 0) * 100) }))
    .filter((r) => r.pctNum < min)
    .map((r) => ({
      kind: "defender-low-score",
      id: `/subscriptions/${r.subscriptionId}/providers/Microsoft.Security/secureScores/ascScore`,
      name: "Secure score",
      subscriptionId: r.subscriptionId,
      score: r.pctNum,
      detail: `${r.pctNum}% (${Number(r.current || 0).toFixed(1)} of ${Number(r.maxScore || 0)} points), below ${min}%. The unhealthy recommendations here raise it`,
    }));
}

async function recommendations() {
  const from = SEVERITIES.indexOf(String(settings.get("DEFENDER_MIN_SEVERITY") || "medium").trim().toLowerCase());
  const wanted = SEVERITIES.slice(from < 0 ? 1 : from);
  const rows = await resourceGraphQuery(
    `securityresources
    | where type =~ 'microsoft.security/assessments'
    | where tostring(properties.status.code) =~ 'Unhealthy'
    | extend severity = tolower(tostring(properties.metadata.severity)), title = tostring(properties.displayName)
    | where severity in (${wanted.map((s) => `'${s}'`).join(", ")})
    | summarize resources = count() by subscriptionId, key = name, severity, title`,
    { toolId: TOOL_ID }
  );
  return rows.map((r) => ({
    kind: `defender-${r.severity}`,
    id: `/subscriptions/${r.subscriptionId}/providers/Microsoft.Security/assessments/${r.key}`,
    name: r.title || r.key,
    subscriptionId: r.subscriptionId,
    resources: r.resources,
    detail: `${r.resources} resource${r.resources === 1 ? "" : "s"} unhealthy. ${recommendationLink(r.key)}`,
  }));
}

// Plans are read per subscription from ARM, the one place every plan shows.
async function plans() {
  const raw = String(settings.get("DEFENDER_REQUIRED_PLANS") || "").trim();
  if (!raw) return [];
  const all = /^all$/i.test(raw);
  const required = new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const subs = await subscriptionIdsToScan(TOOL_ID);
  const findings = [];
  const failures = await mapLimit(subs.map((subscriptionId) => ({ subscriptionId })), CONCURRENCY, async ({ subscriptionId }) => {
    const page = await armGet(`https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Security/pricings?api-version=${PRICINGS_API}`, TOOL_ID);
    for (const p of page.value || []) {
      const props = p.properties || {};
      if (props.deprecated) continue;
      if (!all && !required.has(String(p.name).toLowerCase())) continue;
      if (String(props.pricingTier).toLowerCase() !== "free") continue;
      findings.push({
        kind: "defender-plan-off",
        id: `/subscriptions/${subscriptionId}/providers/Microsoft.Security/pricings/${p.name}`,
        name: `Defender for ${p.name}`,
        subscriptionId,
        detail: `Plan is off (Free tier) but listed in Plans that must be on. Turn it on in Defender for Cloud, Environment settings`,
      });
    }
  });
  if (subs.length && failures.length === subs.length) throw new Error(`every plan list failed, e.g. ${failures[0].message}`);
  return [...findings, ...itemErrors(TOOL_ID, "pricings", "subscriptions' plans", failures, subs.length)];
}

async function run() {
  return runChecks(TOOL_ID, { "Secure score": scores, Recommendations: recommendations, Plans: plans });
}

module.exports = {
  id: TOOL_ID,
  label: "Defender for Cloud",
  schedule: "40 6 * * *", // daily at 06:40
  run,
};
