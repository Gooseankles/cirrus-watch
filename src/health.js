// What GET /health answers (App Service's health check and any uptime check).
// It says only "ok" or "stale", never tenants, findings or the version. Stale
// = no scheduled scan has finished well (at least one tenant saved) for
// HEALTH_SCAN_MAX_AGE_HOURS (default 26: a day of nightly scans plus slack).
// Right after a start it is always ok until that many hours have passed, so a
// restart is not reported as a problem. Kept in memory: a restart starts over.
const startedAt = Date.now();
let lastScheduledOk = null;

function maxAgeMs() {
  return (Number(process.env.HEALTH_SCAN_MAX_AGE_HOURS) || 26) * 3600000;
}

function scheduledScanOk(at = Date.now()) {
  lastScheduledOk = at;
}

function status(now = Date.now(), since = startedAt) {
  const limit = maxAgeMs();
  if (now - since < limit) return "ok";
  if (lastScheduledOk !== null && now - lastScheduledOk < limit) return "ok";
  return "stale";
}

module.exports = { status, scheduledScanOk, _test: { reset: () => (lastScheduledOk = null) } };
