// Resolves which identity a tool authenticates as. A tool uses its own
// least-privilege identity when <TOOL_ID>_AZURE_CLIENT_ID is set (Settings tab
// or .env); otherwise the shared AZURE_* one. Each identity is a client secret
// SPN, a managed identity (App Service, no secret at all) or an app
// registration with a federated credential that trusts a user-assigned managed
// identity (no secret either, and it can reach other tenants).
// A tool's own identity is all-or-nothing, never mixed with the shared one.
//
// While a scan runs for a customer tenant (tenantContext), every tool uses that
// tenant's identity instead (its own app registration and client secret);
// history storage always stays on the home one.
const crypto = require("crypto");
const { ClientSecretCredential, ClientAssertionCredential, ManagedIdentityCredential } = require("@azure/identity");
const settings = require("./settings");
const secretStore = require("./secretStore");
const tenantContext = require("./tenantContext");
const permissionCheck = require("./permissionCheck");

const STORAGE_TOOL_ID = "history-storage";
const cache = new Map();

function readIdentity(p) {
  return {
    authType: settings.get(`${p}AZURE_AUTH_TYPE`) || "secret",
    tenantId: settings.get(`${p}AZURE_TENANT_ID`),
    clientId: settings.get(`${p}AZURE_CLIENT_ID`),
    clientSecret: settings.get(`${p}AZURE_CLIENT_SECRET`),
    miClientId: settings.get(`${p}AZURE_FEDERATED_MI_CLIENT_ID`),
  };
}

// A missing secret while the key vault cannot be read says so, instead of
// sending the admin to Settings for a secret that is there.
function vaultProblem() {
  if (secretStore.ready()) return "";
  const d = secretStore.describe();
  return ` (the key vault holding the secrets is not reachable: ${d.error || "still loading"})`;
}

function resolveSpn(toolId) {
  const p = settings.spnPrefix(toolId);
  const shared = readIdentity("");
  const own = p ? readIdentity(p) : null;
  const source = own && own.clientId ? "tool" : "shared";
  const id = source === "tool" ? own : shared;
  const where = source === "tool" ? `tool "${toolId}"` : `the shared identity (used by "${toolId || "default"}")`;

  if (id.authType === "managed-identity") {
    return { source, authType: id.authType, clientId: id.clientId || null };
  }

  const tenantId = id.tenantId || (source === "tool" ? shared.tenantId : undefined);
  if (id.authType === "federated") {
    const miClientId = id.miClientId || process.env.DASHBOARD_FEDERATED_MI_CLIENT_ID;
    const missing = [!id.clientId && "client ID", !tenantId && "tenant ID", !miClientId && "managed identity client ID"].filter(Boolean);
    if (missing.length) {
      throw new Error(`${where} is set to federated auth but has no ${missing.join(", ")} — fill it in Settings (or .env)`);
    }
    return { source, authType: "federated", tenantId, clientId: id.clientId, miClientId };
  }

  if (!id.clientId || !id.clientSecret || !tenantId) {
    const missing = [!id.clientId && "client ID", !id.clientSecret && "client secret", !tenantId && "tenant ID"].filter(Boolean);
    throw new Error(
      `${where} is set to client secret auth but has no ${missing.join(", ")} — ` +
        `fill it in Settings (or .env), switch it to managed identity` +
        (source === "tool" ? ", or clear the tool's client ID to use the shared identity" : "") +
        (!id.clientSecret ? vaultProblem() : "")
    );
  }
  return { source, authType: "secret", tenantId, clientId: id.clientId, clientSecret: id.clientSecret };
}

// A customer tenant's identity (its own app registration and client secret),
// in the same shape as resolveSpn.
function resolveTenantSpn(tenant) {
  if (!tenant.clientId) {
    throw new Error(`customer tenant "${tenant.name}" has no app (client) ID yet: set it in Terraform's customers or in Settings, Customer tenants`);
  }
  if (!tenant.clientSecret) {
    throw new Error(`customer tenant "${tenant.name}" has no client secret yet: enter it in Settings, Customer tenants, Edit${vaultProblem()}`);
  }
  return { source: `tenant:${tenant.key}`, authType: "secret", tenantId: tenant.tenantId, clientId: tenant.clientId, clientSecret: tenant.clientSecret };
}

