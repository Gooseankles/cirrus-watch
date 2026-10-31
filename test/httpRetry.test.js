// ARM, Graph and blob requests that hang give up after
// AZURE_REQUEST_TIMEOUT_SECONDS and are tried again (Graph: GET only), and
// storage answers 429 and 5xx are tried again. Against a local server that
// does not answer the first request; no Azure.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

const env = require("./_env");
process.env.AZURE_REQUEST_TIMEOUT_SECONDS = "0.2";
// Before the clients are loaded: they take getCredential when required.
require("../src/credentials").getCredential = () => ({ getToken: async () => ({ token: "test-token" }) });
const { armGet } = require("../src/armClient");
const { graphGet, graphPost } = require("../src/graphClient");
const findingsStore = require("../src/findingsStore");

let server;
let base;
let hits = 0;
before(async () => {
  server = http.createServer((req, res) => {
    hits++;
    if (req.url.includes("hang") && (hits === 1 || req.url.includes("always"))) return; // never answers
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, url: req.url }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
  env.cleanup();
});

test("ARM: a request that times out is tried again", async () => {
  hits = 0;
  const data = await armGet(`${base}/hang-once`);
  assert.equal(data.ok, true);
  assert.equal(hits, 2);
});

test("Graph: a GET that times out is tried again", async () => {
  hits = 0;
  const data = await graphGet(`${base}/hang-once`);
  assert.equal(data.ok, true);
  assert.equal(hits, 2);
});

test("Graph: a POST that times out is not sent again", async () => {
  hits = 0;
  await assert.rejects(graphPost(`${base}/hang-always`, { a: 1 }), /timed out \(1 try of 0.2 s each\)/);
  assert.equal(hits, 1);
});

test("storage: 503 and a timeout are tried again, 404 is not", async () => {
  const answers = [{ status: 503, headers: {} }, Object.assign(new Error("timeout"), { code: "ECONNABORTED" }), { status: 200, headers: {} }];
  let n = 0;
  const resp = await findingsStore._test.withRetry(async () => {
    const a = answers[n++];
    if (a instanceof Error) throw a;
    return a;
  });
  assert.equal(resp.status, 200);
  assert.equal(n, 3);

  n = 0;
  const notFound = await findingsStore._test.withRetry(async () => (n++, { status: 404, headers: {} }));
  assert.equal(notFound.status, 404);
  assert.equal(n, 1);
});
