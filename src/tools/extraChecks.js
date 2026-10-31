// Opt-in checks that need Microsoft Graph application permissions the app is
// not granted by default. A tenant turns them on in Settings ("Extra Graph
// checks", EXTRA_GRAPH_CHECKS: a comma-separated list of the tool ids below, or
// "all"). A customer tenant uses only its own list, never the home tenant's, so
// a customer who has not granted the extra permission is never scanned with it.
// The Terraform module's extra_graph_checks variable grants the permissions in
// the home tenant and sets the list there; the customer_onboarding output names
// them for each customer.
//
// When a check is off, its run() returns at once and calls nothing. When it is
// on but Graph refuses (403), the run reports one scan-error finding that names
// the permission (and logs it once) instead of failing.
const settings = require("../settings");
const log = require("../log");
const { scanError, graphHint } = require("./util");

// Tool id -> the application permissions it needs on top of the default set.
// Keep in step with the module's local.extra_graph_permissions (entra.tf).
const EXTRA_CHECKS = {
  "risky-users": ["IdentityRiskyUser.Read.All"],
  "secure-score": ["SecurityEvents.Read.All"],
  "admin-units": ["AdministrativeUnit.Read.All"],
  "directory-sync": ["Organization.Read.All"],
};

// The ids listed for the tenant being scanned (settings.get knows which).
function enabledChecks() {
  const raw = String(settings.get("EXTRA_GRAPH_CHECKS") || "").toLowerCase();
  const ids = raw.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
  if (ids.includes("all")) return Object.keys(EXTRA_CHECKS);
  return ids.filter((id) => EXTRA_CHECKS[id]);
}
const isOn = (toolId) => enabledChecks().includes(toolId);

const noPremium = (err) => /RequestFromNonPremiumTenant|NonPremium|premium license|AadPremiumLicenseRequired|not (?:properly )?licensed|license is required|licen[cs]e.*P2/i.test(String(err && err.message));
const refused = (err) => /\(403\)|Authorization_RequestDenied|Forbidden/i.test(String(err && err.message));

// The finding (and one log line) for a check whose permission is missing.
function permissionMissing(toolId, label, err) {
  const permission = EXTRA_CHECKS[toolId].join(" and ");
  const hint = graphHint(err, permission);
  log.record({ tool: toolId, level: "warn", message: `${label} not checked: ${hint}` });
  return [scanError(toolId, "permission", `${label} not checked: Graph permission ${permission} missing`, `${hint}. Grant it (Terraform: add "${toolId}" to extra_graph_checks; a customer tenant: add it to the app registration there and grant admin consent), or take ${toolId} out of Extra Graph checks in Settings`)];
}

module.exports = { EXTRA_CHECKS, enabledChecks, isOn, noPremium, refused, permissionMissing };
