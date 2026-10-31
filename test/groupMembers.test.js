// Group members come from Graph beta, because v1.0 leaves service principals
// out (a known Graph issue); v1.0 is the fallback when beta fails for anything
// but a permission refusal. Graph is stubbed; no Azure.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const graphClient = require("../src/graphClient");
const log = require("../src/log");

const calls = [];
const logged = [];
let answer;
log.record = (entry) => logged.push(entry);
// Before accessReview is loaded: it takes graphGet when required.
graphClient.graphGet = async (url) => {
  calls.push(url);
  return answer(url);
};
const { memberType, directMembers, groupMembers } = require("../src/tools/accessReview")._test;

after(env.cleanup);

function graphError(status) {
  const err = new Error(`Graph GET ... failed (${status}): {}`);
  err.status = status;
  return err;
}

const BETA = "https://graph.microsoft.com/beta";
const V1 = "https://graph.microsoft.com/v1.0";

test("service principals are typed App", () => {
  assert.equal(memberType("#microsoft.graph.servicePrincipal"), "App");
  assert.equal(memberType("#microsoft.graph.user"), "User");
  assert.equal(memberType("#microsoft.graph.group"), "Group");
});

test("members are read from beta, pages followed, apps kept with their app ID and kind", async () => {
  calls.length = 0;
  answer = (url) =>
    url.includes("skiptoken")
      ? { value: [{ "@odata.type": "#microsoft.graph.servicePrincipal", id: "sp1", displayName: "Deploy MI", appId: "app-1", servicePrincipalType: "ManagedIdentity" }] }
      : { value: [{ "@odata.type": "#microsoft.graph.user", id: "u1", displayName: "Ann", userPrincipalName: "ann@x", accountEnabled: true }], "@odata.nextLink": `${BETA}/groups/g1/members?$skiptoken=abc` };
  const out = await directMembers("g1", new Map());
  assert.equal(calls.length, 2);
  assert.ok(calls[0].startsWith(`${BETA}/groups/g1/members?$select=`));
  assert.match(calls[0], /appId/);
  assert.match(calls[0], /servicePrincipalType/);
  const app = out.find((m) => m.id === "sp1");
  assert.deepEqual(
    { type: app.type, appId: app.appId, appType: app.appType, enabled: app.enabled },
    { type: "App", appId: "app-1", appType: "ManagedIdentity", enabled: true }
  );
  assert.equal(out.find((m) => m.id === "u1").type, "User");
});

test("an app counts as a member of the group, nested groups included", async () => {
  answer = (url) =>
    url.includes("/groups/top/")
      ? { value: [{ "@odata.type": "#microsoft.graph.group", id: "inner", displayName: "Inner" }] }
      : { value: [{ "@odata.type": "#microsoft.graph.servicePrincipal", id: "sp2", displayName: "Pipeline" }] };
  const r = await groupMembers("top", new Map());
  assert.equal(r.memberTotal, 1);
  assert.equal(r.nestedGroups, 1);
  assert.equal(r.members.find((m) => m.id === "sp2").type, "App");
});

for (const status of [400, 404, 500]) {
  test(`beta failing with ${status} falls back to v1.0 and says so once per run`, async () => {
    calls.length = 0;
    logged.length = 0;
    answer = (url) => {
      if (url.startsWith(BETA)) throw graphError(status);
      return { value: [{ "@odata.type": "#microsoft.graph.user", id: "u2", displayName: "Bo" }] };
    };
    const cache = new Map();
    const out = await directMembers("g2", cache);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].startsWith(`${V1}/groups/g2/members?`));
    assert.deepEqual(out.map((m) => m.id), ["u2"]);
    await directMembers("g2b", cache);
    assert.equal(logged.length, 1, "one warning for the run, not one per group");
    assert.equal(logged[0].level, "warn");
    assert.match(logged[0].message, /v1\.0/);
  });
}

test("a permission refusal (403) on beta is not retried on v1.0", async () => {
  calls.length = 0;
  logged.length = 0;
  answer = () => {
    throw graphError(403);
  };
  await assert.rejects(directMembers("g3", new Map()), /\(403\)/);
  assert.equal(calls.length, 1);
  assert.equal(logged.length, 0);
});

test("a beta failure on a later page starts over on v1.0, without duplicates", async () => {
  calls.length = 0;
  answer = (url) => {
    if (url.startsWith(BETA) && url.includes("skiptoken")) throw graphError(500);
    if (url.startsWith(BETA)) return { value: [{ "@odata.type": "#microsoft.graph.user", id: "u3", displayName: "Cy" }], "@odata.nextLink": `${BETA}/groups/g4/members?$skiptoken=x` };
    return { value: [{ "@odata.type": "#microsoft.graph.user", id: "u3", displayName: "Cy" }] };
  };
  const out = await directMembers("g4", new Map());
  assert.deepEqual(out.map((m) => m.id), ["u3"]);
});
