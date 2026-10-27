// Resource Health and Service Health right now: resources Azure reports as
// Unavailable or Degraded (with the latest health annotation: why and since
// when; VMs the user stopped or deallocated are left out), and Service Health
// events that hit the scanned subscriptions: active service issues, active
// health and security advisories, and planned maintenance that starts soon.
// Retirement advisories are left to Service retirements; whether anyone gets
// a Service Health alert is checked by Resilience. Resource Graph only
// (HealthResources and ServiceHealthResources), so Reader is enough and it is
// cheap enough to run every hour.
const { resourceGraphQuery } = require("../armClient");
const { numberSetting, runChecks, nameOf } = require("./util");

const TOOL_ID = "resource-health";
const DAY_MS = 86400000;

// Resource Graph gives times as ISO strings or as epoch milliseconds (number or string). A value a date cannot
// hold (Service Health puts far-future placeholders in for "no end yet") counts as unknown.
const MAX_MS = 8.64e15;
function toMs(v) {
  if (v === null || v === undefined || v === "") return NaN;
  const ms = typeof v === "number" ? v : /^\d{10,}$/.test(String(v).trim()) ? Number(v) : Date.parse(v);
  return Number.isFinite(ms) && Math.abs(ms) <= MAX_MS ? ms : NaN;
}
const valid = (ms) => Number.isFinite(ms) && Math.abs(ms) <= MAX_MS;
const day = (ms) => (valid(ms) ? new Date(ms).toISOString().slice(0, 10) : "unknown date");
const when = (ms) => (valid(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "an unknown time");
const rgOf = (id) => (String(id).match(/\/resourceGroups\/([^/]+)/i) || [])[1] || null;
const subOf = (id) => (String(id).match(/^\/subscriptions\/([^/]+)/i) || [])[1] || null;

// Stopped or deallocated by someone on purpose: not an outage.
const userInitiated = (r) => /user|customer/i.test(r.context || "") || /stopped|deallocat/i.test(r.power || "");

// rows: [{ id, targetType, state, since, previous, power, annotation, reason, summary, context, category, subscriptionId }].
// Pure, for the tests.
function judgeResources(rows) {
  const findings = [];
  for (const r of rows) {
    const state = String(r.state || "").toLowerCase();
    if (state !== "unavailable" && state !== "degraded") continue;
    if (userInitiated(r)) continue;
    const why = [r.reason, r.summary].map((s) => String(s || "").trim()).filter(Boolean);
    const cause = r.category && !/not applicable|null/i.test(r.category) ? ` (${r.category.toLowerCase()})` : "";
    findings.push({
      kind: state === "unavailable" ? "health-unavailable" : "health-degraded",
      id: `${r.id}#health`,
      name: nameOf(r.id),
      resourceGroup: r.resourceGroup || rgOf(r.id),
      subscriptionId: r.subscriptionId || subOf(r.id),
      state: r.state,
      detail: `${state === "unavailable" ? "Unavailable" : "Degraded"} since ${when(toMs(r.since))}${cause}${why.length ? `: ${why.join(" ").slice(0, 300).replace(/[.\s]+$/, "")}` : ""}. See Resource Health on the resource for what to do`,
    });
  }
  return findings;
}

async function resources() {
  const rows = await resourceGraphQuery(
    `HealthResources
    | where type =~ 'microsoft.resourcehealth/availabilitystatuses'
    | extend state = tostring(properties.availabilityState)
    | where state in~ ('Unavailable', 'Degraded')
    | project id = tolower(tostring(properties.targetResourceId)), targetType = tostring(properties.targetResourceType), state,
        since = tostring(properties.occurredTime), previous = tostring(properties.previousAvailabilityState), subscriptionId
    | join kind=leftouter (
        HealthResources
        | where type =~ 'microsoft.resourcehealth/resourceannotations'
        | extend id = tolower(tostring(properties.targetResourceId)), at = todatetime(properties.occurredTime)
        | summarize arg_max(at, *) by id
        | project id, annotation = tostring(properties.annotationName), reason = tostring(properties.reason),
            summary = tostring(properties.summary), context = tostring(properties.context), category = tostring(properties.category)
      ) on id
    | join kind=leftouter (
        Resources
        | where type =~ 'microsoft.compute/virtualmachines'
        | project id = tolower(id), power = tostring(properties.extended.instanceView.powerState.code)
      ) on id
    | project id, targetType, state, since, previous, subscriptionId, annotation, reason, summary, context, category, power`,
    { toolId: TOOL_ID }
  );
  return judgeResources(rows);
}

// Impact: [{ ImpactedService, ImpactedRegions: [{ ImpactedRegion }] }] -> "Service (region, region); ...".
function impactText(impact) {
  let list = impact;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return "";
    }
  }
  if (!Array.isArray(list)) return "";
  const parts = list.map((i) => {
    const regions = (i.ImpactedRegions || i.impactedRegions || []).map((r) => r.ImpactedRegion || r.impactedRegion).filter(Boolean);
    const service = i.ImpactedService || i.impactedService || "service";
    return regions.length ? `${service} (${regions.join(", ")})` : service;
  });
  const text = parts.slice(0, 5).join("; ");
  return parts.length > 5 ? `${text} and ${parts.length - 5} more` : text;
}

