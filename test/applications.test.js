// The Applications scan's run: the app registration parts and the enterprise
// apps part report together, and a failing part is one scan-error finding
// while the rest stays. Graph, Azure and the log are stubbed. The judgements
// themselves are tested in enterpriseApps.test.js and identityChecks.test.js.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const graphClient = require("../src/graphClient");
const arm = require("../src/armClient");
const log = require("../src/log");

const TENANT_ID = "aaaaaaaa-0000-4000-8000-000000000001";
let answer = () => [];
// Before the tool is loaded: it takes the client functions when required.
graphClient.graphGetAll = async (url) => answer(url);
graphClient.getGraphToken = async () => `x.${Buffer.from(JSON.stringify({ tid: TENANT_ID })).toString("base64url")}.y`;
arm.resourceGraphQuery = async () => [];
log.record = () => {};
const tool = require("../src/tools/applications");

after(env.cleanup);

const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
const registration = { id: "app1", appId: "a1", displayName: "App one" };
const expiring = { ...registration, passwordCredentials: [{ keyId: "k1", displayName: "old", endDateTime: inDays(10) }], keyCredentials: [] };
const unowned = { ...registration, owners: [], passwordCredentials: [], keyCredentials: [] };
const sp = { id: "sp1", appId: "a9", displayName: "Vendor SSO", accountEnabled: true, appOwnerOrganizationId: TENANT_ID, servicePrincipalType: "Application", owners: [] };

const byUrl = (servicePrincipals) => (url) => {
  if (/servicePrincipalSignInActivities/.test(url)) return [];
  if (/\/servicePrincipals\?/.test(url)) return servicePrincipals();
  if (/federatedIdentityCredentials/.test(url)) return [];
  if (/\$expand=owners/.test(url)) return [unowned];
  if (/\/applications\?/.test(url)) return [expiring];
  throw new Error(`unexpected Graph call ${url}`);
};
const summary = (out) => out.map((f) => [f.kind, f.id]).sort();

test("run: expiring credentials, app registration hygiene and enterprise apps come from one run", async () => {
  answer = byUrl(() => [sp]);
  assert.deepEqual(summary(await tool.run()), [
    ["app-credential-expiring", "app1/k1"],
    ["app-no-owner", "app1#no-owner"],
    ["ent-no-owner", "sp1#no-owner"],
  ]);
  assert.equal(tool.replaces.join(","), "secret-expiry,enterprise-apps");
});

test("run: a refused enterprise apps read is one scan error naming the permission; the app registration parts stay", async () => {
  answer = byUrl(() => { throw new Error("Graph GET failed (403): Authorization_RequestDenied"); });
  const out = await tool.run();
  assert.deepEqual(summary(out), [
    ["app-credential-expiring", "app1/k1"],
    ["app-no-owner", "app1#no-owner"],
    ["scan-error", "applications/scan-errors/Enterprise apps"],
  ]);
  assert.match(out.find((f) => f.kind === "scan-error").detail, /Application\.Read\.All/);
});
