// The Architecture scan's identity and sign-in lines: which managed identity may
// reach which resource (roles, vault access policies) and which app
// registration signs people in to which web app. Plain data in, no Azure.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const { build, identityLinks } = require("../src/tools/architecture")._test;

after(env.cleanup);

const RG = "/subscriptions/s1/resourcegroups/rg-app";
const APP = `${RG}/providers/microsoft.web/sites/app1`;
const ST = `${RG}/providers/microsoft.storage/storageaccounts/st1`;
const KV = `${RG}/providers/microsoft.keyvault/vaults/kv1`;
const UAMI = `${RG}/providers/microsoft.managedidentity/userassignedidentities/id1`;
const res = [
  { id: APP, type: "microsoft.web/sites", principal: "p-app", identities: [UAMI], hosts: ["app1.azurewebsites.net", "app.contoso.com"] },
  { id: ST, type: "microsoft.storage/storageaccounts" },
  { id: KV, type: "microsoft.keyvault/vaults" },
  { id: UAMI, type: "microsoft.managedidentity/userassignedidentities", principal: "p-uami" },
];
const BLOB_CONTRIB = "ba92f5b4-2d11-453d-a403-e96b0029c9fe";
const roleDefs = [
  { id: `/providers/microsoft.authorization/roledefinitions/${BLOB_CONTRIB}`, roleName: "Storage Blob Data Contributor" },
  { id: "/providers/microsoft.authorization/roledefinitions/acdd72a7-3385-48ef-bd42-f606fba81ae7", roleName: "Reader" },
];
const role = (principalId, guid, scope) => ({ principalId, roleDefinitionId: `/subscriptions/s1/providers/microsoft.authorization/roledefinitions/${guid}`, scope });

test("a role on a resource, or a part of it, is a data or control line to that resource", () => {
  const { access } = identityLinks(
    {
      roleDefs,
      roles: [
        role("p-app", BLOB_CONTRIB, `${ST}/blobservices/default/containers/history`),
        role("p-app", "acdd72a7-3385-48ef-bd42-f606fba81ae7", ST),
        role("p-uami", "acdd72a7-3385-48ef-bd42-f606fba81ae7", KV),
      ],
    },
    res
  );
  assert.deepEqual(access, [
    { from: APP, to: ST, roles: ["Storage Blob Data Contributor", "Reader"], kind: "data" },
    { from: UAMI, to: KV, roles: ["Reader"], kind: "control" },
  ]);
});

test("a role on a resource group points at the group; subscription roles, people and unknown targets are left out", () => {
  const { access } = identityLinks(
    {
      roleDefs,
      roles: [
        role("p-app", "acdd72a7-3385-48ef-bd42-f606fba81ae7", RG),
        role("p-app", "acdd72a7-3385-48ef-bd42-f606fba81ae7", "/subscriptions/s1"),
        role("someone-else", BLOB_CONTRIB, ST),
        role("p-app", BLOB_CONTRIB, `${RG}/providers/microsoft.storage/storageaccounts/not-scanned`),
      ],
    },
    res
  );
  assert.deepEqual(access, [{ from: APP, to: "rg:s1|rg-app", roles: ["Reader"], kind: "control" }]);
});

test("a vault access policy for an identity is a data line, with what it may do", () => {
  const { access } = identityLinks(
    { roles: [], vaultPolicies: [{ id: KV, policies: [{ objectId: "P-APP", permissions: { secrets: ["Get", "List"], keys: [] } }, { objectId: "a-person" }] }] },
    res
  );
  assert.deepEqual(access, [{ from: APP, to: KV, roles: ["Access policy (secrets: get, list)"], kind: "data" }]);
});

test("unread data is null, so the page can say so; an empty read is an empty list", () => {
  assert.deepEqual(identityLinks({}, res), { access: null, signIns: null });
  assert.deepEqual(identityLinks({ roles: [], apps: [] }, res), { access: [], signIns: [] });
});

test("an app registration signs in to the web app its redirect URI points at", () => {
  const { signIns } = identityLinks(
    {
      apps: [
        { appId: "a1", displayName: "Cirrus Watch sign-in", web: { redirectUris: ["https://app1.azurewebsites.net/auth/callback"] } },
        { appId: "a2", displayName: "Custom domain SPA", spa: { redirectUris: ["https://APP.contoso.com/"] } },
        { appId: "a3", displayName: "Elsewhere", web: { redirectUris: ["https://other.example.com/cb", "not a url"] } },
      ],
    },
    res
  );
  assert.deepEqual(signIns, [
    { appId: "a1", name: "Cirrus Watch sign-in", to: [APP] },
    { appId: "a2", name: "Custom domain SPA", to: [APP] },
  ]);
});

test("the saved drawing carries identities, host names and the lines", () => {
  const d = {
    resources: [
      { id: APP.replace("app1", "APP1"), name: "app1", resType: "microsoft.web/sites", resourceGroup: "rg-app", subscriptionId: "s1", principal: "p-app", uamis: [UAMI.toUpperCase()], hosts: ["App1.azurewebsites.net"] },
      { id: ST, name: "st1", resType: "microsoft.storage/storageaccounts", resourceGroup: "rg-app", subscriptionId: "s1" },
    ],
    vnets: [],
    groups: [],
    subs: [],
    sites: [],
    connections: [],
    roleDefs,
    roles: [role("p-app", BLOB_CONTRIB, ST)],
    apps: null,
  };
  const out = build(d);
  const app = out.resources.find((r) => r.id === APP);
  assert.equal(app.principal, "p-app");
  assert.deepEqual(app.identities, [UAMI]);
  assert.deepEqual(app.hosts, ["app1.azurewebsites.net"]);
  assert.deepEqual(out.access, [{ from: APP, to: ST, roles: ["Storage Blob Data Contributor"], kind: "data" }]);
  assert.equal(out.signIns, null);
});
