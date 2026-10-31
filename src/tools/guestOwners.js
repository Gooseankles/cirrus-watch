// Groups owned by guests. An owner can add anyone to the group and change it,
// so a guest owner lets someone outside the organisation decide who gets what
// the group grants (Teams, SharePoint, app access, Azure roles). Critical for
// role-assignable groups (they can hold Entra admin roles), else a warning.
// Graph: one pass over /groups with $expand=owners. GroupMember.Read.All (list
// groups and owners) and User.Read.All (owner userType) are in the default set,
// so this check needs no new permission and runs by default. $expand returns at
// most 20 owners and no next link; a group showing 20 is read again in full.
// Owners of groups synced from on-premises, distribution groups and
// mail-enabled security groups made in Exchange are not in Graph, so those are
// not seen.
// The access review part of the plan (privileged groups and roles with no
// review, AccessReview.Read.All) is not built: review scopes are free-form
// queries in several shapes (one group, all Microsoft 365 groups with guests,
// role assignment instances, PIM groups), so "no review covers this" cannot be
// told reliably without many false findings.
const { graphGetAll, graphPost } = require("../graphClient");
const { mapLimit, itemErrors, graphHint } = require("./util");

const TOOL_ID = "guest-owners";
const OWNER_FIELDS = "id,displayName,userPrincipalName,userType,accountEnabled";
const EXPAND_LIMIT = 20;

// userType only: a guest converted to Member keeps #EXT# in the UPN but is no longer a guest.
const isGuest = (o) => o && o.userType === "Guest";
const isUser = (o) => !o["@odata.type"] || o["@odata.type"] === "#microsoft.graph.user";

// groups: [{ id, displayName, isAssignableToRole, owners: [...] }] -> findings. Pure.
function guestOwnerFindings(groups) {
  const out = [];
  for (const g of groups || []) {
    const owners = (g.owners || []).filter(isUser);
    const guests = owners.filter(isGuest);
    if (!guests.length) continue;
    const onlyGuests = guests.length === owners.length;
    for (const o of guests) {
      out.push({
        kind: g.isAssignableToRole ? "guest-owner-role-group" : "guest-owner",
        id: `${TOOL_ID}/${g.id}/${o.id}`,
        name: `${g.displayName || g.id}: ${o.userPrincipalName || o.displayName || o.id}`,
        detail: `Guest ${o.displayName || o.userPrincipalName || o.id} owns the group ${g.displayName || g.id}${g.isAssignableToRole ? " (role-assignable: it can hold Entra admin roles)" : ""}${onlyGuests ? "; there is no member owner" : ""}. An owner can add anyone to the group; make a member of the organisation the owner and remove the guest`,
        resourceGroup: null,
        subscriptionId: null,
        principalId: o.id,
      });
    }
  }
  return out;
}

// Every owner of a group with 20 or more in the expand: ids, then user details.
async function allOwners(groupId) {
  const owners = await graphGetAll(`/groups/${groupId}/owners`, TOOL_ID);
  const ids = owners.filter(isUser).map((o) => o.id);
  const users = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const page = await graphPost(`/directoryObjects/getByIds?$select=${OWNER_FIELDS}`, { ids: ids.slice(i, i + 1000), types: ["user"] }, TOOL_ID);
    users.push(...(page.value || []));
  }
  return users;
}

async function run() {
  let groups;
  try {
    groups = await graphGetAll(`/groups?$select=id,displayName,isAssignableToRole&$expand=owners($select=${OWNER_FIELDS})`, TOOL_ID);
  } catch (err) {
    throw new Error(graphHint(err, "GroupMember.Read.All"));
  }
  const full = groups.filter((g) => (g.owners || []).length >= EXPAND_LIMIT);
  const failures = await mapLimit(full, 4, async (g) => {
    g.owners = await allOwners(g.id);
  });
  return [...guestOwnerFindings(groups), ...itemErrors(TOOL_ID, "owners", "large groups' owner lists", failures, full.length)];
}

module.exports = {
  id: TOOL_ID,
  label: "Guest owners",
  schedule: "40 5 * * *", // daily at 05:40
  run,
  _test: { guestOwnerFindings, isGuest },
};
