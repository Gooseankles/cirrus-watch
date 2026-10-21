// Apps holding Microsoft Graph permissions that could take over the tenant or
// read everyone's data, risky delegated consents, and whether users may
// consent to any app themselves. Microsoft's own apps are left out.
// Graph: Application.Read.All (app permissions), DelegatedPermissionGrant.Read.All
// (consents), Policy.Read.All (user consent setting).
const { graphGet, graphGetAll } = require("../graphClient");
const { mapLimit, runChecks, itemErrors, graphHint } = require("./util");

const TOOL_ID = "app-permissions";
const GRAPH_APP_ID = "00000003-0000-0000-c000-000000000000";
const MICROSOFT_TENANTS = new Set(["f8cdef31-a31e-4b4a-93e4-5f571e91255a", "72f988bf-86f1-41af-91ab-2d7cd011db47"]);
const MAX_APPS = 500;
const TENANT = { resourceGroup: null, subscriptionId: null };

// Can make itself (or anyone) an admin, or switch off the defences.
const TAKEOVER = new Set([
  "RoleManagement.ReadWrite.Directory", "AppRoleAssignment.ReadWrite.All", "Application.ReadWrite.All",
  "Directory.ReadWrite.All", "DelegatedPermissionGrant.ReadWrite.All", "Policy.ReadWrite.ConditionalAccess",
  "Policy.ReadWrite.AuthenticationMethod", "UserAuthenticationMethod.ReadWrite.All", "PrivilegedAccess.ReadWrite.AzureAD",
  "PrivilegedAssignmentSchedule.ReadWrite.AzureADGroup", "RoleAssignmentSchedule.ReadWrite.Directory",
  "RoleEligibilitySchedule.ReadWrite.Directory", "Domain.ReadWrite.All", "Directory.AccessAsUser.All",
]);
// Reads or changes everyone's mail, files, chats or accounts.
const BROAD = new Set([
  "Mail.Read", "Mail.ReadWrite", "Mail.Send", "MailboxSettings.ReadWrite", "Files.Read.All", "Files.ReadWrite.All",
  "Sites.Read.All", "Sites.ReadWrite.All", "Sites.FullControl.All", "Sites.Manage.All", "User.ReadWrite.All",
  "Group.ReadWrite.All", "GroupMember.ReadWrite.All", "Calendars.ReadWrite", "Contacts.ReadWrite", "Chat.Read.All",
  "Chat.ReadWrite.All", "ChannelMessage.Read.All", "Notes.ReadWrite.All", "User.Export.All", "Device.ReadWrite.All",
]);
// Delegated scopes act as the signed-in user, so only the strongest count.
const DELEGATED_RISKY = new Set([...TAKEOVER, "Mail.ReadWrite", "Mail.Send", "Files.ReadWrite.All", "Sites.ReadWrite.All", "Sites.FullControl.All", "User.ReadWrite.All", "Group.ReadWrite.All"]);

async function appDetails(ids) {
  const out = new Map();
  const list = [...ids].slice(0, MAX_APPS);
  const failures = await mapLimit(list, 6, async (id) => {
    out.set(id, await graphGet(`/servicePrincipals/${id}?$select=id,appId,displayName,appOwnerOrganizationId,accountEnabled`, TOOL_ID));
  });
  return { apps: out, errors: itemErrors(TOOL_ID, "apps", "apps looked up", failures, list.length) };
}
const microsoft = (sp) => sp && MICROSOFT_TENANTS.has(sp.appOwnerOrganizationId);

async function graphSp() {
  return graphGet(`/servicePrincipals(appId='${GRAPH_APP_ID}')?$select=id,appRoles`, TOOL_ID);
}

