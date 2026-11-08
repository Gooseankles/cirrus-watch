// The Entra identity checks added together: cross-tenant partners and the
// authentication methods policy (Entra tenant settings), legacy sign-ins,
// Conditional Access depth (device code flow, admin exclusions), synced admin
// accounts, and app registration extras (federated credential subjects,
// redirect URIs, multi-tenant apps). Pure functions with plain objects in, no
// Graph calls.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const tenant = require("../src/tools/tenantSettings")._test;
const legacy = require("../src/tools/accounts")._test.legacy;
const ca = require("../src/tools/conditionalAccess")._test;
const roles = require("../src/tools/privilegedRoles")._test;
const secrets = require("../src/tools/applications")._test; // the app registration parts
const perms = require("../src/tools/appPermissions")._test;

after(env.cleanup);

const kinds = (findings) => findings.map((f) => f.kind).sort();
const GA = "62e90394-69f5-4237-9190-012177145e10";
const USER_ADMIN = "fe930be7-5e62-47db-91af-98c3a49a38b1";

// ---- Entra tenant settings: cross-tenant ----

const openInbound = {
  b2bCollaborationInbound: {
    usersAndGroups: { accessType: "allowed", targets: [{ target: "AllUsers", targetType: "user" }] },
    applications: { accessType: "allowed", targets: [{ target: "AllApplications", targetType: "application" }] },
  },
};

test("B2B collaboration open to all tenants is flagged; a blocked or narrowed default is not", () => {
  assert.deepEqual(kinds(tenant.judgeCollaborationDefault(openInbound)), ["tenant-b2b-inbound-open"]);
  const blocked = structuredClone(openInbound);
  blocked.b2bCollaborationInbound.usersAndGroups.accessType = "blocked";
  assert.deepEqual(tenant.judgeCollaborationDefault(blocked), []);
  const someApps = structuredClone(openInbound);
  someApps.b2bCollaborationInbound.applications.targets = [{ target: "00000003-0000-0ff1-ce00-000000000000", targetType: "application" }];
  assert.deepEqual(tenant.judgeCollaborationDefault(someApps), []);
  assert.deepEqual(tenant.judgeCollaborationDefault({}), []);
});

test("partners: trusted MFA or device claims and skipped consent each give one finding naming the partners", () => {
  const partners = [
    { tenantId: "t1", displayName: "Contoso", inboundTrust: { isMfaAccepted: true, isCompliantDeviceAccepted: false, isHybridAzureADJoinedDeviceAccepted: true } },
    { tenantId: "t2", inboundTrust: null, automaticUserConsentSettings: { inboundAllowed: true, outboundAllowed: null } },
    { tenantId: "t3", inboundTrust: { isMfaAccepted: false }, automaticUserConsentSettings: { inboundAllowed: false, outboundAllowed: false } },
  ];
  const out = tenant.judgePartners(partners);
  assert.deepEqual(kinds(out), ["tenant-partner-auto-consent", "tenant-partner-mfa-trust"]);
  const trust = out.find((f) => f.kind === "tenant-partner-mfa-trust");
  assert.match(trust.detail, /Contoso \(MFA, hybrid joined devices\)/);
  assert.doesNotMatch(trust.detail, /t3/);
  assert.match(out.find((f) => f.kind === "tenant-partner-auto-consent").detail, /t2 \(inbound\)/);
  assert.deepEqual(tenant.judgePartners([]), []);
  assert.deepEqual(tenant.judgePartners([{ tenantId: "t4" }]), []);
});

// ---- Entra tenant settings: authentication methods policy ----

const method = (id, state, extra = {}) => ({ id, state, includeTargets: [{ id: "all_users", targetType: "group" }], ...extra });
const goodPolicy = () => ({
  policyMigrationState: "migrationComplete",
  registrationEnforcement: { authenticationMethodsRegistrationCampaign: { state: "enabled" } },
  authenticationMethodConfigurations: [
    method("Fido2", "enabled"),
    method("Sms", "disabled"),
    method("Voice", "disabled"),
    method("TemporaryAccessPass", "enabled", { isUsableOnce: true, defaultLifetimeInMinutes: 60, maximumLifetimeInMinutes: 480 }),
  ],
});

test("a tidy authentication methods policy gives no findings", () => {
  assert.deepEqual(tenant.judgeAuthMethods(goodPolicy()), []);
});

