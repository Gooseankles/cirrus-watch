// The PIM scan's Graph reads that need care: Entra activation history from the
// directory audit log (the request list takes only a ReadWrite permission), and
// looking up people, groups and apps when one id is a deleted object (Graph can
// refuse the whole "in" filter with Request_ResourceNotFound). Graph is stubbed.
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const graphClient = require("../src/graphClient");

const calls = [];
let answer = () => [];
// Before the tool is loaded: it takes the Graph helpers when required.
graphClient.graphGet = async (url) => { calls.push(["GET", url]); return answer("GET", url); };
graphClient.graphGetAll = async (url) => { calls.push(["ALL", url]); return answer("ALL", url); };

const { activationKey, byIds } = require("../src/tools/pim")._test;

after(env.cleanup);
beforeEach(() => {
  calls.length = 0;
  answer = () => [];
});

const notFound = (id) => Object.assign(new Error(`Graph GET https://graph.microsoft.com/v1.0/groups failed (404): {"error":{"code":"Request_ResourceNotFound","message":"Resource '${id}' does not exist"}}`), { status: 404 });
const ROLE = "62e90394-69f5-4237-9190-012177145e10";
const USER = "11111111-1111-4111-8111-111111111111";

test("an activation audit event gives the person who started it and the role", () => {
  const event = {
    activityDateTime: "2026-10-30T08:00:00Z",
    initiatedBy: { user: { id: USER, userPrincipalName: "a@contoso.com" } },
    targetResources: [{ type: "Role", id: ROLE, displayName: "Global Administrator" }, { type: "User", id: USER }],
  };
  assert.equal(activationKey(event), `${USER}|entra|${ROLE}`);
});

test("without an initiating user the User target is used; without a role there is no key", () => {
  assert.equal(activationKey({ initiatedBy: {}, targetResources: [{ type: "Role", id: ROLE }, { type: "User", id: USER }] }), `${USER}|entra|${ROLE}`);
  assert.equal(activationKey({ initiatedBy: { user: { id: USER } }, targetResources: [{ type: "User", id: USER }] }), null);
  assert.equal(activationKey({}), null);
});

test("ids are looked up with one filter when Graph answers it", async () => {
  answer = () => [{ id: "a" }, { id: "b" }];
  assert.deepEqual(await byIds("groups", ["a", "b"], "id,displayName"), [{ id: "a" }, { id: "b" }]);
  assert.equal(calls.length, 1);
  assert.match(calls[0][1], /^\/groups\?\$filter=id in \('a','b'\)&\$select=id,displayName$/);
});

test("a deleted object in the filter: each id is asked for alone and the missing one is left out", async () => {
  answer = (kind, url) => {
    if (kind === "ALL") throw notFound("gone");
    if (url.startsWith("/groups/gone")) throw notFound("gone");
    return { id: url.split("/")[2].split("?")[0] };
  };
  assert.deepEqual(await byIds("groups", ["a", "gone", "b"], "id"), [{ id: "a" }, { id: "b" }]);
  assert.deepEqual(calls.map((c) => c[0]), ["ALL", "GET", "GET", "GET"]);
});

test("any other error goes on to the caller (it becomes the batch's scan error)", async () => {
  answer = () => { throw Object.assign(new Error("Graph GET x failed (403): Authorization_RequestDenied"), { status: 403 }); };
  await assert.rejects(byIds("users", ["a"], "id"), /403/);
  answer = (kind) => { if (kind === "ALL") throw notFound("x"); throw new Error("Graph GET x failed (500): {}"); };
  await assert.rejects(byIds("users", ["a"], "id"), /500/);
});

test("unused eligibility is judged only on a history of the row's own plane that reaches back far enough", () => {
  const { peopleFindings } = require("../src/tools/pim")._test;
  const day = 86400000;
  const hist = (plane, daysBack) => ({ plane, last: new Map(), oldest: Date.now() - daysBack * day });
  const row = (plane) => ({ id: `r-${plane}`, plane, privileged: true, kind: "user", state: "eligible", via: "direct", role: "Owner", scopeText: "x", start: new Date(Date.now() - 400 * day).toISOString(), end: new Date(Date.now() + 200 * day).toISOString(), personId: USER });
  const unused = (histories, plane) => peopleFindings([row(plane)], { histories }).filter((f) => f.kind === "pim-eligible-unused").length;
  // A 30-day Entra audit log does not cover the 90-day window, even when an Azure history does.
  assert.equal(unused([hist("entra", 30), hist("azure", 365)], "entra"), 0);
  assert.equal(unused([hist("entra", 30), hist("azure", 365)], "azure"), 1);
  assert.equal(unused([hist("entra", 120)], "entra"), 1);
});
