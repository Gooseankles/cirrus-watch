// ARM, Log Analytics and Graph request details: which answers are tried again
// and how long to wait (Retry-After as seconds or a date, jitter that is never
// 0, the 15-minute budget), the client request id on every call and in error text,
// the Logs Query API v1 address and token scope, and the Resource Graph body.
// Against a local server or a stubbed axios; no Azure.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const env = require("./_env");
process.env.AZURE_REQUEST_TIMEOUT_SECONDS = "2";
// Before the clients are loaded: they take getCredential when required.
const scopes = [];
require("../src/credentials").getCredential = () => ({ getToken: async (scope) => (scopes.push(scope), { token: "test-token" }) });
const axios = require("axios");
const arm = require("../src/armClient");
const { graphGet, graphPost, shouldRetry } = require("../src/graphClient");

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
let server;
let base;
let seen = [];
before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader("Content-Type", "application/json");
    if (req.url.includes("notfound")) {
      res.statusCode = 404;
      if (req.url.includes("arm")) res.setHeader("x-ms-request-id", "server-arm-id");
      else res.setHeader("request-id", "server-graph-id");
      return res.end(JSON.stringify({ error: { code: "NotFound" } }));
    }
    if (req.url.includes("flaky") && seen.filter((s) => s.url === req.url).length === 1) {
      res.statusCode = 500;
      return res.end("{}");
    }
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  env.cleanup();
});

test("retry statuses: 429, 500, 502, 503 and 504 only", () => {
  for (const s of [429, 500, 502, 503, 504]) assert.equal(arm.isRetryStatus(s), true, String(s));
  for (const s of [200, 400, 401, 403, 404, 409, 501]) assert.equal(arm.isRetryStatus(s), false, String(s));
});

test("Graph: a read is tried again on all five, a POST only on 429, 503 and 504", () => {
  for (const s of [429, 500, 502, 503, 504]) assert.equal(shouldRetry("get", s), true, `get ${s}`);
  for (const s of [429, 503, 504]) assert.equal(shouldRetry("post", s), true, `post ${s}`);
  for (const s of [500, 502, 403]) assert.equal(shouldRetry("post", s), false, `post ${s}`);
});

test("Retry-After: seconds, an HTTP date, and the Cost Management QPU header", () => {
  const now = Date.parse("2026-10-31T12:00:00Z");
  assert.equal(arm.retryAfterMs({ "retry-after": "7" }, now), 7000);
  assert.equal(arm.retryAfterMs({ "Retry-After": "Sat, 31 Oct 2026 12:02:00 GMT" }, now), 120000);
  assert.equal(arm.retryAfterMs({ "retry-after": "Sat, 31 Oct 2026 11:00:00 GMT" }, now), 0); // in the past
  assert.equal(arm.retryAfterMs({ "x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after": "300", "retry-after": "5" }, now), 300000);
  assert.equal(arm.retryAfterMs({ "retry-after": "soon" }, now), 0);
  assert.equal(arm.retryAfterMs({}, now), 0);
});

test("backoff without Retry-After: between half and all of 2^attempt s, never 0, at most 60 s", () => {
  const now = Date.now();
  assert.equal(arm.retryWaitMs({}, 3, now, { now, random: () => 0.5 }), 6000); // 4 s + half of 4 s
  assert.equal(arm.retryWaitMs({}, 3, now, { now, random: () => 0 }), 4000);
  assert.equal(arm.retryWaitMs({}, 0, now, { now, random: () => 0 }), 500); // a 429 is never repeated at once
  assert.equal(arm.retryWaitMs({}, 6, now, { now, random: () => 0.999 }), null); // out of tries
  assert.equal(arm.retryDelayMs({}, 10, { random: () => 1 }), 60000);
  assert.equal(arm.retryDelayMs({}, 10, { random: () => 0 }), 30000);
  for (let attempt = 0; attempt < 6; attempt++) assert.ok(arm.retryDelayMs({}, attempt, { random: () => 0 }) >= 500, `attempt ${attempt}`);
});

test("a long Retry-After is honoured within the 15-minute budget, then the request gives up", () => {
  const now = Date.now();
  const tenMin = { headers: { "retry-after": "600" } };
  assert.equal(arm.retryWaitMs(tenMin, 0, now, { now }), 600000);
  assert.equal(arm.retryWaitMs(tenMin, 1, now - 6 * 60000, { now }), null); // 6 min gone + 10 min > 15
  assert.equal(arm.retryWaitMs({ headers: { "retry-after": "1000" } }, 0, now, { now }), null);
  assert.equal(arm.RETRY_BUDGET_MS, 15 * 60 * 1000);
  // Storage keeps its 60 s cap per wait.
  assert.equal(arm.retryDelayMs(tenMin, 0), 60000);
});

