// Entra tenant settings that let any user widen the attack surface: register
// apps, create tenants or security groups, invite guests, or join by email
// sign-up; guests that see as much of the directory as members; and B2B direct
// connect open to every outside tenant; B2B collaboration open to every outside
// tenant, partner tenants whose MFA or device claims are trusted or whose
// consent prompts are skipped; and the authentication methods policy (SMS or
// voice for everyone, a reusable or long Temporary Access Pass, passkeys off,
// migration from the old MFA and SSPR method lists not finished, no
// registration campaign). User consent is checked by App permissions and
// security defaults by Conditional Access, so not here.
// Graph: Policy.Read.All (authorization, cross-tenant access and
// authentication methods policies).
const { graphGet, graphGetAll } = require("../graphClient");
const { runChecks, graphHint } = require("./util");

const TOOL_ID = "tenant-settings";
const TENANT = { resourceGroup: null, subscriptionId: null };
// guestUserRoleId values: same as members, limited (the default), most restricted.
const GUEST_SAME_AS_MEMBERS = "a0b1b346-4d3e-4e8b-98f8-753987be4970";
const TAP_LONG_MINUTES = 1440; // a Temporary Access Pass that may stay valid for more than a day
const MAX_NAMED = 5; // partner tenants named in one finding

const finding = (setting, kind, name, detail) => ({ ...TENANT, kind, id: `${TOOL_ID}/${setting}`, name, detail });

// p: the authorization policy object. Pure, for the tests.
function judgeAuthorization(p) {
  const d = p.defaultUserRolePermissions || {};
  const out = [];
  if (d.allowedToCreateApps === true) {
    out.push(finding("create-apps", "tenant-users-create-apps", "Users can register apps", "Any user can register an application and give it secrets. Set \"Users can register applications\" to No and let Application Developers do it"));
  }
  if (d.allowedToCreateTenants === true) {
    out.push(finding("create-tenants", "tenant-users-create-tenants", "Users can create tenants", "Any user can create a new Entra tenant, which then sits outside your policies. Set \"Restrict non-admin users from creating tenants\" to Yes"));
  }
  if (d.allowedToCreateSecurityGroups === true) {
    out.push(finding("create-groups", "tenant-users-create-groups", "Users can create security groups", "Any user can create security groups. Allow it only for admins or a named group if groups are used to give access"));
  }
  if (p.allowInvitesFrom === "everyone") {
    out.push(finding("guest-invite", "tenant-guest-invite-open", "Anyone can invite guests", "Every user, guests included, can invite outside people into the tenant. Limit guest invitations to admins and users in the Guest Inviter role"));
  } else if (p.allowInvitesFrom === "adminsGuestInvitersAndAllMembers") {
    out.push(finding("guest-invite", "tenant-guest-invite-members", "All members can invite guests", "Every member user can invite outside people into the tenant. Consider limiting it to admins and users in the Guest Inviter role"));
  }
  if (String(p.guestUserRoleId || "").toLowerCase() === GUEST_SAME_AS_MEMBERS) {
    out.push(finding("guest-access", "tenant-guest-access-member", "Guests have member access", "Guest users can read the directory like members (all users, groups and their members). Set guest access to limited or most restricted"));
  }
  if (p.allowEmailVerifiedUsersToJoinOrganization === true) {
    out.push(finding("email-signup", "tenant-email-signup", "Email sign-up can join", "People with an email address on your domains can join the tenant by self-service sign-up, without an invitation. Turn it off"));
  }
  return out;
}

// c: the cross-tenant access default configuration. B2B direct connect inbound is blocked by default; report it only
// when users of every outside tenant are let in. Pure, for the tests.
function judgeCrossTenant(c) {
  const ug = ((c.b2bDirectConnectInbound || {}).usersAndGroups) || {};
  const all = (ug.targets || []).some((t) => /^AllUsers$/i.test(t.target));
  if (ug.accessType !== "allowed" || !all) return [];
  return [finding("direct-connect-inbound", "tenant-direct-connect-open", "B2B direct connect open to all", "Users from every outside tenant can reach your Teams shared channels without being added as guests. Block it in the default setting and allow it only for named partner organisations")];
}

// c: the cross-tenant access default configuration. B2B collaboration inbound open to users of every outside tenant
// for every app is Microsoft's out-of-the-box setting, so this is low. Pure, for the tests.
function judgeCollaborationDefault(c) {
  const inbound = c.b2bCollaborationInbound || {};
  const ug = inbound.usersAndGroups || {};
  const apps = inbound.applications || {};
  const allUsers = (ug.targets || []).some((t) => /^AllUsers$/i.test(t.target));
  const allApps = (apps.targets || []).some((t) => /^AllApplications$/i.test(t.target));
  if (ug.accessType !== "allowed" || !allUsers || apps.accessType !== "allowed" || !allApps) return [];
  return [finding("b2b-inbound", "tenant-b2b-inbound-open", "Guests from any tenant allowed", "The default cross-tenant setting lets users from every outside Entra tenant be invited as guests to every app. This is Microsoft's default; if you only work with known partners, block it in the default setting and allow named organisations")];
}

const partnerName = (p) => p.displayName || p.tenantId;
const listNames = (names) => names.slice(0, MAX_NAMED).join(", ") + (names.length > MAX_NAMED ? ` and ${names.length - MAX_NAMED} more` : "");

