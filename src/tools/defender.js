// Microsoft Defender for Cloud in short: each subscription's secure score,
// the unhealthy recommendations (one finding per recommendation and
// subscription, with how many resources it hits), Defender plans that are
// off although they should be on, plans that are on in some subscriptions
// but off in others, Defender for Servers on Plan 1 where other subscriptions
// have Plan 2, agentless scanning off where the plan includes it, security
// contacts that tell nobody about alerts, and open High and Medium alerts.
// Reader is enough; the free tier (Foundational CSPM) gives the score and
// recommendations.
const { resourceGraphQuery, armGet, subscriptionIdsToScan } = require("../armClient");
const settings = require("../settings");
const { numberSetting, mapLimit, itemErrors, runChecks, scanError } = require("./util");

const TOOL_ID = "defender";
const CONCURRENCY = 6;
const PRICINGS_API = "2024-01-01";
const CONTACTS_API = "2023-12-01-preview";
const MAX_ALERT_FINDINGS = 200;
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
    | extend sev = tolower(tostring(properties.metadata.severity)), recTitle = tostring(properties.displayName), recKey = tostring(name)
    | where sev in (${wanted.map((s) => `'${s}'`).join(", ")})
    | summarize hits = count() by subscriptionId, recKey, sev, recTitle`,
    { toolId: TOOL_ID }
  );
  // Column names stay clear of table names and KQL words ("resources", "key", "title", "severity"): Resource Graph
  // fails to parse those (ParserFailure at <EOF> with "severity, title" ending the summarize).
  return rows.map((r) => ({
    kind: `defender-${r.sev}`,
    id: `/subscriptions/${r.subscriptionId}/providers/Microsoft.Security/assessments/${r.recKey}`,
    name: r.recTitle || r.recKey,
    subscriptionId: r.subscriptionId,
    resources: r.hits,
    detail: `${r.hits} resource${r.hits === 1 ? "" : "s"} unhealthy. ${recommendationLink(r.recKey)}`,
  }));
}

// tiers: [{ subscriptionId, plan, on }] for every plan read. Plans that must be on (required: "all" or a Set of
// lower-case names) and are off; plans not required that are on in some subscriptions but off in others (likely a
// subscription added later and forgotten). Pure, for the tests.
function judgePlans(tiers, required) {
  const must = (plan) => required === "all" || required.has(plan.toLowerCase());
  const onIn = new Map();
  for (const t of tiers) if (t.on) onIn.set(t.plan, (onIn.get(t.plan) || 0) + 1);
  const findings = [];
  for (const t of tiers) {
    if (t.on) continue;
    const base = { id: `/subscriptions/${t.subscriptionId}/providers/Microsoft.Security/pricings/${t.plan}`, name: `Defender for ${t.plan}`, subscriptionId: t.subscriptionId };
    if (must(t.plan)) {
      findings.push({ ...base, kind: "defender-plan-off", detail: "Plan is off (Free tier) but listed in Plans that must be on. Turn it on in Defender for Cloud, Environment settings" });
    } else if (onIn.get(t.plan)) {
      const n = onIn.get(t.plan);
      findings.push({ ...base, kind: "defender-plan-uneven", detail: `Plan is off here but on in ${n} other subscription${n === 1 ? "" : "s"}, so this one is not covered. Turn it on, or add it to Plans that must be on to make the rule explicit` });
    }
  }
  return findings;
}

const extOff = (t, name) => (t.extensions || []).some((e) => e && String(e.name).toLowerCase() === name.toLowerCase() && /^false$/i.test(String(e.isEnabled)));

// Sub-features of plans that are on: Defender for Servers on Plan 1 while other subscriptions pay for Plan 2 (Plan 1
// lacks agentless scanning, premium vulnerability management, file integrity monitoring and just-in-time VM access;
// it still has Defender for Endpoint with its basic vulnerability assessment), and agentless machine scanning
// turned off in Servers Plan 2 or Defender CSPM, which include it. Only extensions the API lists as off count. Pure.
function judgePlanDetails(tiers) {
  const findings = [];
  const p2 = tiers.filter((t) => t.on && /^virtualmachines$/i.test(t.plan) && /^p2$/i.test(t.subPlan || "")).length;
  for (const t of tiers) {
    if (!t.on) continue;
    const base = { id: `/subscriptions/${t.subscriptionId}/providers/Microsoft.Security/pricings/${t.plan}`, subscriptionId: t.subscriptionId };
    const servers = /^virtualmachines$/i.test(t.plan);
    if (servers && /^p1$/i.test(t.subPlan || "") && p2) {
      findings.push({ ...base, id: `${base.id}#p1`, kind: "defender-servers-p1", name: "Defender for Servers", detail: `Plan 1 here, but Plan 2 in ${p2} other subscription${p2 === 1 ? "" : "s"}. Plan 1 lacks agentless scanning, premium vulnerability management, file integrity monitoring and just-in-time VM access. Fine if chosen on purpose; otherwise move this subscription to Plan 2` });
    }
    const includesAgentless = (servers && /^p2$/i.test(t.subPlan || "")) || /^cloudposture$/i.test(t.plan);
    if (includesAgentless && extOff(t, "AgentlessVmScanning")) {
      findings.push({ ...base, id: `${base.id}#agentless`, kind: "defender-agentless-off", name: servers ? "Defender for Servers" : "Defender CSPM", detail: `Agentless machine scanning is off although the plan${servers ? " (Plan 2)" : ""} includes it, so disks are not scanned for vulnerabilities, secrets and malware without an agent. Turn it on in Environment settings, Settings and monitoring` });
    }
  }
  return findings;
}