// The short link Service Health itself uses: tracking ID plus the subscription ID's first and last three characters.
const eventLink = (trackingId, sub) => `https://app.azure.com/h/${trackingId}/${String(sub).slice(0, 3)}${String(sub).slice(-3)}`;

// rows: [{ subscriptionId, trackingId, eventType, subType, status, title, start, end, impact }], one per event and
// subscription. One finding per event per subscription. Pure, for the tests.
function judgeEvents(rows, lookAheadDays, now = Date.now()) {
  const findings = [];
  for (const e of rows) {
    const type = String(e.eventType || "");
    const start = toMs(e.start);
    const end = toMs(e.end);
    const ongoing = !Number.isFinite(end) || end > now;
    let kind;
    if (type === "ServiceIssue") kind = /^active$/i.test(e.status || "") ? "service-issue" : null;
    else if (type === "PlannedMaintenance") kind = ongoing && lookAheadDays > 0 && (!Number.isFinite(start) || start <= now + lookAheadDays * DAY_MS) ? "service-maintenance" : null;
    else if (type === "HealthAdvisory" || type === "SecurityAdvisory") kind = ongoing && !/retirement/i.test(e.subType || "") ? "service-advisory" : null;
    if (!kind) continue;
    const impact = impactText(e.impact);
    const what = impact ? ` Affects ${impact}.` : "";
    const link = e.trackingId ? ` ${eventLink(e.trackingId, e.subscriptionId)}` : "";
    let detail;
    if (kind === "service-issue") detail = `Azure outage going on since ${when(start)}.${what} Check whether your workloads are hit and follow the updates${link}`;
    else if (kind === "service-maintenance") detail = `${start > now ? "Planned maintenance starts" : "Planned maintenance under way since"} ${when(start)}${Number.isFinite(end) ? `, ends ${day(end)}` : ""}.${what} Read what to expect and whether you must act${link}`;
    else detail = `${type === "SecurityAdvisory" ? "Security advisory" : "Health advisory"} from ${day(start)}${Number.isFinite(end) ? ` until ${day(end)}` : ""}.${what} Read it and act on it if it applies${link}`;
    findings.push({
      kind,
      id: `/subscriptions/${e.subscriptionId}/providers/Microsoft.ResourceHealth/events/${e.trackingId}`,
      name: e.title || e.trackingId,
      resourceGroup: null,
      subscriptionId: e.subscriptionId,
      trackingId: e.trackingId,
      eventType: type,
      detail,
    });
  }
  return findings;
}

async function events() {
  const days = numberSetting("HEALTH_MAINTENANCE_DAYS", 14, { min: 0, max: 365 });
  const rows = await resourceGraphQuery(
    `ServiceHealthResources
    | where type =~ 'microsoft.resourcehealth/events'
    | extend eventType = tostring(properties.EventType), status = tostring(properties.Status)
    | where eventType in ('ServiceIssue', 'PlannedMaintenance', 'HealthAdvisory', 'SecurityAdvisory')
    | where eventType != 'ServiceIssue' or status =~ 'Active'
    | project subscriptionId, trackingId = iff(isempty(tostring(properties.TrackingId)), name, tostring(properties.TrackingId)), eventType, subType = tostring(properties.EventSubType),
        status, title = tostring(properties.Title), start = properties.ImpactStartTime, end = properties.ImpactMitigationTime, impact = properties.Impact`,
    { toolId: TOOL_ID }
  );
  return judgeEvents(rows, days);
}

async function run() {
  return runChecks(TOOL_ID, { "Resource Health": resources, "Service Health events": events });
}

module.exports = {
  id: TOOL_ID,
  label: "Resource health",
  schedule: "5 * * * *", // every hour at :05
  run,
  _test: { judgeResources, judgeEvents, impactText, toMs },
};
