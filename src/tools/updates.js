// Updates and patching, from Azure Update Manager's records in Resource Graph:
// running VMs and connected Arc servers with Critical or Security updates
// pending in their latest assessment (critical when the oldest of them came out
// more than UPDATES_MAX_PENDING_DAYS ago), machines not assessed lately or
// whose assessment failed, running VMs on no patch schedule at all, and
// machines whose latest update installation failed. Reader is enough.
// Update Manager keeps assessments in Resource Graph for 7 days and
// installations for 30, so a machine with no assessment row was not assessed
// in the last 7 days (or never). Legacy agents, disconnected Arc servers and
// operating systems out of support are left to Azure Monitor and End of support.
const { resourceGraphQuery } = require("../armClient");
const { numberSetting, runChecks, scanError } = require("./util");

const TOOL_ID = "updates";
const DAY = 86400000;
const KEEP_DAYS = 7; // how long Resource Graph keeps an assessment
const CLASSES = ["critical", "security", "updateRollup", "featurePack", "servicePack", "definition", "tools", "updates", "other"];
const CLASS_NAMES = { critical: "Critical", security: "Security", updateRollup: "Update rollup", featurePack: "Feature pack", servicePack: "Service pack", definition: "Definition", tools: "Tools", updates: "Updates", other: "Other" };

const low = (s) => String(s || "").toLowerCase();
const subOf = (id) => (low(id).match(/^\/subscriptions\/([^/]+)/) || [])[1] || "";
const rgOf = (id) => (low(id).match(/\/resourcegroups\/([^/]+)/) || [])[1] || "";
const day = (iso) => String(iso || "").slice(0, 10);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const q = (query) => resourceGraphQuery(query, { toolId: TOOL_ID });

/* ---------- reads ---------- */

// Every VM and Arc server, with what decides "running" and the VM patch settings.
const readMachines = () => q(`Resources
  | where type in~ ('microsoft.compute/virtualmachines', 'microsoft.hybridcompute/machines')
  | extend ps = coalesce(properties.osProfile.windowsConfiguration.patchSettings, properties.osProfile.linuxConfiguration.patchSettings)
  | project id = tolower(id), name, type = tolower(type), resourceGroup, subscriptionId, location = tolower(location), tags,
      power = tostring(properties.extended.instanceView.powerState.code), arcStatus = tostring(properties.status),
      os = tostring(coalesce(properties.storageProfile.osDisk.osType, properties.osType)),
      assessmentMode = tostring(ps.assessmentMode), patchMode = tostring(ps.patchMode)`);

// The latest assessment summary per machine.
const readAssessments = () => q(`patchassessmentresources
  | where type in~ ('microsoft.compute/virtualmachines/patchassessmentresults', 'microsoft.hybridcompute/machines/patchassessmentresults')
  | project machineId = tostring(split(tolower(id), '/patchassessmentresults/')[0]), status = tostring(properties.status),
      at = tostring(properties.lastModifiedDateTime), counts = properties.availablePatchCountByClassification,
      error = tostring(properties.errorDetails.message)`);

// Per machine and class, the release date of the oldest pending Critical or Security update (Windows only; Linux gives no date).
const readOldest = () => q(`patchassessmentresources
  | where type in~ ('microsoft.compute/virtualmachines/patchassessmentresults/softwarepatches', 'microsoft.hybridcompute/machines/patchassessmentresults/softwarepatches')
  | extend cls = tostring(properties.classifications)
  | where cls has_any ('Critical', 'Security')
  | extend machineId = tostring(split(tolower(id), '/patchassessmentresults/')[0]), cls = iff(cls has 'Critical', 'critical', 'security'),
      published = todatetime(properties.publishedDateTime)
  | summarize oldest = min(published) by machineId, cls`);

// The latest finished installation run per machine (Resource Graph keeps 30 days of them).
const readInstalls = () => q(`patchinstallationresources
  | where type in~ ('microsoft.compute/virtualmachines/patchinstallationresults', 'microsoft.hybridcompute/machines/patchinstallationresults')
  | where tostring(properties.status) in~ ('Succeeded', 'Failed', 'CompletedWithWarnings')
  | extend machineId = tostring(split(tolower(id), '/patchinstallationresults/')[0]), started = todatetime(properties.startDateTime)
  | summarize arg_max(started, *) by machineId
  | project machineId, started = tostring(started), status = tostring(properties.status), failed = toint(properties.failedPatchCount),
      installed = toint(properties.installedPatchCount), pending = toint(properties.pendingPatchCount), error = tostring(properties.errorDetails.message)`);