test("SMS for all users, a long access pass, passkeys off, migration and a disabled campaign are flagged", () => {
  const p = goodPolicy();
  p.policyMigrationState = "preMigration";
  p.registrationEnforcement.authenticationMethodsRegistrationCampaign.state = "disabled";
  p.authenticationMethodConfigurations = [
    method("Fido2", "disabled"),
    method("Sms", "enabled"),
    method("Voice", "enabled", { includeTargets: [{ id: "some-group-id", targetType: "group" }] }),
    method("TemporaryAccessPass", "enabled", { isUsableOnce: false, maximumLifetimeInMinutes: 43200 }),
  ];
  const out = tenant.judgeAuthMethods(p);
  assert.deepEqual(kinds(out), ["authm-campaign-off", "authm-fido2-off", "authm-migration-incomplete", "authm-sms-voice-all", "authm-tap-long"]);
  const sms = out.find((f) => f.kind === "authm-sms-voice-all");
  assert.match(sms.name, /^SMS allowed/);
  assert.doesNotMatch(sms.name, /voice/, "voice is only for a group, so not named");
  assert.match(out.find((f) => f.kind === "authm-tap-long").detail, /720 hours/);
});

test("a Microsoft managed campaign and a reusable access pass at the default lifetime are not findings", () => {
  const p = goodPolicy();
  p.registrationEnforcement.authenticationMethodsRegistrationCampaign.state = "default";
  p.authenticationMethodConfigurations = [method("TemporaryAccessPass", "enabled", { isUsableOnce: false, maximumLifetimeInMinutes: 480 })];
  assert.deepEqual(tenant.judgeAuthMethods(p), []);
  delete p.registrationEnforcement; // tenants without the block at all
  assert.deepEqual(tenant.judgeAuthMethods(p), []);
});

test("access pass settings are ignored while the method is off; a missing FIDO2 entry is not called off", () => {
  const p = goodPolicy();
  p.authenticationMethodConfigurations = [method("TemporaryAccessPass", "disabled", { isUsableOnce: false, maximumLifetimeInMinutes: 43200 })];
  assert.deepEqual(tenant.judgeAuthMethods(p), []);
});

// ---- Legacy sign-ins ----

test("legacy sign-ins are grouped per user and client, successful ones only, client names in any case", () => {
  const rows = [
    { id: "1", userId: "u1", userPrincipalName: "ann@x.com", clientAppUsed: "IMAP4", createdDateTime: "2026-10-28T10:00:00Z", status: { errorCode: 0 }, appDisplayName: "Office 365 Exchange Online" },
    { id: "2", userId: "u1", userPrincipalName: "ann@x.com", clientAppUsed: "imap4", createdDateTime: "2026-10-30T09:00:00Z", status: { errorCode: 0 } },
    { id: "2", userId: "u1", userPrincipalName: "ann@x.com", clientAppUsed: "IMAP4", createdDateTime: "2026-10-30T09:00:00Z", status: { errorCode: 0 } },
    { id: "3", userId: "u1", userPrincipalName: "ann@x.com", clientAppUsed: "Authenticated SMTP", createdDateTime: "2026-10-29T08:00:00Z", status: { errorCode: 0 } },
    { id: "4", userId: "u2", userPrincipalName: "bob@x.com", clientAppUsed: "POP3", createdDateTime: "2026-10-29T08:00:00Z", status: { errorCode: 50126 } },
    { id: "5", userId: "u2", userPrincipalName: "bob@x.com", clientAppUsed: "Browser", createdDateTime: "2026-10-29T08:00:00Z", status: { errorCode: 0 } },
  ];
  const out = legacy.groupLegacy(rows);
  assert.equal(out.length, 2);
  const imap = out.find((f) => /imap4/.test(f.id));
  assert.equal(imap.kind, "legacy-signin-used");
  assert.equal(imap.name, "ann@x.com");
  assert.equal(imap.principalId, "u1");
  assert.match(imap.detail, /^2 successful interactive sign-in\(s\) with IMAP4/, "the repeated row id counts once");
  assert.match(imap.detail, /last at 2026-10-30T09:00:00Z/);
  assert.ok(out.some((f) => /authenticated-smtp/.test(f.id)));
  assert.deepEqual(legacy.groupLegacy([]), []);
});

test("the legacy client list holds both the short and the long spellings", () => {
  for (const c of ["IMAP", "IMAP4", "POP", "POP3", "SMTP", "Authenticated SMTP", "Exchange ActiveSync", "Other clients"]) assert.ok(legacy.LEGACY_CLIENTS.includes(c), c);
  assert.ok(!legacy.LEGACY_CLIENTS.includes("Browser"));
});

// ---- Conditional Access ----

