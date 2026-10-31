// The Enterprise apps scan: which service principals get which finding, from sample Graph payloads.
// Plain data in, no Azure and no network.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const { classify, activeSigningCert, ownCredentials, signInTimes, disabledWithRoles } = require("../src/tools/enterpriseApps")._test;

after(env.cleanup);

const NOW = Date.parse("2026-10-31T12:00:00Z");
const TENANT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER = "cccccccc-0000-4000-8000-000000000009";
const MICROSOFT = "f8cdef31-a31e-4b4a-93e4-5f571e91255a";
const inDays = (n) => new Date(NOW + n * 86400000).toISOString();
// customKeyIdentifier as Graph returns it for SAML certificates: the thumbprint bytes, base64.
const kid = (hex) => Buffer.from(hex, "hex").toString("base64");
const OLD_THUMB = "AAAA0000AAAA0000AAAA0000AAAA0000AAAA0000";
const NEW_THUMB = "BBBB1111BBBB1111BBBB1111BBBB1111BBBB1111";

const sp = (o) => ({ servicePrincipalType: "Application", accountEnabled: true, appOwnerOrganizationId: TENANT_ID, owners: [{ id: "u1" }], keyCredentials: [], passwordCredentials: [], ...o });
const opts = (o = {}) => ({ tenantId: TENANT_ID, warnDays: 30, unusedDays: 90, signIns: null, now: NOW, ...o });
const kinds = (fs) => fs.map((f) => f.kind).sort();

// A SAML app with an old (inactive, long expired) and the active signing certificate, the Verify twins and the
// password that guards the signing key, as Entra stores them.
function samlApp(activeEnd, extra = {}) {
  return sp({
    id: "sp-saml",
    appId: "app-saml",
    displayName: "Payroll (SAML)",
    preferredSingleSignOnMode: "saml",
    preferredTokenSigningKeyThumbprint: NEW_THUMB,
    appRoleAssignmentRequired: true,
    keyCredentials: [
      { keyId: "k-old-sign", usage: "Sign", type: "AsymmetricX509Cert", customKeyIdentifier: kid(OLD_THUMB), endDateTime: inDays(-400) },
      { keyId: "k-old-verify", usage: "Verify", type: "AsymmetricX509Cert", customKeyIdentifier: kid(OLD_THUMB), endDateTime: inDays(-400) },
      { keyId: "k-new-sign", usage: "Sign", type: "AsymmetricX509Cert", customKeyIdentifier: kid(NEW_THUMB), endDateTime: activeEnd },
      { keyId: "k-new-verify", usage: "Verify", type: "AsymmetricX509Cert", customKeyIdentifier: kid(NEW_THUMB), endDateTime: activeEnd },
    ],
    passwordCredentials: [
      { keyId: "p-old", customKeyIdentifier: kid(OLD_THUMB), endDateTime: inDays(-400) },
      { keyId: "p-new", customKeyIdentifier: kid(NEW_THUMB), endDateTime: activeEnd },
    ],
    ...extra,
  });
}

test("the active SAML signing certificate is the one matching the preferred thumbprint", () => {
  const app = samlApp(inDays(200));
  assert.equal(activeSigningCert(app).keyId, "k-new-sign");
  // Without a thumbprint: the Sign key that lasts longest.
  assert.equal(activeSigningCert({ ...app, preferredTokenSigningKeyThumbprint: null }).keyId, "k-new-sign");
  // Thumbprint stored as hex text instead of raw bytes.
  const text = { ...app, keyCredentials: [{ keyId: "t", usage: "Sign", customKeyIdentifier: Buffer.from(NEW_THUMB).toString("base64"), endDateTime: inDays(5) }, ...app.keyCredentials.slice(0, 1)] };
  assert.equal(activeSigningCert(text).keyId, "t");
  assert.equal(activeSigningCert(sp({ keyCredentials: [] })), null);
});

test("SAML certificate: expired and under 14 days are critical kinds, within the window a warning, later nothing", () => {
  const f = (end) => classify([samlApp(end)], opts()).filter((x) => x.kind.startsWith("ent-saml"));
  assert.deepEqual(kinds(f(inDays(-1))), ["ent-saml-cert-expired"]);
  assert.deepEqual(kinds(f(inDays(5))), ["ent-saml-cert-expiring-soon"]);
  assert.deepEqual(kinds(f(inDays(25))), ["ent-saml-cert-expiring"]);
  assert.deepEqual(kinds(f(inDays(200))), []);
  const one = f(inDays(5))[0];
  assert.equal(one.id, "sp-saml/k-new-sign#saml-cert");
  assert.equal(one.expires, inDays(5));
  assert.match(one.detail, /in 5 days/);
  // The old expired certificate is not active, so it is not reported.
  assert.ok(!classify([samlApp(inDays(200))], opts()).length);
});

test("the SAML signing set is not counted again as service principal credentials", () => {
  const own = ownCredentials(samlApp(inDays(5)));
  assert.deepEqual(own.keys, []);
  assert.deepEqual(own.passwords, []);
  // A real secret added next to it still counts.
  const app = samlApp(inDays(200));
  app.passwordCredentials.push({ keyId: "p-extra", displayName: "ci", endDateTime: inDays(10) });
  assert.deepEqual(ownCredentials(app).passwords.map((c) => c.keyId), ["p-extra"]);
});

