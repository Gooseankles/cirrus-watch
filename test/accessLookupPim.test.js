// The access lookup's Entra role reads (held and eligible): when Graph refuses
// the batched call for anything but a missing licence or permission, each
// principal is read on its own; notes give the real reason (P2 only when Graph
// says so) without the request address. Graph is stubbed.
const { test, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const graphClient = require("../src/graphClient");
const log = require("../src/log");

const calls = [];
let answer = () => [];
// Before the tool is loaded: it takes the Graph helpers when required.
graphClient.graphGet = async (url) => { calls.push(["GET", url]); return answer("GET", url); };
graphClient.graphGetAll = async (url) => { calls.push(["ALL", url]); return answer("ALL", url); };

const { entraRoles, groupPim, pimReadNote, graphReason } = require("../src/tools/accessLookup")._test;

after(env.cleanup);
beforeEach(() => {
  calls.length = 0;
  answer = () => [];
});

const ROLE = "62e90394-69f5-4237-9190-012177145e10";
const U = "11111111-1111-4111-8111-111111111111";
const G = "22222222-2222-4222-8222-222222222222";
const fail = (status, code) => Object.assign(new Error(`Graph GET https://graph.microsoft.com/v1.0/x failed (${status}): {"error":{"code":"${code}"}}`), { status });

test("a batched eligibility call Graph refuses falls back to one call per principal, with role names looked up", async () => {
  answer = (kind, url) => {
    if (url.includes("roleEligibilityScheduleInstances") && url.includes("%20in%20")) throw fail(400, "BadRequest");
    if (url.includes("roleEligibilityScheduleInstances")) return url.includes(U) ? [{ principalId: U, roleDefinitionId: ROLE, directoryScopeId: "/", endDateTime: null }] : [];
    if (url.includes("/roleDefinitions/")) return { displayName: "Global Administrator", isBuiltIn: true };
    return [];
  };
  const out = await entraRoles([U, G]);
  assert.deepEqual(out.notes, []);
  assert.equal(out.eligible.length, 1);
  assert.equal(out.eligible[0].roleDefinition.displayName, "Global Administrator");
  assert.ok(calls.some(([, url]) => url.includes(encodeURIComponent(`principalId eq '${G}'`))));
});

test("no P2 and a 403 are said as such, and P2 is not blamed for other errors", async () => {
  answer = (kind, url) => { if (url.includes("roleEligibilityScheduleInstances")) throw fail(400, "AadPremiumLicenseRequired"); return []; };
  assert.match((await entraRoles([U])).notes[0], /needs Microsoft Entra ID P2/);
  answer = (kind, url) => { if (url.includes("roleEligibilityScheduleInstances")) throw fail(403, "Authorization_RequestDenied"); return []; };
  assert.match((await entraRoles([U])).notes[0], /needs RoleManagement.Read.Directory/);
  answer = (kind, url) => { if (url.includes("roleEligibilityScheduleInstances")) throw fail(500, "UnknownError"); return []; };
  calls.length = 0;
  const note = (await entraRoles([U, G])).notes[0];
  assert.doesNotMatch(note, /P2/);
  assert.match(note, /\(500\)/);
  // Only a 400 (Graph refusing the shape) falls back; an outage would fail each call too.
  assert.equal(calls.filter(([, url]) => url.includes("roleEligibilityScheduleInstances")).length, 1);
  answer = (kind, url) => { if (url.includes("roleEligibilityScheduleInstances")) throw fail(403, "Forbidden: tenant is not licensed for this feature"); return []; };
  assert.match((await entraRoles([U])).notes[0], /Entra ID P2/);
});

test("PIM for Groups notes: P2 only when Graph says so", async () => {
  answer = () => { throw fail(400, "BadRequest"); };
  const out = await groupPim(U);
  assert.doesNotMatch(out.notes[0], /P2/);
  assert.match(pimReadNote("X", fail(403, "Authorization_RequestDenied"), "Perm.Read"), /needs Perm\.Read/);
  assert.match(pimReadNote("X", fail(400, "RequestFromNonPremiumTenant"), "Perm.Read"), /Entra ID P2/);
});

// A batched read as the tool sends it: fifteen ids in the filter make the address longer than any note.
const LONG = `https://graph.microsoft.com/v1.0/roleManagement/directory/roleAssignments?$filter=${encodeURIComponent(`principalId in (${Array(15).fill(`'${U}'`).join(",")})`)}&$select=principalId,directoryScopeId,roleDefinitionId&$expand=roleDefinition($select=displayName,isBuiltIn,templateId)`;
const failAt = (url, status, code, text = "") => Object.assign(new Error(`Graph GET ${url} failed (${status}): {"error":{"code":"${code}","message":"${text}"}} client-request-id abc`), { status });

test("a batched read of held Entra roles Graph refuses falls back to one call per principal, and the eligible read still runs", async () => {
  answer = (kind, url) => {
    if (url.includes("%20in%20")) throw failAt(LONG, 400, "BadRequest", "Invalid filter clause");
    if (url.includes("/roleAssignments?")) return url.includes(U) ? [{ principalId: U, roleDefinitionId: ROLE, directoryScopeId: "/" }] : [];
    if (url.includes("roleEligibilityScheduleInstances")) return url.includes(G) ? [{ principalId: G, roleDefinitionId: ROLE, directoryScopeId: "/", endDateTime: null }] : [];
    if (url.includes("/roleDefinitions/")) return { displayName: "Global Administrator", isBuiltIn: true };
    return [];
  };
  const out = await entraRoles([U, G]);
  assert.deepEqual(out.notes, []);
  assert.equal(out.active.length, 1);
  assert.equal(out.active[0].roleDefinition.displayName, "Global Administrator");
  assert.equal(out.eligible.length, 1);
  assert.equal(out.eligible[0].roleDefinition.displayName, "Global Administrator");
  // Each principal read on its own, for both lists; the role definition looked up once for both.
  assert.ok(calls.some(([, url]) => url.includes("/roleAssignments?") && url.includes(encodeURIComponent(`principalId eq '${G}'`))));
  assert.ok(calls.some(([, url]) => url.includes("roleEligibilityScheduleInstances") && url.includes(encodeURIComponent(`principalId eq '${U}'`))));
  assert.equal(calls.filter(([, url]) => url.includes("/roleDefinitions/")).length, 1);
});

test("a failed read of held Entra roles says Graph's status and message without the request address, and logs the whole error", async () => {
  assert.equal(graphReason(failAt(LONG, 400, "BadRequest", "x")), 'Graph GET failed (400): {"error":{"code":"BadRequest","message":"x"}} client-request-id abc');
  answer = (kind, url) => { if (url.includes("/roleAssignments?")) throw failAt(LONG, 500, "UnknownError", "Service unavailable"); return []; };
  const out = await entraRoles([U, G]);
  assert.equal(out.notes.length, 1);
  assert.doesNotMatch(out.notes[0], /https:/);
  assert.match(out.notes[0], /\(500\).*UnknownError.*Service unavailable/);
  assert.equal(calls.filter(([, url]) => url.includes("/roleAssignments?")).length, 1); // a 500 does not fall back
  assert.equal(calls.filter(([, url]) => url.includes("roleEligibilityScheduleInstances")).length, 0); // nothing more is read
  const logged = log.readAll({ tool: "access-lookup" }).find((e) => e.level === "error" && e.message.includes(LONG));
  assert.ok(logged, "the full error, address included, is in the run log");
  answer = (kind, url) => { if (url.includes("/roleAssignments?")) throw failAt(LONG, 403, "Authorization_RequestDenied"); return []; };
  assert.match((await entraRoles([U])).notes[0], /needs RoleManagement.Read.Directory/);
});
