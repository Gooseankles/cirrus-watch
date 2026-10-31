// Administrative units (AUs): only what shows risk, not an inventory.
//   - a guest holds an admin role scoped to an AU (an outsider who can reset
//     passwords or change the users and groups in it)
//   - a disabled account still holds an AU-scoped admin role (left behind; it
//     works again the moment someone enables the account)
//   - a restricted management AU has no members (it was made to shield
//     sensitive accounts from tenant-wide admins, and shields nothing)
// Plain AUs with no scoped admins, dynamic rules and AU sizes are not findings:
// they carry no risk on their own and would be noise. Scoped admins that are
// groups or apps are left to Privileged roles.
// Opt-in (extraChecks.js): Graph AdministrativeUnit.Read.All for the AU list
// and members. scopedRoleMembers and directoryRoles use RoleManagement.Read.
// Directory, user details User.Read.All (both in the default set). Listing AUs
// works on Entra ID Free; each AU-scoped admin needs Entra ID P1.
const { graphGet, graphGetAll, graphPost } = require("../graphClient");
const { mapLimit, itemErrors } = require("./util");
const { isOn, refused, permissionMissing } = require("./extraChecks");

const TOOL_ID = "admin-units";
const LABEL = "Administrative units";
const CONCURRENCY = 4;

// input: { aus, scoped: Map(auId -> scopedRoleMembership[]), memberCount:
// Map(auId -> number, restricted AUs only), roleNames: Map(roleId -> name),
// users: Map(userId -> { userType, accountEnabled, userPrincipalName }) }. Pure.
function auFindings({ aus, scoped, memberCount, roleNames, users }) {
  const out = [];
  for (const au of aus || []) {
    const auName = au.displayName || au.id;
    if (au.isMemberManagementRestricted && memberCount.has(au.id) && memberCount.get(au.id) === 0) {
      out.push({
        kind: "au-restricted-empty",
        id: `${TOOL_ID}/${au.id}/empty`,
        name: auName,
        detail: "Restricted management administrative unit with no members: it protects nothing. Add the accounts it is meant to shield, or delete it",
        resourceGroup: null,
        subscriptionId: null,
      });
    }
    for (const m of scoped.get(au.id) || []) {
      const info = m.roleMemberInfo || {};
      const u = users.get(info.id);
      if (!u) continue; // a group or an app, or gone
      const role = roleNames.get(m.roleId) || "an admin role";
      const who = u.userPrincipalName || info.userPrincipalName || info.displayName || info.id;
      const base = { resourceGroup: null, subscriptionId: null, principalId: info.id };
      if (u.userType === "Guest" || /#EXT#/i.test(u.userPrincipalName || "")) {
        out.push({ ...base, kind: "au-scoped-admin-guest", id: `${TOOL_ID}/${au.id}/${info.id}/${m.roleId}/guest`, name: who, detail: `Guest account holds ${role} over the administrative unit ${auName}: someone outside the organisation can manage the users and groups in it. Remove the assignment or give it to a member account` });
      } else if (u.accountEnabled === false) {
        out.push({ ...base, kind: "au-scoped-admin-disabled", id: `${TOOL_ID}/${au.id}/${info.id}/${m.roleId}/disabled`, name: who, detail: `Disabled account still holds ${role} over the administrative unit ${auName}. Remove the assignment; it works again as soon as the account is enabled` });
      }
    }
  }
  return out;
}

async function lookupUsers(ids) {
  const users = new Map();
  const unique = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 1000) {
    const page = await graphPost("/directoryObjects/getByIds?$select=id,userPrincipalName,userType,accountEnabled", { ids: unique.slice(i, i + 1000), types: ["user"] }, TOOL_ID);
    for (const o of page.value || []) users.set(o.id, o);
  }
  return users;
}

async function run() {
  if (!isOn(TOOL_ID)) return [];
  let aus;
  try {
    aus = await graphGetAll("/directory/administrativeUnits?$select=id,displayName,isMemberManagementRestricted", TOOL_ID);
  } catch (err) {
    if (refused(err)) return permissionMissing(TOOL_ID, LABEL, err);
    throw err;
  }
  if (!aus.length) return [];
  const scoped = new Map();
  const memberCount = new Map();
  const failures = await mapLimit(aus, CONCURRENCY, async (au) => {
    scoped.set(au.id, await graphGetAll(`/directory/administrativeUnits/${au.id}/scopedRoleMembers`, TOOL_ID));
    if (au.isMemberManagementRestricted) {
      const page = await graphGet(`/directory/administrativeUnits/${au.id}/members/$ref?$top=1`, TOOL_ID);
      memberCount.set(au.id, (page.value || []).length);
    }
  });
  const ids = [...scoped.values()].flat().map((m) => m.roleMemberInfo && m.roleMemberInfo.id);
  const roleNames = new Map();
  let users = new Map();
  if (ids.length) {
    const roles = await graphGetAll("/directoryRoles?$select=id,displayName", TOOL_ID);
    for (const r of roles) roleNames.set(r.id, r.displayName);
    users = await lookupUsers(ids);
  }
  return [...auFindings({ aus, scoped, memberCount, roleNames, users }), ...itemErrors(TOOL_ID, "units", "administrative units", failures, aus.length)];
}

module.exports = {
  id: TOOL_ID,
  label: LABEL,
  schedule: "5 6 * * *", // daily at 06:05
  run,
  _test: { auFindings },
};