test("credentials on the service principal: expiry bands, and live secrets on this tenant's apps", () => {
  const app = sp({
    id: "sp-own",
    appId: "app-own",
    displayName: "Line-of-business API",
    passwordCredentials: [
      { keyId: "p1", displayName: "old", endDateTime: inDays(-3) },
      { keyId: "p2", displayName: "current", endDateTime: inDays(400) },
    ],
    keyCredentials: [{ keyId: "c1", usage: "Verify", type: "AsymmetricX509Cert", endDateTime: inDays(20) }],
  });
  const f = classify([app], opts());
  assert.deepEqual(kinds(f), ["ent-sp-credential-expired", "ent-sp-credential-expiring", "ent-sp-secret"]);
  assert.equal(f.find((x) => x.kind === "ent-sp-credential-expired").id, "sp-own/p1#sp-credential");
  assert.match(f.find((x) => x.kind === "ent-sp-secret").detail, /^1 client secret /);
  // Another company's app: expiry still counts, the mere secret does not.
  assert.deepEqual(kinds(classify([{ ...app, appOwnerOrganizationId: OTHER }], opts())), ["ent-sp-credential-expired", "ent-sp-credential-expiring"]);
  // A soon-expiring one is critical.
  const soon = sp({ id: "s", passwordCredentials: [{ keyId: "p", endDateTime: inDays(3) }] });
  assert.ok(kinds(classify([soon], opts())).includes("ent-sp-credential-expiring-soon"));
});

test("open sign-in: SAML apps and other companies' OIDC apps, never Microsoft's or this tenant's OIDC apps", () => {
  const open = (o) => classify([sp({ id: "x", appRoleAssignmentRequired: false, ...o })], opts()).filter((f) => f.kind === "ent-open-sign-in");
  assert.equal(open({ preferredSingleSignOnMode: "saml" }).length, 1);
  assert.equal(open({ preferredSingleSignOnMode: "oidc", appOwnerOrganizationId: OTHER }).length, 1);
  assert.equal(open({ preferredSingleSignOnMode: "oidc" }).length, 0);
  assert.equal(open({ preferredSingleSignOnMode: "saml", appOwnerOrganizationId: MICROSOFT }).length, 0);
  assert.equal(open({ preferredSingleSignOnMode: null, appOwnerOrganizationId: OTHER }).length, 0);
  assert.equal(open({ preferredSingleSignOnMode: "saml", appRoleAssignmentRequired: true }).length, 0);
  assert.equal(open({ preferredSingleSignOnMode: "saml", accountEnabled: false }).length, 0);
});

test("no owner only for enabled apps from this tenant; managed identities and Microsoft apps are skipped", () => {
  const f = classify(
    [
      sp({ id: "a", owners: [] }),
      sp({ id: "b", owners: [], accountEnabled: false }),
      sp({ id: "c", owners: [], appOwnerOrganizationId: OTHER }),
      sp({ id: "d", owners: [], servicePrincipalType: "ManagedIdentity", passwordCredentials: [{ keyId: "m", endDateTime: inDays(1) }] }),
      sp({ id: "e", owners: [], appOwnerOrganizationId: MICROSOFT, passwordCredentials: [{ keyId: "m", endDateTime: inDays(1) }] }),
    ],
    opts()
  );
  assert.deepEqual(f.map((x) => `${x.kind} ${x.principalId}`), ["ent-no-owner a"]);
  // Without this tenant's id nothing counts as "ours".
  assert.equal(classify([sp({ id: "a", owners: [] })], opts({ tenantId: null })).length, 0);
});

test("unused third-party apps from the sign-in activity report; skipped when the report could not be read", () => {
  const rows = [
    { appId: "app-old", lastSignInActivity: { lastSignInDateTime: inDays(-120) }, delegatedClientSignInActivity: { lastSignInDateTime: inDays(-200) } },
    { appId: "app-recent", lastSignInActivity: { lastSignInDateTime: inDays(-200) }, applicationAuthenticationClientSignInActivity: { lastSignInDateTime: inDays(-2) } },
    { appId: "app-none", lastSignInActivity: { lastSignInDateTime: null } },
  ];
  const signIns = signInTimes(rows);
  assert.equal(signIns.get("app-recent"), Date.parse(inDays(-2)));
  assert.equal(signIns.get("app-none"), null);
  const apps = [
    sp({ id: "o", appId: "app-old", appOwnerOrganizationId: OTHER }),
    sp({ id: "r", appId: "app-recent", appOwnerOrganizationId: OTHER }),
    sp({ id: "n", appId: "app-none", appOwnerOrganizationId: OTHER }),
    sp({ id: "m", appId: "app-missing", appOwnerOrganizationId: OTHER }),
    sp({ id: "mine", appId: "app-old", appOwnerOrganizationId: TENANT_ID }),
    sp({ id: "ms", appId: "app-old", appOwnerOrganizationId: MICROSOFT }),
  ];
  const f = classify(apps, opts({ signIns })).filter((x) => x.kind === "ent-unused-app");
  assert.deepEqual(f.map((x) => x.principalId), ["o"]);
  assert.match(f[0].detail, /120 days/);
  assert.equal(classify(apps, opts({ signIns: null })).filter((x) => x.kind === "ent-unused-app").length, 0);
});

test("disabled apps that still hold Azure role assignments", () => {
  const sps = [sp({ id: "AAA-1", displayName: "Old deploy", accountEnabled: false }), sp({ id: "bbb-2", displayName: "Live" })];
  const rows = [
    { principalId: "aaa-1", scope: "/subscriptions/s1", subscriptionId: "s1" },
    { principalId: "aaa-1", scope: "/subscriptions/s1/resourceGroups/rg", subscriptionId: "s1" },
    { principalId: "bbb-2", scope: "/subscriptions/s1", subscriptionId: "s1" },
  ];
  const f = disabledWithRoles(sps, rows);
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "ent-disabled-azure-roles");
  assert.equal(f[0].id, "AAA-1#disabled-azure-roles");
  assert.equal(f[0].subscriptionId, "s1");
  assert.match(f[0].detail, /2 Azure role assignments/);
});