// Maintenance configuration assignments: on one machine (resourceId) or dynamic scopes on a subscription (filter).
const readAssignments = () => q(`maintenanceresources
  | where type =~ 'microsoft.maintenance/configurationassignments'
  | project id = tolower(id), subscriptionId, resourceId = tolower(tostring(properties.resourceId)),
      configId = tostring(properties.maintenanceConfigurationId), filter = properties.filter`);

/* ---------- judging (pure, for the tests) ---------- */

const isArc = (m) => m.type === "microsoft.hybridcompute/machines";
const running = (m) => (isArc(m) ? low(m.arcStatus) === "connected" : low(m.power) === "powerstate/running");
const base = (m, suffix) => ({ id: `${m.id}#${suffix}`, name: m.name, resourceGroup: m.resourceGroup, subscriptionId: m.subscriptionId });
const what = (m) => (isArc(m) ? "Arc server" : "VM");

// counts: availablePatchCountByClassification; oldest: { critical, security } ISO dates or empty.
function pendingFinding(m, counts, oldest, { maxPendingDays, now = Date.now() }) {
  const c = counts || {};
  const crit = Number(c.critical) || 0;
  const sec = Number(c.security) || 0;
  if (!crit && !sec) return null;
  const list = CLASSES.filter((k) => Number(c[k]) > 0).map((k) => `${c[k]} ${CLASS_NAMES[k]}`).join(", ");
  const dates = [crit && oldest.critical, sec && oldest.security].filter((d) => d && !Number.isNaN(Date.parse(d)));
  const first = dates.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const age = first ? Math.floor((now - Date.parse(first)) / DAY) : null;
  const kind = age !== null && age > maxPendingDays ? "updates-pending-overdue" : crit ? "updates-pending-critical" : "updates-pending-security";
  const since = age === null ? " (release dates unknown)" : `; the oldest came out on ${day(first)}, ${age} days ago`;
  return { ...base(m, "updates-pending"), kind, critical: crit, security: sec, oldestDays: age, detail: `Pending updates: ${list}${since}. Install them with Update Manager (One-time update) or a maintenance schedule` };
}

// A dynamic scope's filter matches a VM? Empty lists match everything; tags match on Any or All of the listed values.
function filterMatches(f, m) {
  if (!f) return false;
  const inList = (list, v) => !list || !list.length || list.map(low).includes(low(v));
  if (!inList(f.resourceTypes, m.type) || !inList(f.resourceGroups, m.resourceGroup) || !inList(f.locations, m.location) || !inList(f.osTypes, m.os)) return false;
  const want = (f.tagSettings && f.tagSettings.tags) || {};
  const keys = Object.keys(want);
  if (!keys.length) return true;
  const tags = Object.fromEntries(Object.entries(m.tags || {}).map(([k, v]) => [low(k), low(v)]));
  const hit = (k) => {
    const v = tags[low(k)];
    const vals = want[k] || [];
    return v !== undefined && (!vals.length || vals.map(low).includes(v));
  };
  return low(f.tagSettings.filterOperator) === "any" ? keys.some(hit) : keys.every(hit);
}

// A VM is on a schedule when Azure assesses it periodically, patches it itself (automatic guest patching), or a
// maintenance configuration is assigned to it directly or through a dynamic scope on its subscription.
function onSchedule(m, assigned, dynamic) {
  if (low(m.assessmentMode) === "automaticbyplatform" || low(m.patchMode) === "automaticbyplatform") return true;
  if (assigned.has(m.id)) return true;
  return dynamic.some((d) => low(d.subscriptionId) === subOf(m.id) && filterMatches(d.filter, m));
}

