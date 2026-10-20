// Resolves which identity a tool authenticates as. A tool uses its own
// least-privilege identity when <TOOL_ID>_AZURE_CLIENT_ID is set (Settings tab
// or .env); otherwise the shared AZURE_* one. Each identity is either a
// client secret SPN or a managed identity (App Service, no secret at all).
// A tool's own identity is all-or-nothing, never mixed with the shared one.
const crypto = require("crypto");
const { ClientSecretCredential, ManagedIdentityCredential } = require("@azure/identity");
const settings = require("./settings");

const cache = new Map();

function readIdentity(p) {
  return {
    authType: settings.get(`${p}AZURE_AUTH_TYPE`) || "secret",
    tenantId: settings.get(`${p}AZURE_TENANT_ID`),
    clientId: settings.get(`${p}AZURE_CLIENT_ID`),
    clientSecret: settings.get(`${p}AZURE_CLIENT_SECRET`),
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

function getCredential(toolId) {
  const spn = resolveSpn(toolId);
  let cacheKey;
  if (spn.authType === "managed-identity") {
    cacheKey = `mi|${spn.clientId || "system"}`;
  } else {
    // The secret's hash is part of the key so a secret rotated in Settings
    // takes effect at once instead of reusing the old cached credential.
    const secretHash = crypto.createHash("sha256").update(spn.clientSecret).digest("hex");
    cacheKey = `secret|${spn.tenantId}|${spn.clientId}|${secretHash}`;
  }
  if (!cache.has(cacheKey)) {
    cache.set(
      cacheKey,
      spn.authType === "managed-identity"
        ? new ManagedIdentityCredential(spn.clientId ? { clientId: spn.clientId } : undefined)
        : new ClientSecretCredential(spn.tenantId, spn.clientId, spn.clientSecret)
    );
  }
  return cache.get(cacheKey);
}

// For the Settings tab's Test button: which identity a tool resolves to, and
// whether it can get an ARM token. Never returns a secret.
async function testSpn(toolId) {
  let spn;
  try {
    spn = resolveSpn(toolId);
    const scope = toolId === "history-storage" ? "https://storage.azure.com/.default" : "https://management.azure.com/.default";
    await getCredential(toolId).getToken(scope);
    return { ok: true, source: spn.source, authType: spn.authType, clientId: spn.clientId };
  } catch (err) {
    return {
      ok: false,
      source: spn ? spn.source : null,
      authType: spn ? spn.authType : null,
      clientId: spn ? spn.clientId : null,
      error: String(err.message || err).split("\n")[0].slice(0, 300),
    };
  }
}

module.exports = { getCredential, testSpn };
