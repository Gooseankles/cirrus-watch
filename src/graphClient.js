// Microsoft Graph helper, for anything ARM can't see (Azure AD users,
// groups, app registrations, entitlement management). Each call takes an
// optional toolId so it authenticates as that tool's own SPN (credentials.js).
// Whichever SPN is used needs Graph API Application permissions with admin
// consent — see docs/permissions.md for which ones each tool needs.
const crypto = require("crypto");
const axios = require("axios");
const { getCredential } = require("./credentials");
// The same request timeout, retry waits and budget as ARM (armClient.js).
const { requestTimeoutMs, isTimeout, timeoutTries, retryWaitMs, isRetryStatus, requestIds } = require("./armClient");

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

async function getGraphToken(toolId) {
  const token = await getCredential(toolId).getToken(GRAPH_SCOPE);
  return token.token;
}

// Graph throttles (429) and has short outages (500, 502, 503, 504) when a scan
// reads thousands of users or groups. A read is tried again on any of them. A
// POST only on 429, 503 and 504 as before: a 500 or 502 may come after it did
// its work (sendMail).
const POST_RETRY_STATUSES = [429, 503, 504];
function shouldRetry(method, status) {
  return method === "get" ? isRetryStatus(status) : POST_RETRY_STATUSES.includes(status);
}

async function graphRequest(method, path, body, toolId) {
  const url = path.startsWith("http") ? path : `${GRAPH_ROOT}${path}`;
  // One GUID per request (the same on every try), as Microsoft asks; it and
  // Graph's request-id go into the error text.
  const clientRequestId = crypto.randomUUID();
  const startedAt = Date.now();
  let response;
  for (let attempt = 0; ; attempt++) {
    const token = await getGraphToken(toolId);
    try {
      response = await axios.request({
        method,
        url,
        data: body,
        headers: { Authorization: `Bearer ${token}`, "client-request-id": clientRequestId },
        timeout: requestTimeoutMs(),
        validateStatus: () => true,
      });
    } catch (err) {
      // A timed-out GET is tried again like a 503. A POST is not: it may have
      // done its work (sendMail) before the answer was lost.
      if (!isTimeout(err)) throw err;
      const wait = method === "get" ? retryWaitMs({}, attempt, startedAt) : null;
      if (wait === null) throw new Error(`Graph ${method.toUpperCase()} ${url} timed out (${timeoutTries(attempt)}) ${requestIds(clientRequestId)}`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!shouldRetry(method, response.status)) break;
    const wait = retryWaitMs(response, attempt, startedAt);
    if (wait === null) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  if (response.status >= 300) {
    throw new Error(`Graph ${method.toUpperCase()} ${url} failed (${response.status}): ${JSON.stringify(response.data)} ${requestIds(clientRequestId, response)}`);
  }
  return response.data;
}

function graphGet(path, toolId) {
  return graphRequest("get", path, undefined, toolId);
}

function graphPost(path, body, toolId) {
  return graphRequest("post", path, body, toolId);
}

// Follows @odata.nextLink until exhausted; Graph pages most list endpoints.
async function graphGetAll(path, toolId) {
  let results = [];
  let next = path;
  while (next) {
    const page = await graphGet(next, toolId);
    results = results.concat(page.value || []);
    next = page["@odata.nextLink"] || null;
  }
  return results;
}

module.exports = { getGraphToken, graphGet, graphGetAll, graphPost, shouldRetry };
