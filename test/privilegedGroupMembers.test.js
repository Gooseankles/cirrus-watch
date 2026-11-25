// Privileged roles: expanding a group that holds a role. A 404 on the typed members path is retried untyped; a group
// that is gone (404 again) counts as having no members and is not an error. Other failures still are. Graph is
// stubbed; no Azure.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const graphClient = require("../src/graphClient");

const calls = [];
let answer;
// Before privilegedRoles is loaded: it takes graphGetAll when required.
graphClient.graphGetAll = async (url) => {
  calls.push(url);
  return answer(url);
};
const { groupMembers } = require("../src/tools/privilegedRoles")._test;

after(env.cleanup);

const group = (id) => ({ principal: { id, "@odata.type": "#microsoft.graph.group" } });
const graphError = (status) => new Error(`Graph GET ... failed (${status}): {"error":{"code":"Request_ResourceNotFound"}}`);

test("a 404 on the typed path is retried untyped and only the users are kept", async () => {
  calls.length = 0;
  answer = (url) => {
    if (url.includes("/microsoft.graph.user?")) throw graphError(404);
    return [
      { id: "u1", "@odata.type": "#microsoft.graph.user", userPrincipalName: "a@x" },
      { id: "sp1", "@odata.type": "#microsoft.graph.servicePrincipal" },
    ];
  };
  const r = await groupMembers([group("g1")]);
  assert.deepEqual(r.members.get("g1").map((u) => u.id), ["u1"]);
  assert.equal(r.errors.length, 0);
  assert.equal(calls.length, 2);
});

test("a group that answers 404 both ways has no members and is not an error", async () => {
  answer = () => {
    throw graphError(404);
  };
  const r = await groupMembers([group("gone")]);
  assert.deepEqual(r.members.get("gone"), []);
  assert.equal(r.errors.length, 0);
});

test("any other failure is still reported", async () => {
  answer = () => {
    throw new Error("Graph GET ... failed (403): Authorization_RequestDenied");
  };
  const r = await groupMembers([group("g2")]);
  assert.equal(r.members.has("g2"), false);
  assert.equal(r.errors.length, 1);
});
