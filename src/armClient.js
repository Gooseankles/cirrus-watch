// Shared Azure Resource Manager request helpers used by every tool. Each
// call takes an optional toolId so it authenticates as that tool's own SPN
// (see credentials.js) instead of always using the shared one.
const crypto = require("crypto");
const axios = require("axios");
const { getCredential } = require("./credentials");
const settings = require("./settings");
const tenantContext = require("./tenantContext");

const ARM_SCOPE = "https://management.azure.com/.default";
const RESOURCE_GRAPH_API_VERSION = "2021-03-01";
// Log Analytics queries go to the Logs Query API v1 (the ARM route
// .../api/query?api-version=2017-01-01-preview is retired), with its own token.
const LOG_ANALYTICS_SCOPE = "https://api.loganalytics.io/.default";
const LOG_ANALYTICS_ROOT = "https://api.loganalytics.azure.com/v1";

async function getArmToken(toolId) {
  const token = await getCredential(toolId).getToken(ARM_SCOPE);
  return token.token;
}

const MAX_RETRIES = 6;
// Answers worth another try: throttled (429) and short server-side outages.
const RETRY_STATUSES = [429, 500, 502, 503, 504];
// One request (all its tries and waits) gives up after this long, so a long
// Retry-After (Cost Management asks for minutes) is waited out, not a scan forever.
const RETRY_BUDGET_MS = 15 * 60 * 1000;
// Without a Retry-After the wait is random between half and all of 2^attempt s (jitter), at most this.
const BACKOFF_CAP_MS = 60 * 1000;

// A request that hangs must not hold a scan forever: it gives up after
// AZURE_REQUEST_TIMEOUT_SECONDS (default 60) and is tried again like a 503.
function requestTimeoutMs() {
  return (Number(process.env.AZURE_REQUEST_TIMEOUT_SECONDS) || 60) * 1000;
}
const timeoutTries = (attempt) => `${attempt + 1} ${attempt ? "tries" : "try"} of ${requestTimeoutMs() / 1000} s each`;
const isTimeout = (err) => Boolean(err) && (err.code === "ECONNABORTED" || err.code === "ETIMEDOUT");

// How long the service asked us to wait, in ms (0 = it did not say). ARM and
// Cost Management send Retry-After or x-ms-ratelimit-*-retry-after (for example
// x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after), as seconds or an HTTP date.
function retryAfterMs(headers, now = Date.now()) {
  let ms = 0;
  for (const [name, value] of Object.entries(headers || {})) {
    if (!name.toLowerCase().endsWith("retry-after") || value === undefined || value === null) continue;
    const text = String(value).trim();
    const wait = /^\d+(\.\d+)?$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
    if (Number.isFinite(wait) && wait > ms) ms = wait;
  }
  return ms;
}

// The wait before the next try: what the service asked for, else exponential
// backoff with jitter (half to all of the step, so a 429 is never repeated at
// once); never more than maxMs. Storage (findingsStore.js) uses the default
// 60 s cap; ARM and Graph use retryWaitMs below.
function retryDelayMs(response, attempt, { maxMs = BACKOFF_CAP_MS, now = Date.now(), random = Math.random } = {}) {
  const asked = retryAfterMs(response && response.headers, now);
  const step = Math.min(BACKOFF_CAP_MS, 2 ** attempt * 1000);
  const ms = asked > 0 ? asked : step / 2 + random() * (step / 2);
  return Math.min(ms, maxMs);
}

// ARM, Log Analytics and Graph: the wait before another try, or null to give
// up (out of tries, or the wait would take the request past RETRY_BUDGET_MS).
// A Retry-After longer than 60 s is honoured as long as it fits the budget.
function retryWaitMs(response, attempt, startedAt, { now = Date.now(), random = Math.random } = {}) {
  if (attempt >= MAX_RETRIES) return null;
  const ms = retryDelayMs(response, attempt, { maxMs: Infinity, now, random });
  return now - startedAt + ms > RETRY_BUDGET_MS ? null : ms;
}
const isRetryStatus = (status) => RETRY_STATUSES.includes(status);

// "[client-request-id x; request-id y]" at the end of error text, so a failed
// call can be traced in Microsoft's logs (both ids go to Microsoft support).
// Last, not first: the reason must survive the 300-character clips (tools/util.js).
function requestIds(clientRequestId, response) {
  const h = (response && response.headers) || {};
  const serverId = h["x-ms-request-id"] || h["request-id"];
  return `[client-request-id ${clientRequestId}${serverId ? `; request-id ${serverId}` : ""}]`;
}