// Plans are read per subscription from ARM, the one place every plan shows.
async function plans() {
  const raw = String(settings.get("DEFENDER_REQUIRED_PLANS") || "").trim();
  const required = /^all$/i.test(raw) ? "all" : new Set(raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  const subs = await subscriptionIdsToScan(TOOL_ID);
  const tiers = [];
  const failures = await mapLimit(subs.map((subscriptionId) => ({ subscriptionId })), CONCURRENCY, async ({ subscriptionId }) => {
    const page = await armGet(`https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Security/pricings?api-version=${PRICINGS_API}`, TOOL_ID);
    for (const p of page.value || []) {
      const props = p.properties || {};
      if (props.deprecated) continue;
      tiers.push({ subscriptionId, plan: p.name, on: String(props.pricingTier).toLowerCase() !== "free", subPlan: props.subPlan || "", extensions: Array.isArray(props.extensions) ? props.extensions : [] });
    }
  });
  if (subs.length && failures.length === subs.length) throw new Error(`every plan list failed, e.g. ${failures[0].message}`);
  // With no required plans, one subscription has nothing to compare against.
  const planFindings = !raw && subs.length < 2 ? [] : judgePlans(tiers, required);
  return [...planFindings, ...judgePlanDetails(tiers), ...itemErrors(TOOL_ID, "pricings", "subscriptions' plans", failures, subs.length)];
}

// list: [{ subscriptionId, contacts: [security contact] }]. Per subscription: nobody gets alert e-mails (no contact,
// contact turned off, or no address and role notifications off), alert e-mails turned off (no Alert source), or no
// e-mail address of its own (only role holders such as Owners are told). Pure, for the tests.
function judgeContacts(list) {
  const findings = [];
  for (const { subscriptionId, contacts } of list) {
    const id = `/subscriptions/${subscriptionId}/providers/Microsoft.Security/securityContacts/default`;
    const base = { id, name: "Security contact", subscriptionId };
    const live = (contacts || []).filter((c) => c && c.properties && c.properties.isEnabled !== false);
    const emails = live.flatMap((c) => String(c.properties.emails || "").split(/[;,]/).map((e) => e.trim()).filter(Boolean));
    const byRole = (c) => c.properties.notificationsByRole || {};
    const roles = live.some((c) => /^on$/i.test(byRole(c).state || "") && (byRole(c).roles || []).length);
    if (!live.length || (!emails.length && !roles)) {
      findings.push({ ...base, kind: "defender-no-contact", detail: `${live.length ? "The security contact has no e-mail address and role notifications are off" : "No security contact is set"}, so nobody is e-mailed about Defender alerts. Add an address in Environment settings, Email notifications` });
      continue;
    }
    const alertSources = live.flatMap((c) => (c.properties.notificationsSources || []).filter((n) => n && /^alert$/i.test(n.sourceType || "")));
    if (!alertSources.length) {
      findings.push({ ...base, kind: "defender-alert-mail-off", detail: "E-mail notifications for alerts are off, so new Defender alerts reach nobody by mail. Turn on \"Notify about alerts with the following severity\" in Email notifications" });
    } else if (!emails.length) {
      findings.push({ ...base, kind: "defender-contact-no-email", detail: "No e-mail address is set on the security contact; only people in the chosen roles (such as Owner) are told about alerts. Add a monitored team address" });
    }
  }
  return findings;
}

async function contacts() {
  const subs = await subscriptionIdsToScan(TOOL_ID);
  const list = [];
  const failures = await mapLimit(subs.map((subscriptionId) => ({ subscriptionId })), CONCURRENCY, async ({ subscriptionId }) => {
    const page = await armGet(`https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Security/securityContacts?api-version=${CONTACTS_API}`, TOOL_ID);
    list.push({ subscriptionId, contacts: page.value || [] });
  });
  if (subs.length && failures.length === subs.length) throw new Error(`every security contact read failed, e.g. ${failures[0].message}`);
  return [...judgeContacts(list), ...itemErrors(TOOL_ID, "contacts", "subscriptions' security contacts", failures, subs.length)];
}

// rows: open High and Medium alerts grouped per subscription, alert type and severity, with how many and the oldest
// start time. One finding per group, High first, then oldest first; capped. Pure, for the tests.
function judgeAlerts(rows, now = Date.now()) {
  const high = (r) => (/^high$/i.test(r.sev) ? 1 : 0);
  const time = (r) => Date.parse(r.oldest) || now;
  const sorted = [...rows].sort((a, b) => high(b) - high(a) || time(a) - time(b));
  const findings = sorted.slice(0, MAX_ALERT_FINDINGS).map((r) => {
    const days = Math.max(0, Math.floor((now - time(r)) / 86400000));
    const n = Number(r.hits) || 1;
    const sev = high(r) ? "high" : "medium";
    return {
      kind: `defender-alert-${sev}`,
      id: `/subscriptions/${r.subscriptionId}/providers/Microsoft.Security/alerts#${sev}/${String(r.alertType || r.alertName || "alert").toLowerCase()}`,
      name: r.alertName || r.alertType || "Defender alert",
      subscriptionId: r.subscriptionId,
      alerts: n,
      ageDays: days,
      detail: `${n} open ${sev} severity alert${n === 1 ? "" : "s"}${r.entity ? ` (for example on ${r.entity})` : ""}, the oldest ${days === 0 ? "from today" : `${days} day${days === 1 ? "" : "s"} old`}. Look into it in Defender for Cloud, Security alerts, then resolve or dismiss it`,
    };
  });
  if (rows.length > MAX_ALERT_FINDINGS) {
    findings.push(scanError(TOOL_ID, "alerts-cap", `Showing ${MAX_ALERT_FINDINGS} of ${rows.length} open alert groups`, "The rest are left out to keep the list short; see Defender for Cloud, Security alerts"));
  }
  return findings;
}

async function alerts() {
  // Resource Graph names the alert fields in PascalCase (properties.Status); camelCase is read too in case it differs.
  const rows = await resourceGraphQuery(
    `securityresources
    | where type =~ 'microsoft.security/locations/alerts'
    | extend st = tostring(coalesce(properties.Status, properties.status)), sev = tostring(coalesce(properties.Severity, properties.severity))
    | where st =~ 'Active' and sev in~ ('High', 'Medium')
    | extend alertType = tostring(coalesce(properties.AlertType, properties.alertType)), alertName = tostring(coalesce(properties.AlertDisplayName, properties.alertDisplayName)),
        started = todatetime(tostring(coalesce(properties.StartTimeUtc, properties.startTimeUtc, properties.TimeGeneratedUtc, properties.timeGeneratedUtc))),
        entity = tostring(coalesce(properties.CompromisedEntity, properties.compromisedEntity))
    | summarize hits = count(), oldest = min(started), entity = take_any(entity), alertName = take_any(alertName) by subscriptionId, alertType, sev`,
    { toolId: TOOL_ID }
  );
  return judgeAlerts(rows);
}

async function run() {
  return runChecks(TOOL_ID, { "Secure score": scores, Recommendations: recommendations, Plans: plans, "Security contacts": contacts, "Open alerts": alerts });
}

module.exports = {
  id: TOOL_ID,
  label: "Defender for Cloud",
  schedule: "40 6 * * *", // daily at 06:40
  run,
  _test: { judgePlans, judgePlanDetails, judgeContacts, judgeAlerts },
};