const policy = (over) => ({
  id: over.id || "p",
  displayName: over.displayName || over.id || "p",
  state: over.state || "enabled",
  conditions: { users: { includeUsers: ["All"], ...(over.users || {}) }, applications: { includeApplications: ["All"] }, clientAppTypes: over.clientAppTypes || ["all"], ...(over.conditions || {}) },
  grantControls: over.grant || { operator: "OR", builtInControls: ["mfa"] },
});

test("device code flow: only an enabled block policy for all users counts; report-only does not", () => {
  const block = policy({ id: "dc", conditions: { authenticationFlows: { transferMethods: "deviceCodeFlow,authenticationTransfer" } }, grant: { operator: "OR", builtInControls: ["block"] } });
  assert.equal(ca.blocksDeviceCode(block), true);
  const mfa = policy({ id: "x", conditions: { authenticationFlows: { transferMethods: "deviceCodeFlow" } } });
  assert.equal(ca.blocksDeviceCode(mfa), false);
  const base = [policy({ id: "all-mfa" })];
  assert.ok(kinds(ca.analyse(base, false, 5)).includes("ca-device-code-not-blocked"));
  assert.ok(!kinds(ca.analyse([...base, block], false, 5)).includes("ca-device-code-not-blocked"));
  assert.ok(kinds(ca.analyse([...base, { ...block, state: "enabledForReportingButNotEnforced" }], false, 5)).includes("ca-device-code-not-blocked"));
});

test("authentication strength for admins: an enabled policy with a strength for all users or Global Admins counts", () => {
  const base = [policy({ id: "all-mfa" })];
  assert.ok(kinds(ca.analyse(base, false, 5)).includes("ca-no-admin-auth-strength"));
  const strength = policy({ id: "s", users: { includeUsers: [], includeRoles: [GA] }, grant: { authenticationStrength: { id: "00000000-0000-0000-0000-000000000004" } } });
  assert.ok(!kinds(ca.analyse([...base, strength], false, 5)).includes("ca-no-admin-auth-strength"));
  assert.ok(kinds(ca.analyse([...base, { ...strength, state: "enabledForReportingButNotEnforced" }], false, 5)).includes("ca-no-admin-auth-strength"));
});

test("admins excluded from enabled MFA or block policies by user, group or role are flagged; named break-glass accounts are not", () => {
  const admins = [
    { id: "a1", upn: "alice@x.com", roles: new Set([USER_ADMIN]), synced: false },
    { id: "a2", upn: "bob@x.com", roles: new Set([USER_ADMIN]), synced: false },
    { id: "a3", upn: "carol@x.com", roles: new Set([USER_ADMIN]), synced: false },
    { id: "bg", upn: "BreakGlass1@x.com", roles: new Set([GA]), synced: false },
    { id: "a4", upn: "dave@x.com", roles: new Set(["194ae4cb-b126-40b2-bd5b-6091b380977d"]), synced: false },
  ];
  const policies = [
    policy({ id: "mfa-all", displayName: "MFA all", users: { excludeUsers: ["a1", "bg"], excludeGroups: ["g1"] } }),
    policy({ id: "admins", displayName: "Admins", users: { includeUsers: [], includeRoles: [USER_ADMIN], excludeRoles: [USER_ADMIN] } }),
    policy({ id: "ro", state: "enabledForReportingButNotEnforced", users: { excludeUsers: ["a4"] } }),
    policy({ id: "loc", users: { excludeUsers: ["a4"] }, grant: { operator: "OR", builtInControls: ["compliantDevice"] } }),
  ];
  const groups = new Map([["g1", new Set(["a2"])]]);
  const out = ca.adminExclusions(policies, admins, groups, ["breakglass1@x.com"]);
  const byName = new Map(out.map((f) => [f.name, f]));
  assert.deepEqual([...byName.keys()].sort(), ["alice@x.com", "bob@x.com", "carol@x.com"]);
  assert.match(byName.get("alice@x.com").detail, /excluded from 2 enabled MFA or block policies: MFA all, Admins/);
  assert.match(byName.get("bob@x.com").detail, /MFA all, Admins/, "excluded by group and by role");
  assert.match(byName.get("carol@x.com").detail, /excluded from 1 enabled MFA or block policy: Admins/);
  assert.equal(out[0].kind, "ca-admin-excluded");
});