// One request to ARM or the Logs Query API, with a fresh GUID per request
// (the same on every try) in x-ms-client-request-id.
async function azureRequest(method, url, data, toolId, { scope = ARM_SCOPE, label = "ARM request" } = {}) {
  const clientRequestId = crypto.randomUUID();
  const startedAt = Date.now();
  let response;
  for (let attempt = 0; ; attempt++) {
    const token = (await getCredential(toolId).getToken(scope)).token;
    try {
      response = await axios.request({
        method,
        url,
        data,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "x-ms-client-request-id": clientRequestId,
        },
        timeout: requestTimeoutMs(),
        validateStatus: () => true,
      });
    } catch (err) {
      // Every ARM call here only reads or is safe to repeat (PUTs, queries sent as POST).
      if (!isTimeout(err)) throw err;
      const wait = retryWaitMs({}, attempt, startedAt);
      if (wait === null) throw new Error(`${label} timed out ${method} ${url} (${timeoutTries(attempt)}) ${requestIds(clientRequestId)}`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!isRetryStatus(response.status)) break;
    const wait = retryWaitMs(response, attempt, startedAt);
    if (wait === null) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  if (response.status >= 300) {
    const why = errorReason(response.data);
    throw new Error(`${label} failed ${method} ${url} (${response.status}): ${why ? `${why} | ` : ""}${JSON.stringify(response.data)} ${requestIds(clientRequestId, response)}`);
  }
  return response.data;
}

function armRequest(method, url, data, toolId) {
  return azureRequest(method, url, data, toolId);
}

// Azure's real reason sits in error.details (Resource Graph: InvalidQuery, ParserFailure with line and token) under a
// generic "Please provide below info when asking for support" message; put it first so a cut-off message still shows it.
function errorReason(data) {
  const details = data && data.error && Array.isArray(data.error.details) ? data.error.details : [];
  return details
    .map((d) => {
      const at = d.token !== undefined ? ` at "${d.token}"${d.line !== undefined ? ` (line ${d.line}, char ${d.characterPositionInLine})` : ""}` : "";
      const msg = d.message && d.message !== d.code && !/^Query is invalid\. Please refer/i.test(d.message) ? `: ${d.message}` : "";
      return `${d.code || "error"}${msg}${at}`;
    })
    .join("; ")
    .slice(0, 400);
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

// Runs a query against one Log Analytics workspace through the Logs Query API
// v1. customerId is the workspace ID (properties.customerId, a GUID), not its
// ARM resource ID. Same identity choice (tool SPN, customer tenant), timeout and
// retries as ARM; the answer is { tables: [{ columns, rows }] } as before.
function logAnalyticsUrl(customerId) {
  return `${LOG_ANALYTICS_ROOT}/workspaces/${encodeURIComponent(customerId)}/query`;
}
function logAnalyticsQuery(customerId, body, toolId) {
  if (!customerId) return Promise.reject(new Error("Log Analytics query needs the workspace ID (customerId)"));
  return azureRequest("post", logAnalyticsUrl(customerId), body, toolId, { scope: LOG_ANALYTICS_SCOPE, label: "Log Analytics query" });
}

// The subscriptions configured for the tenant being scanned (a customer
// tenant's own list, or AZURE_SUBSCRIPTION_IDS at home); empty = all.
function configuredSubscriptionIds() {
  const tenant = tenantContext.current();
  if (!tenantContext.isHome(tenant)) return [...(tenant.subscriptionIds || [])];
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
      // objectArray is the REST default; set so rows stay objects (r.subscriptionId) whatever the default becomes.
      options: { resultFormat: "objectArray", $top: 1000, ...(skipToken && { $skipToken: skipToken }) },
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
const subNameCache = new Map(); // tenant|toolId -> { at, names }

async function subscriptionNames(toolId) {
  const tenant = tenantContext.current();
  const key = `${tenantContext.isHome(tenant) ? tenantContext.HOME : tenant.key}|${toolId || ""}`;
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

// A removed customer's cached names go with it. Returns how many entries went.
function forgetTenant(tenantKey) {
  let n = 0;
  for (const k of [...subNameCache.keys()]) {
    if (k.startsWith(`${tenantKey}|`)) n += Number(subNameCache.delete(k));
  }
  return n;
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
  retryDelayMs,
  retryAfterMs,
  retryWaitMs,
  isRetryStatus,
  requestIds,
  RETRY_BUDGET_MS,
  MAX_RETRIES,
  LOG_ANALYTICS_SCOPE,
  logAnalyticsUrl,
  logAnalyticsQuery,
  requestTimeoutMs,
  isTimeout,
  timeoutTries,
  subscriptionNames,
  subscriptionLabel,
  forgetTenant,
  getArmToken,
  armGet,
  armPut,
  armPost,
  resourceGraphQuery,
  configuredSubscriptionIds,
  subscriptionIdsToScan,
};