function federatedAssertion(miClientId) {
  const mi = new ManagedIdentityCredential({ clientId: miClientId });
  return async () => {
    try {
      return (await mi.getToken("api://AzureADTokenExchange/.default")).token;
    } catch (err) {
      throw new Error(
        `the user-assigned managed identity ${miClientId} gave no token for the federated credential ` +
          `(is it attached to this web app, and is that its client ID?): ${err.message}`
      );
    }
  };
}

function build(spn) {
  let cacheKey;
  if (spn.authType === "managed-identity") {
    cacheKey = `mi|${spn.clientId || "system"}`;
  } else if (spn.authType === "federated") {
    cacheKey = `fed|${spn.tenantId}|${spn.clientId}|${spn.miClientId}`;
  } else {
    // The secret's hash is part of the key so a secret rotated in Settings
    // takes effect at once instead of reusing the old cached credential.
    const secretHash = crypto.createHash("sha256").update(spn.clientSecret).digest("hex");
    cacheKey = `secret|${spn.tenantId}|${spn.clientId}|${secretHash}`;
  }
  if (!cache.has(cacheKey)) {
    let cred;
    if (spn.authType === "managed-identity") cred = new ManagedIdentityCredential(spn.clientId ? { clientId: spn.clientId } : undefined);
    else if (spn.authType === "federated") cred = new ClientAssertionCredential(spn.tenantId, spn.clientId, federatedAssertion(spn.miClientId));
    else cred = new ClientSecretCredential(spn.tenantId, spn.clientId, spn.clientSecret);
    cache.set(cacheKey, cred);
  }
  return cache.get(cacheKey);
}

// A removed customer's cached sign-in (its tenant and app) goes with it, so
// the secret is not held in memory any longer. Returns how many entries went.
function forget(tenantId, clientId) {
  let n = 0;
  const prefix = `secret|${tenantId}|${clientId}|`;
  for (const k of [...cache.keys()]) {
    if (k.startsWith(prefix)) n += Number(cache.delete(k));
  }
  return n;
}

function getCredential(toolId) {
  const tenant = tenantContext.current();
  if (toolId !== STORAGE_TOOL_ID && !tenantContext.isHome(tenant)) return build(resolveTenantSpn(tenant));
  return build(resolveSpn(toolId));
}

function describe(spn) {
  return { source: spn.source, authType: spn.authType, clientId: spn.clientId || null };
}

function errorText(err) {
  return String(err.message || err).split("\n")[0].slice(0, 300);
}

// For the Settings tab's Test button: which identity a tool resolves to, and
// whether it can get an ARM token, plus which permissions its tools need are
// missing (all tools for the shared identity). Never returns a secret.
async function testSpn(toolId) {
  let spn;
  try {
    spn = resolveSpn(toolId);
    const storage = toolId === STORAGE_TOOL_ID;
    const cred = build(spn);
    await cred.getToken(storage ? "https://storage.azure.com/.default" : "https://management.azure.com/.default");
    const configured = (settings.get("AZURE_SUBSCRIPTION_IDS") || "").split(",").map((x) => x.trim()).filter(Boolean);
    const permissions = storage ? null : await permissionCheck.check(cred, { toolIds: toolId ? [toolId] : [], configured });
    return { ok: true, ...describe(spn), permissions };
  } catch (err) {
    return { ok: false, ...(spn ? describe(spn) : { source: null, authType: null, clientId: null }), error: errorText(err) };
  }
}

// For a customer tenant's Test button: an ARM token, a Graph token and the
// permissions every tool needs there.
async function testTenant(tenant) {
  let spn;
  try {
    spn = resolveTenantSpn(tenant);
    const cred = build(spn);
    await cred.getToken("https://management.azure.com/.default");
    let graph = "ok";
    try {
      await cred.getToken("https://graph.microsoft.com/.default");
    } catch (err) {
      graph = errorText(err);
    }
    const permissions = await permissionCheck.check(cred, { configured: tenant.subscriptionIds });
    return { ok: true, ...describe(spn), graph, permissions };
  } catch (err) {
    return { ok: false, ...(spn ? describe(spn) : { source: null, authType: "secret", clientId: tenant.clientId || null }), error: errorText(err) };
  }
}

module.exports = { getCredential, forget, testSpn, testTenant };
