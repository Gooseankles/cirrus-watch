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

async function graphGet(path, toolId) {
  const token = await getGraphToken(toolId);
  const url = path.startsWith("http") ? path : `${GRAPH_ROOT}${path}`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  if (response.status >= 300) {
    throw new Error(`Graph GET ${url} failed (${response.status}): ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

async function graphPost(path, body, toolId) {
  const token = await getGraphToken(toolId);
  const url = path.startsWith("http") ? path : `${GRAPH_ROOT}${path}`;
  const response = await axios.post(url, body, {
    headers: { Authorization: `Bearer ${token}` },
    validateStatus: () => true,
  });
  if (response.status >= 300) {
    throw new Error(`Graph POST ${url} failed (${response.status}): ${JSON.stringify(response.data)}`);
  }
  return response.data;
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