// data: { machines, assessments, oldest, installs, assignments } as read above. Parts left null are not judged.
function judge(data, { maxPendingDays, maxAgeDays, now = Date.now() }) {
  const machines = (data.machines || []).filter(running);
  const out = [];
  const assessBy = data.assessments ? new Map(data.assessments.map((a) => [low(a.machineId), a])) : null;
  if (assessBy) {
    const oldestBy = new Map();
    for (const o of data.oldest || []) {
      const k = low(o.machineId);
      if (!oldestBy.has(k)) oldestBy.set(k, {});
      oldestBy.get(k)[o.cls] = o.oldest;
    }
    for (const m of machines) {
      const a = assessBy.get(m.id);
      if (!a) {
        out.push({ ...base(m, "updates-assessment"), kind: "updates-not-assessed", detail: `Running ${what(m)} with no update assessment in the last ${KEEP_DAYS} days (or ever), so pending updates are unknown. Turn on periodic assessment or run Check for updates in Update Manager` });
        continue;
      }
      const age = a.at ? Math.floor((now - Date.parse(a.at)) / DAY) : null;
      if (low(a.status) === "failed") {
        out.push({ ...base(m, "updates-assessment"), kind: "updates-not-assessed", detail: `The latest update assessment (${day(a.at) || "date unknown"}) failed${a.error ? `: ${a.error.slice(0, 200)}` : ""}. Check the machine can reach its update source, then run Check for updates` });
        continue;
      }
      if (age !== null && age > maxAgeDays) {
        out.push({ ...base(m, "updates-assessment"), kind: "updates-not-assessed", detail: `Last update assessment was on ${day(a.at)}, ${age} days ago. Turn on periodic assessment so the pending list stays current` });
      }
      const f = pendingFinding(m, a.counts, oldestBy.get(m.id) || {}, { maxPendingDays, now });
      if (f) out.push(f);
    }
  }
  if (data.assignments) {
    const assigned = new Set(data.assignments.filter((a) => a.resourceId).map((a) => low(a.resourceId)));
    const dynamic = data.assignments.filter((a) => !a.resourceId && a.filter);
    for (const m of machines) {
      if (isArc(m) || onSchedule(m, assigned, dynamic)) continue;
      out.push({ ...base(m, "updates-schedule"), kind: "updates-no-schedule", detail: "Running VM with no periodic assessment, no automatic guest patching and no maintenance configuration, so Azure neither checks nor installs its updates. Turn on periodic assessment and attach a maintenance configuration (schedule) in Update Manager" });
    }
  }
  if (data.installs) {
    const byId = new Map(machines.map((m) => [m.id, m]));
    for (const r of data.installs) {
      const m = byId.get(low(r.machineId));
      if (!m || !/^(failed|completedwithwarnings)$/i.test(r.status)) continue;
      const counts = `${r.installed || 0} installed, ${r.failed || 0} failed, ${r.pending || 0} still pending`;
      out.push({ ...base(m, "updates-install"), kind: "updates-install-failed", detail: `Latest update installation (${day(r.started)}) ended ${low(r.status) === "failed" ? "Failed" : "with warnings"}: ${counts}${r.error ? `. ${r.error.slice(0, 200)}` : ""}. See the run in Update Manager, History` });
    }
  }
  return out;
}

/* ---------- run ---------- */

async function run() {
  const opts = {
    maxPendingDays: numberSetting("UPDATES_MAX_PENDING_DAYS", 30, { min: 1, max: 3650 }),
    maxAgeDays: numberSetting("UPDATES_ASSESSMENT_MAX_AGE_DAYS", 7, { min: 1, max: 365 }),
  };
  // The machine list is read once and shared; each check reads its own records, so one failing read hides only its check.
  const machines = readMachines();
  machines.catch(() => {});
  return runChecks(TOOL_ID, {
    "Pending updates and assessments": async () => {
      // Without release dates nothing is overdue, but pending updates still show.
      let dateError = null;
      const [m, assessments, oldest] = await Promise.all([machines, readAssessments(), readOldest().catch((e) => ((dateError = e), []))]);
      const found = judge({ machines: m, assessments, oldest }, opts);
      if (dateError) found.push(scanError(TOOL_ID, "release-dates", "Update release dates not read", `Pending updates show without their age: ${String(dateError.message || dateError).slice(0, 250)}`));
      return found;
    },
    "Patch schedules": async () => judge({ machines: await machines, assignments: await readAssignments() }, opts),
    Installations: async () => judge({ machines: await machines, installs: await readInstalls() }, opts),
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Updates and patching",
  schedule: "25 6 * * *", // daily at 06:25
  run,
  _test: { judge, pendingFinding, filterMatches, onSchedule },
};
