// What GET /api/me answers for a signed-in person: name, roles, tenants, areas
// and the app version. The route needs a session (401 without one); the login
// page asks /auth/methods instead. The null fallbacks are a second guard.
const auth = require("./auth");
const access = require("./access");
const settings = require("./settings");
const tenants = require("./tenants");

function meReply(user, version) {
  const acc = access.accessOf(user);
  const seen = user ? access.visibleTenants(user) : [];
  return {
    ssoConfigured: auth.ssoConfigured(),
    localAdminConfigured: auth.localAdminConfigured(),
    signedIn: Boolean(user),
    name: user ? user.name : null,
    roles: user ? user.roles : [],
    isAdmin: Boolean(user && acc.admin),
    canRun: Boolean(user && acc.canRun),
    // Tenants this person may see; the page shows a tab per tenant when there is more than one.
    tenants: seen.map((t) => ({ ...t, scansOff: settings.scansOff(t.key) })),
    // Areas (access.js) the person may read in at least one tenant.
    areas: access.AREAS.filter((a) => seen.some((t) => t.areas.includes(a))),
    areaLabels: access.AREA_LABELS,
    multiTenant: Boolean(user) && tenants.isMultiTenant(),
    version: user ? version : null,
  };
}

module.exports = { meReply };