async function applicationFindings(sp) {
  const roleName = new Map((sp.appRoles || []).map((r) => [r.id, r.value]));
  const assigned = await graphGetAll(`/servicePrincipals/${sp.id}/appRoleAssignedTo?$top=999`, TOOL_ID);
  const byApp = new Map();
  for (const a of assigned) {
    if (a.principalType !== "ServicePrincipal") continue;
    const perm = roleName.get(a.appRoleId);
    if (!perm || (!TAKEOVER.has(perm) && !BROAD.has(perm))) continue;
    if (!byApp.has(a.principalId)) byApp.set(a.principalId, { name: a.principalDisplayName, perms: new Set() });
    byApp.get(a.principalId).perms.add(perm);
  }
  const { apps, errors } = await appDetails(byApp.keys());
  const findings = [];
  for (const [id, { name, perms }] of byApp) {
    const app = apps.get(id);
    if (microsoft(app)) continue;
    const takeover = [...perms].filter((p) => TAKEOVER.has(p));
    const broad = [...perms].filter((p) => BROAD.has(p));
    const base = { ...TENANT, name: (app && app.displayName) || name || id, principalId: id };
    const off = app && app.accountEnabled === false ? " (the app is disabled)" : "";
    if (takeover.length) findings.push({ ...base, kind: "app-takeover-permission", id: `${id}#takeover`, detail: `Application permission ${takeover.join(", ")}${off}: whoever holds its secret can make themselves an admin or turn off protections` });
    if (broad.length) findings.push({ ...base, kind: "app-broad-data-permission", id: `${id}#broad`, detail: `Application permission ${broad.join(", ")}${off}: reads or changes data for every user, without anyone signed in` });
  }
  return [...findings, ...errors];
}

async function delegatedFindings(sp) {
  let grants;
  try {
    grants = await graphGetAll("/oauth2PermissionGrants?$top=999", TOOL_ID);
  } catch (err) {
    throw new Error(graphHint(err, "DelegatedPermissionGrant.Read.All"));
  }
  const byClient = new Map();
  for (const g of grants) {
    if (g.resourceId !== sp.id) continue;
    const risky = String(g.scope || "").split(/\s+/).filter((s) => DELEGATED_RISKY.has(s));
    if (!risky.length) continue;
    if (!byClient.has(g.clientId)) byClient.set(g.clientId, { all: new Set(), users: new Set(), scopes: new Set() });
    const c = byClient.get(g.clientId);
    risky.forEach((s) => c.scopes.add(s));
    if (g.consentType === "AllPrincipals") risky.forEach((s) => c.all.add(s));
    else c.users.add(g.principalId);
  }
  const { apps, errors } = await appDetails(byClient.keys());
  const findings = [];
  for (const [id, c] of byClient) {
    const app = apps.get(id);
    if (microsoft(app)) continue;
    const who = c.all.size ? "an admin consented for all users" : `${c.users.size} user${c.users.size === 1 ? "" : "s"} consented`;
    findings.push({
      ...TENANT,
      kind: "app-risky-delegated-consent",
      id: `${id}#delegated`,
      name: (app && app.displayName) || id,
      principalId: id,
      detail: `Delegated ${[...c.scopes].join(", ")} (${who}): the app can do this as the signed-in user, admins included`,
    });
  }
  return [...findings, ...errors];
}

async function consentSettingFindings() {
  let pol;
  try {
    pol = await graphGet("/policies/authorizationPolicy", TOOL_ID);
  } catch (err) {
    throw new Error(graphHint(err, "Policy.Read.All"));
  }
  const p = Array.isArray(pol.value) ? pol.value[0] || {} : pol;
  const assigned = ((p.defaultUserRolePermissions || {}).permissionGrantPoliciesAssigned) || [];
  if (!assigned.some((x) => /microsoft-user-default-legacy/i.test(x))) return [];
  return [{ ...TENANT, kind: "user-consent-unrestricted", id: `${TOOL_ID}/user-consent`, name: "User consent", detail: "Users may consent to any app asking for their data (the legacy setting). Allow only verified publishers and low-risk permissions, or require admin approval" }];
}

async function run() {
  let sp;
  try {
    sp = await graphSp();
  } catch (err) {
    throw new Error(graphHint(err, "Application.Read.All"));
  }
  return runChecks(TOOL_ID, {
    "Application permissions": () => applicationFindings(sp),
    "Delegated consents": () => delegatedFindings(sp),
    "User consent setting": consentSettingFindings,
  });
}

module.exports = {
  id: TOOL_ID,
  label: "App permissions",
  schedule: "15 5 * * *", // daily at 05:15
  run,
};