// partners: the cross-tenant partner configurations. A null property inherits the default, which trusts no claims
// and never skips consent. One finding per kind, naming the partners. Pure, for the tests.
function judgePartners(partners) {
  const out = [];
  const trusting = [];
  const consent = [];
  for (const p of partners || []) {
    const t = p.inboundTrust || {};
    const what = [t.isMfaAccepted && "MFA", t.isCompliantDeviceAccepted && "compliant devices", t.isHybridAzureADJoinedDeviceAccepted && "hybrid joined devices"].filter(Boolean);
    if (what.length) trusting.push(`${partnerName(p)} (${what.join(", ")})`);
    const c = p.automaticUserConsentSettings || {};
    const dir = [c.inboundAllowed === true && "inbound", c.outboundAllowed === true && "outbound"].filter(Boolean);
    if (dir.length) consent.push(`${partnerName(p)} (${dir.join(", ")})`);
  }
  if (trusting.length) {
    out.push(finding("partner-trust", "tenant-partner-mfa-trust", `${trusting.length} partner tenant(s) trusted for MFA or devices`, `Your Conditional Access accepts MFA or device claims made in these partner tenants: ${listNames(trusting)}. A weak MFA or device policy there then counts here. Keep it only for partners you know well`));
  }
  if (consent.length) {
    out.push(finding("partner-consent", "tenant-partner-auto-consent", `${consent.length} partner tenant(s) skip consent prompts`, `Users are not asked to accept when they move between your tenant and these partners: ${listNames(consent)}. This is meant for tenants of the same organisation (cross-tenant sync); remove it for other partners`));
  }
  return out;
}

const forAllUsers = (m) => (m.includeTargets || []).some((t) => t.id === "all_users");

// p: the authentication methods policy (Graph expands authenticationMethodConfigurations). Pure, for the tests.
function judgeAuthMethods(p) {
  const out = [];
  const byId = new Map((p.authenticationMethodConfigurations || []).map((m) => [String(m.id).toLowerCase(), m]));
  const on = (id) => (byId.get(id) || {}).state === "enabled";
  const weak = ["sms", "voice"].filter((id) => on(id) && forAllUsers(byId.get(id)));
  if (weak.length) {
    const names = weak.map((id) => (id === "sms" ? "SMS" : "voice call")).join(" and ");
    out.push(finding("auth-sms-voice", "authm-sms-voice-all", `${names} allowed for all users`, `Every user may sign in or do MFA with ${names}, which can be intercepted or moved to another SIM card. Limit it to a group that cannot use the Authenticator app or passkeys`));
  }
  // A reusable pass (isUsableOnce false) is Microsoft's default and is not flagged; only a maximum lifetime raised
  // well past the default of 8 hours is.
  const tap = byId.get("temporaryaccesspass");
  if (tap && tap.state === "enabled") {
    const max = Number(tap.maximumLifetimeInMinutes);
    if (Number.isFinite(max) && max > TAP_LONG_MINUTES) {
      out.push(finding("auth-tap-long", "authm-tap-long", "Temporary Access Pass can last long", `A Temporary Access Pass may be valid for up to ${Math.round(max / 60)} hours. A pass works like a password; keep the maximum at a working day (8 hours) or less`));
    }
  }
  if (byId.has("fido2") && !on("fido2")) {
    out.push(finding("auth-fido2", "authm-fido2-off", "Passkeys (FIDO2) turned off", "Users cannot register passkeys or security keys, the phishing-resistant method Microsoft recommends, above all for admins. Turn on Passkey (FIDO2) at least for a group of admins"));
  }
  if (p.policyMigrationState && p.policyMigrationState !== "migrationComplete") {
    out.push(finding("auth-migration", "authm-migration-incomplete", "Old MFA and SSPR method lists still apply", `The authentication methods policy is in state "${p.policyMigrationState}", so the old MFA and self-service password reset method lists still apply as well. Microsoft is retiring them; finish the migration and set it to complete`));
  }
  // Campaign states are enabled, disabled and default; "default" is Microsoft managed, where the campaign runs with
  // Microsoft's settings, so only "disabled" is a finding.
  const campaign = ((p.registrationEnforcement || {}).authenticationMethodsRegistrationCampaign) || {};
  if (campaign.state === "disabled") {
    out.push(finding("auth-campaign", "authm-campaign-off", "MFA registration campaign turned off", "Users who rely on SMS or voice are not asked to set up the Authenticator app at sign-in. Set the registration campaign to Enabled or Microsoft managed (Authentication methods, Registration campaign)"));
  }
  return out;
}

async function readAll(path) {
  try {
    return await graphGetAll(path, TOOL_ID);
  } catch (err) {
    throw new Error(graphHint(err, "Policy.Read.All"));
  }
}

async function read(path) {
  try {
    return await graphGet(path, TOOL_ID);
  } catch (err) {
    throw new Error(graphHint(err, "Policy.Read.All"));
  }
}

async function run() {
  return runChecks(TOOL_ID, {
    "Authorization policy": async () => {
      const pol = await read("/policies/authorizationPolicy");
      return judgeAuthorization(Array.isArray(pol.value) ? pol.value[0] || {} : pol);
    },
    "Cross-tenant access": async () => {
      const def = await read("/policies/crossTenantAccessPolicy/default");
      return [...judgeCrossTenant(def), ...judgeCollaborationDefault(def)];
    },
    "Cross-tenant partners": async () => judgePartners(await readAll("/policies/crossTenantAccessPolicy/partners")),
    "Authentication methods": async () => judgeAuthMethods(await read("/policies/authenticationMethodsPolicy")),
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Entra tenant settings",
  schedule: "25 5 * * *", // daily at 05:25
  run,
  _test: { judgeAuthorization, judgeCrossTenant, judgeCollaborationDefault, judgePartners, judgeAuthMethods },
};
