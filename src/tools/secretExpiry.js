const axios = require("axios");
const { graphGetAll } = require("../graphClient");
const { resourceGraphQuery } = require("../armClient");
const { getCredential } = require("../credentials");
const settings = require("../settings");

const TOOL_ID = "secret-expiry";

function warnDays() {
  return Number(settings.get("SECRET_EXPIRY_WARN_DAYS")) || 30;
}

function withinWarnWindow(endDateTime) {
  if (!endDateTime) return false;
  const msLeft = new Date(endDateTime).getTime() - Date.now();
  return msLeft <= warnDays() * 24 * 60 * 60 * 1000;
}

async function appRegistrationFindings() {
  const apps = await graphGetAll(
    "/applications?$select=id,appId,displayName,passwordCredentials,keyCredentials&$top=999",
    TOOL_ID
  );
  const findings = [];
  for (const app of apps) {
    const creds = [...(app.passwordCredentials || []), ...(app.keyCredentials || [])];
    for (const c of creds) {
      if (!withinWarnWindow(c.endDateTime)) continue;
      findings.push({
        kind: "app-credential-expiring",
        id: `${app.id}/${c.keyId}`,
        name: app.displayName,
        resourceGroup: null,
        subscriptionId: null,
        detail: `credential "${c.displayName || c.keyId}" expires ${c.endDateTime}`,
      });
    }
  }
  return findings;
}

async function getVaultToken() {
  const token = await getCredential(TOOL_ID).getToken("https://vault.azure.net/.default");
  return token.token;
}

// Caps are a v1 safeguard against a very large tenant making this scan take
// forever; raise them (or add paging) once this is proven useful.
const MAX_VAULTS = 25;
const MAX_CERTS_PER_VAULT = 25;

async function keyVaultCertFindings() {
  const vaults = await resourceGraphQuery(
    `
    Resources
    | where type == 'microsoft.keyvault/vaults'
    | project name, subscriptionId, resourceGroup, vaultUri = properties.vaultUri
    | limit ${MAX_VAULTS}
  `,
    { toolId: TOOL_ID }
  );

  const token = await getVaultToken();
  const findings = [];

  for (const vault of vaults) {
    if (!vault.vaultUri) continue;
    const listUrl = `${vault.vaultUri}certificates?api-version=7.4&maxresults=${MAX_CERTS_PER_VAULT}`;
    const listResp = await axios.get(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
    if (listResp.status >= 300) {
      // Likely the service principal lacks a Key Vault access policy / RBAC
      // role on this vault — skip it rather than fail the whole scan.
      continue;
    }
    for (const certRef of listResp.data.value || []) {
      const certResp = await axios.get(`${certRef.id}?api-version=7.4`, {
        headers: { Authorization: `Bearer ${token}` },
        validateStatus: () => true,
      });
      if (certResp.status >= 300) continue;
      const expires = certResp.data.attributes && certResp.data.attributes.expires;
      const expiresIso = expires ? new Date(expires * 1000).toISOString() : null;
      if (!withinWarnWindow(expiresIso)) continue;
      findings.push({
        kind: "keyvault-cert-expiring",
        id: certRef.id,
        name: `${vault.name}/${certRef.id.split("/").pop()}`,
        resourceGroup: vault.resourceGroup,
        subscriptionId: vault.subscriptionId,
        detail: `certificate expires ${expiresIso}`,
      });
    }
  }
  return findings;
}

async function run() {
  const results = await Promise.allSettled([appRegistrationFindings(), keyVaultCertFindings()]);
  const findings = [];
  for (const r of results) {
    if (r.status === "fulfilled") findings.push(...r.value);
  }
  if (results.every((r) => r.status === "rejected")) {
    throw results[0].reason;
  }
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Expiring secrets/certs",
  schedule: "0 6 * * *", // nightly at 06:00
  run,
};
