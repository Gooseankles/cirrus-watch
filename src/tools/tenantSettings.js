// Entra tenant settings that let any user widen the attack surface: register
// apps, create tenants or security groups, invite guests, or join by email
// sign-up; guests that see as much of the directory as members; and B2B direct
// connect open to every outside tenant. User consent is checked by App
// permissions and security defaults by Conditional Access, so not here.
// Graph: Policy.Read.All (authorization policy and cross-tenant access policy).
const { graphGet } = require("../graphClient");
const { runChecks, graphHint } = require("./util");

const TOOL_ID = "tenant-settings";
const TENANT = { resourceGroup: null, subscriptionId: null };
// guestUserRoleId values: same as members, limited (the default), most restricted.
const GUEST_SAME_AS_MEMBERS = "a0b1b346-4d3e-4e8b-98f8-753987be4970";

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
    "Cross-tenant access": async () => judgeCrossTenant(await read("/policies/crossTenantAccessPolicy/default")),
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Entra tenant settings",
  schedule: "25 5 * * *", // daily at 05:25
  run,
  _test: { judgeAuthorization, judgeCrossTenant },
};
