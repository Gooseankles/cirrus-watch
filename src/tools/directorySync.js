// Directory sync health: when the tenant syncs from on-premises Active Directory
// (Microsoft Entra Connect Sync or Cloud Sync), the last sync must be recent.
// Entra Connect syncs every 30 minutes; a stale sync means leavers disabled
// on-premises can still sign in to the cloud and new people or password
// changes do not arrive. One tenant finding when the last sync is older than
// DIRECTORY_SYNC_MAX_HOURS (default 3: six missed cycles, which rides out a
// server restart or an upgrade but not a stopped service); critical after a day.
// Cloud-only tenants (onPremisesSyncEnabled null or false) report nothing.
// Opt-in (extraChecks.js): Graph Organization.Read.All for GET /organization
// (with less, Graph answers but returns everything except id, displayName and
// verifiedDomains as null, so a null createdDateTime counts as refused). Runs
// hourly: one small request. /directory/onPremisesSynchronization is not used: it has no
// application permission.
const { graphGet } = require("../graphClient");
const { numberSetting } = require("./util");
const { isOn, refused, permissionMissing } = require("./extraChecks");

const TOOL_ID = "directory-sync";
const LABEL = "Directory sync";
const DEFAULT_HOURS = 3;
const CRITICAL_HOURS = 24;

// organization -> findings. Pure.
function syncFindings(org, maxHours = DEFAULT_HOURS, now = Date.now()) {
  if (!org || org.onPremisesSyncEnabled !== true) return [];
  const name = org.displayName || "Tenant";
  const base = { id: `${TOOL_ID}/${org.id || "tenant"}`, name, resourceGroup: null, subscriptionId: null };
  if (!org.onPremisesLastSyncDateTime) {
    return [{ ...base, kind: "directory-sync-stale", detail: "Directory sync is turned on but no sync has ever finished. Check the Microsoft Entra Connect (or Cloud Sync) server and its service" }];
  }
  const hours = (now - Date.parse(org.onPremisesLastSyncDateTime)) / 3600000;
  if (!(hours > maxHours)) return [];
  const crit = hours > CRITICAL_HOURS;
  const age = hours >= 48 ? `${Math.floor(hours / 24)} days` : `${Math.floor(hours)} hours`;
  return [{
    ...base,
    kind: crit ? "directory-sync-stopped" : "directory-sync-stale",
    detail: `Last sync from on-premises Active Directory was ${age} ago (${org.onPremisesLastSyncDateTime}); Entra Connect normally syncs every 30 minutes (threshold ${maxHours} hours). Accounts disabled on-premises still work in the cloud until it runs. Check the sync server, its service and Entra Connect Health`,
  }];
}

async function run() {
  if (!isOn(TOOL_ID)) return [];
  let orgs;
  try {
    orgs = (await graphGet("/organization?$select=id,displayName,createdDateTime,onPremisesSyncEnabled,onPremisesLastSyncDateTime", TOOL_ID)).value || [];
    if (orgs.length && orgs.every((o) => !o.createdDateTime)) throw Object.assign(new Error("Graph GET /organization returned only the basic properties (403): Organization.Read.All not granted"), { status: 403 });
  } catch (err) {
    if (refused(err)) return permissionMissing(TOOL_ID, LABEL, err);
    throw err;
  }
  const maxHours = numberSetting("DIRECTORY_SYNC_MAX_HOURS", DEFAULT_HOURS, { min: 1, max: 720 });
  return orgs.flatMap((o) => syncFindings(o, maxHours));
}

module.exports = {
  id: TOOL_ID,
  label: LABEL,
  schedule: "40 * * * *", // hourly at :40
  run,
  _test: { syncFindings },
};
