// Microsoft Graph helper, for anything ARM can't see (Azure AD users,
// groups, app registrations, entitlement management). Each call takes an
// optional toolId so it authenticates as that tool's own SPN (credentials.js).
// Whichever SPN is used needs Graph API Application permissions with admin
// consent — see README for which ones each tool needs.
const axios = require("axios");
const { getCredential } = require("./credentials");

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const GRAPH_ROOT = "https://graph.microsoft.com/v1.0";

async function getGraphToken(toolId) {
  const token = await getCredential(toolId).getToken(GRAPH_SCOPE);
  return token.token;
}

const MAX_RETRIES = 6;

// Graph throttles (429) and has short outages (503, 504) when a scan reads
// thousands of users or groups; it says how long to wait in Retry-After.
function retryDelayMs(response, attempt) {
  const seconds = Number((response.headers || {})["retry-after"]) || 2 ** attempt;
  return Math.min(seconds, 60) * 1000;
}

async function graphRequest(method, path, body, toolId) {
  const url = path.startsWith("http") ? path : `${GRAPH_ROOT}${path}`;
  let response;
  for (let attempt = 0; ; attempt++) {
    const token = await getGraphToken(toolId);
    response = await axios.request({
      method,
      url,
      data: body,
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
    const retryable = [429, 503, 504].includes(response.status);
    if (!retryable || attempt >= MAX_RETRIES) break;
    await new Promise((r) => setTimeout(r, retryDelayMs(response, attempt)));
  }
  if (response.status >= 300) {
    throw new Error(`Graph ${method.toUpperCase()} ${url} failed (${response.status}): ${JSON.stringify(response.data)}`);
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

module.exports = { getGraphToken, graphGet, graphGetAll, graphPost };