test("ARM: a GUID in x-ms-client-request-id, the same on a retried 500", async () => {
  seen = [];
  const data = await arm.armGet(`${base}/arm-flaky`);
  assert.equal(data.ok, true);
  assert.equal(seen.length, 2);
  assert.match(seen[0].headers["x-ms-client-request-id"], GUID);
  assert.equal(seen[1].headers["x-ms-client-request-id"], seen[0].headers["x-ms-client-request-id"]);
});

test("Graph: a GUID in client-request-id; both ids end the error text, after the reason", async () => {
  seen = [];
  await graphGet(`${base}/graph-ok`);
  assert.match(seen[0].headers["client-request-id"], GUID);

  seen = [];
  const err = await graphPost(`${base}/graph-notfound`, {}).catch((e) => e);
  const id = seen[0].headers["client-request-id"];
  assert.match(err.message, /failed \(404\): \{"error":\{"code":"NotFound"\}\} \[client-request-id [0-9a-f-]{36}; request-id server-graph-id\]$/);
  assert.ok(err.message.includes(id));
});

test("ARM: the reason first, the client and server request ids last, the status still readable", async () => {
  seen = [];
  const err = await arm.armGet(`${base}/arm-notfound`).catch((e) => e);
  assert.ok(err.message.includes(`client-request-id ${seen[0].headers["x-ms-client-request-id"]}`));
  assert.ok(err.message.includes("request-id server-arm-id"));
  assert.match(err.message, /\(404\)/);
  assert.match(err.message, /"code":"NotFound"/);
  // The ids are long; the reason must come first so a message clipped to 300 characters still shows it.
  assert.ok(err.message.indexOf("NotFound") < err.message.indexOf("[client-request-id"));
  assert.match(err.message, /\]$/);
});

// Stubs axios.request for the calls whose address is fixed (Azure hosts).
async function withAxios(answer, fn) {
  const real = axios.request;
  const calls = [];
  axios.request = async (cfg) => (calls.push(cfg), answer(cfg));
  try {
    await fn(calls);
  } finally {
    axios.request = real;
  }
}

test("Log Analytics: POST to the Logs Query API v1 with the api.loganalytics.io scope", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  assert.equal(arm.logAnalyticsUrl(id), `https://api.loganalytics.azure.com/v1/workspaces/${id}/query`);
  assert.equal(arm.LOG_ANALYTICS_SCOPE, "https://api.loganalytics.io/.default");
  const tables = [{ name: "PrimaryResult", columns: [{ name: "rid" }, { name: "last" }], rows: [["/x", "2026-10-31T00:00:00Z"]] }];
  await withAxios(() => ({ status: 200, headers: {}, data: { tables } }), async (calls) => {
    scopes.length = 0;
    const data = await arm.logAnalyticsQuery(id, { query: "Heartbeat" });
    assert.deepEqual(data.tables, tables);
    assert.equal(calls[0].method, "post");
    assert.equal(calls[0].url, `https://api.loganalytics.azure.com/v1/workspaces/${id}/query`);
    assert.deepEqual(calls[0].data, { query: "Heartbeat" });
    assert.match(calls[0].headers["x-ms-client-request-id"], GUID);
    assert.deepEqual(scopes, ["https://api.loganalytics.io/.default"]);
  });
  await assert.rejects(arm.logAnalyticsQuery("", { query: "x" }), /customerId/);
});

test("Resource Graph: resultFormat objectArray in the body, kept beside $skipToken", async () => {
  let page = 0;
  await withAxios(() => ({ status: 200, headers: {}, data: page++ === 0 ? { data: [{ a: 1 }], $skipToken: "next" } : { data: [{ a: 2 }] } }), async (calls) => {
    const rows = await arm.resourceGraphQuery("Resources", { subscriptions: ["s1"] });
    assert.deepEqual(rows, [{ a: 1 }, { a: 2 }]);
    assert.deepEqual(calls[0].data.options, { resultFormat: "objectArray", $top: 1000 });
    assert.deepEqual(calls[1].data.options, { resultFormat: "objectArray", $top: 1000, $skipToken: "next" });
    assert.deepEqual(calls[0].data.subscriptions, ["s1"]);
  });
});
