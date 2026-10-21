// Resolves which identity a tool authenticates as. A tool uses its own
// least-privilege identity when <TOOL_ID>_AZURE_CLIENT_ID is set (Settings tab
// or .env); otherwise the shared AZURE_* one. Each identity is a client secret
// SPN, a managed identity (App Service, no secret at all) or an app
// registration with a federated credential that trusts a user-assigned managed
// identity (no secret either, and it can reach other tenants).
// A tool's own identity is all-or-nothing, never mixed with the shared one.
//
// While a scan runs for a customer tenant (tenantContext), every tool uses that
// tenant's identity instead; history storage always stays on the home one.
const crypto = require("crypto");
const { ClientSecretCredential, ClientAssertionCredential, ManagedIdentityCredential } = require("@azure/identity");
const settings = require("./settings");
const tenantContext = require("./tenantContext");

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
        (source === "tool" ? ", or clear the tool's client ID to use the shared identity" : "")
    );
  }
  return { source, authType: "secret", tenantId, clientId: id.clientId, clientSecret: id.clientSecret };
}

// A customer tenant's identity (its own app registration, signed in to with
// the web app's managed identity), in the same shape as resolveSpn.
function resolveTenantSpn(tenant) {
  if (!tenant.clientId) {
    throw new Error(`customer tenant "${tenant.name}" has no app (client) ID yet: set it in Terraform's customers or in Settings, Customer tenants`);
  }
  if (!tenant.miClientId) {
    throw new Error(`customer tenant "${tenant.name}" cannot be scanned: TENANT_FEDERATED_MI_CLIENT_ID is empty (Terraform sets it when customers has an entry)`);
  }
  return { source: `tenant:${tenant.key}`, authType: "federated", tenantId: tenant.tenantId, clientId: tenant.clientId, miClientId: tenant.miClientId };
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
// whether it can get an ARM token. Never returns a secret.
async function testSpn(toolId) {
  let spn;
  try {
    spn = resolveSpn(toolId);
    const scope = toolId === STORAGE_TOOL_ID ? "https://storage.azure.com/.default" : "https://management.azure.com/.default";
    await build(spn).getToken(scope);
    return { ok: true, ...describe(spn) };
  } catch (err) {
    return { ok: false, ...(spn ? describe(spn) : { source: null, authType: null, clientId: null }), error: errorText(err) };
  }
}

// For a customer tenant's Test button: an ARM token and a Graph token.
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
    return { ok: true, ...describe(spn), graph };
  } catch (err) {
    return { ok: false, ...(spn ? describe(spn) : { source: null, authType: "federated", clientId: tenant.clientId || null }), error: errorText(err) };
  }
}

module.exports = { getCredential, testSpn, testTenant };