test("with no break-glass accounts named, a cloud-only Global Admin left out of every policy is taken for one", () => {
  const policies = [policy({ id: "mfa-all", users: { excludeUsers: ["bg", "synced", "half"] } }), policy({ id: "admins", users: { includeUsers: [], includeRoles: [GA] } })];
  const admins = [
    { id: "bg", upn: "bg@x.com", roles: new Set([GA]), synced: false },
    { id: "synced", upn: "s@x.com", roles: new Set([GA]), synced: true },
    { id: "half", upn: "h@x.com", roles: new Set([GA]), synced: false },
  ];
  const policiesBg = [policies[0], { ...policies[1], conditions: { ...policies[1].conditions, users: { includeUsers: [], includeRoles: [GA], excludeUsers: ["bg", "synced"] } } }];
  const names = ca.adminExclusions(policiesBg, admins, new Map(), []).map((f) => f.name).sort();
  assert.deepEqual(names, ["h@x.com", "s@x.com"]);
});

// ---- Privileged roles: synced accounts ----

test("synced admin accounts: high for Global Administrators, medium for other roles; cloud-only and disabled are skipped", () => {
  const users = new Map([
    ["u1", { user: { id: "u1", userPrincipalName: "ga@x.com", onPremisesSyncEnabled: true }, roles: ["Global Administrator"] }],
    ["u2", { user: { id: "u2", userPrincipalName: "ua@x.com", onPremisesSyncEnabled: true }, roles: ["User Administrator", "User Administrator"] }],
    ["u3", { user: { id: "u3", userPrincipalName: "cloud@x.com", onPremisesSyncEnabled: null }, roles: ["Global Administrator"] }],
    ["u4", { user: { id: "u4", userPrincipalName: "off@x.com", onPremisesSyncEnabled: true, accountEnabled: false }, roles: ["Security Administrator"] }],
  ]);
  const out = roles.judgeSynced(users, new Set(["u1", "u3"]));
  assert.deepEqual(out.map((f) => [f.name, f.kind]), [["ga@x.com", "privileged-synced-global-admin"], ["ua@x.com", "privileged-synced"]]);
  assert.match(out[1].detail, /holds User Administrator\./);
});

// ---- App registrations ----

test("federated credentials: wildcard and GitHub pull_request subjects are flagged, a branch subject is not", () => {
  const app = { id: "o1", appId: "a1", displayName: "Deploy" };
  const gh = "https://token.actions.githubusercontent.com";
  assert.deepEqual(secrets.judgeFederated(app, [{ name: "main", issuer: gh, subject: "repo:org/repo:ref:refs/heads/main" }]), []);
  assert.deepEqual(secrets.judgeFederated(app, undefined), []);
  const out = secrets.judgeFederated(app, [
    { name: "prs", issuer: gh, subject: "repo:org/repo:pull_request" },
    { name: "any", issuer: "https://example.com", subject: "system:serviceaccount:*" },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "app-fic-broad-subject");
  assert.match(out[0].detail, /prs \(repo:org\/repo:pull_request\), any/);
});

test("redirect URIs: plain http:// (not localhost) and wildcards are flagged", () => {
  const ok = { id: "o1", web: { redirectUris: ["https://app.x.com/cb", "http://localhost:3000/cb", "http://127.0.0.1/cb"] }, publicClient: { redirectUris: ["http://[::1]:8080"] } };
  assert.deepEqual(secrets.judgeRedirects(ok), []);
  const bad = { id: "o2", displayName: "Old", web: { redirectUris: ["http://app.x.com/cb", "https://*.x.com/cb"] }, spa: { redirectUris: ["http://localhost.evil.com/cb"] } };
  const out = secrets.judgeRedirects(bad);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "app-redirect-insecure");
  assert.match(out[0].detail, /http:\/\/app\.x\.com\/cb, https:\/\/\*\.x\.com\/cb, http:\/\/localhost\.evil\.com\/cb/);
  assert.deepEqual(secrets.judgeRedirects({ id: "o3" }), []);
});

test("multi-tenant registrations with a high-impact app permission are flagged; single tenant or no permission is not", () => {
  const reg = { id: "r1", appId: "a1", displayName: "Sync", signInAudience: "AzureADMultipleOrgs" };
  const out = perms.judgeMultiTenant(reg, "sp1", ["Mail.Read"]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "app-multitenant-privileged");
  assert.equal(out[0].principalId, "sp1");
  assert.deepEqual(perms.judgeMultiTenant({ ...reg, signInAudience: "AzureADMyOrg" }, "sp1", ["Mail.Read"]), []);
  assert.deepEqual(perms.judgeMultiTenant(reg, "sp1", []), []);
  assert.deepEqual(perms.judgeMultiTenant(undefined, "sp1", ["Mail.Read"]), [], "registered in another tenant");
});
