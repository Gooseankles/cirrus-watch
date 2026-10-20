// Shared Azure Resource Manager request helpers used by every tool. Each
// call takes an optional toolId so it authenticates as that tool's own SPN
// (see credentials.js) instead of always using the shared one.
const axios = require("axios");
const { getCredential } = require("./credentials");
const settings = require("./settings");

const ARM_SCOPE = "https://management.azure.com/.default";
const RESOURCE_GRAPH_API_VERSION = "2021-03-01";

async function getArmToken(toolId) {
  const token = await getCredential(toolId).getToken(ARM_SCOPE);
  return token.token;
}

const MAX_RETRIES = 6;

// ARM and Cost Management answer 429 (and sometimes 503) when a scan over
// hundreds of subscriptions goes too fast; they say how long to wait in a
// Retry-After or x-ms-ratelimit-*-retry-after header.
function retryDelayMs(response, attempt) {
  let seconds = 0;
  for (const [name, value] of Object.entries(response.headers || {})) {
    if (name.toLowerCase().endsWith("retry-after")) seconds = Math.max(seconds, Number(value) || 0);
  }
  if (!seconds) seconds = 2 ** attempt;
  return Math.min(seconds, 60) * 1000;
}

async function armRequest(method, url, data, toolId) {
  let response;
  for (let attempt = 0; ; attempt++) {
    const token = await getArmToken(toolId);
    response = await axios.request({
      method,
      url,
      data,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      validateStatus: () => true,
    });
    const retryable = response.status === 429 || response.status === 503;
    if (!retryable || attempt >= MAX_RETRIES) break;
    await new Promise((r) => setTimeout(r, retryDelayMs(response, attempt)));
  }
  if (response.status >= 300) {
    throw new Error(`ARM request failed ${method} ${url} (${response.status}): ${JSON.stringify(response.data)}`);
  }
  return response.data;
}

function armGet(url, toolId) {
  return armRequest("get", url, undefined, toolId);
}
function armPut(url, data, toolId) {
  return armRequest("put", url, data, toolId);
}
function armPost(url, data, toolId) {
  return armRequest("post", url, data, toolId);
}

function configuredSubscriptionIds() {
  return (settings.get("AZURE_SUBSCRIPTION_IDS") || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// Every enabled subscription the tool's identity can see (AZURE_SUBSCRIPTION_IDS
// wins when set), for tools that call per-subscription APIs.
async function subscriptionIdsToScan(toolId) {
  const configured = configuredSubscriptionIds();
  if (configured.length) return configured;
  const ids = [];
  let url = "https://management.azure.com/subscriptions?api-version=2022-12-01";
  while (url) {
    const page = await armGet(url, toolId);
    for (const s of page.value || []) {
      if (s.state === "Enabled") ids.push(s.subscriptionId);
    }
    url = page.nextLink;
  }
  return ids;
}

// Runs a Kusto-style query against Azure Resource Graph, scoped to
// AZURE_SUBSCRIPTION_IDS if set, otherwise every subscription the calling
// identity can see. Follows $skipToken, since one page holds at most 1000 rows.
async function resourceGraphQuery(query, { subscriptions, toolId } = {}) {
  const subs = subscriptions || configuredSubscriptionIds();
  const url = `https://management.azure.com/providers/Microsoft.ResourceGraph/resources?api-version=${RESOURCE_GRAPH_API_VERSION}`;
  const rows = [];
  let skipToken;
  do {
    const body = {
      query,
      ...(subs.length && { subscriptions: subs }),
      options: { $top: 1000, ...(skipToken && { $skipToken: skipToken }) },
    };
    const data = await armPost(url, body, toolId);
    rows.push(...(data.data || []));
    skipToken = data.$skipToken;
  } while (skipToken);
  return rows;
}

// Subscription ID -> display name, for every subscription the identity can
// see. Cached per identity for a while: pages ask for it on every load.
const SUB_NAME_TTL_MS = 15 * 60 * 1000;
const subNameCache = new Map(); // toolId -> { at, names }

async function subscriptionNames(toolId) {
  const key = toolId || "";
  const hit = subNameCache.get(key);
  if (hit && Date.now() - hit.at < SUB_NAME_TTL_MS) return hit.names;
  const rows = await resourceGraphQuery(
    `ResourceContainers | where type == 'microsoft.resources/subscriptions' | project subscriptionId, name`,
    { toolId, subscriptions: [] }
  );
  const names = new Map(rows.map((r) => [r.subscriptionId, r.name]));
  subNameCache.set(key, { at: Date.now(), names });
  return names;
}

// "Name (id)" when the name is known, else the id; never throws.
async function subscriptionLabel(subscriptionId, toolId) {
  try {
    const name = (await subscriptionNames(toolId)).get(subscriptionId);
    return name ? `${name} (${subscriptionId})` : subscriptionId;
  } catch {
    return subscriptionId;
  }
}

module.exports = {
  subscriptionNames,
  subscriptionLabel,
  getArmToken,
  armGet,
  armPut,
  armPost,
  resourceGraphQuery,
  configuredSubscriptionIds,
  subscriptionIdsToScan,
};
