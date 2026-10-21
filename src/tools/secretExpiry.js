// App registration secrets and certificates that expire soon. Key Vault items
// are checked by the Key Vault tool.
const { graphGetAll } = require("../graphClient");
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

async function run() {
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
        expires: c.endDateTime,
        detail: `credential "${c.displayName || c.keyId}" expires ${c.endDateTime}`,
      });
    }
  }
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Expiring app credentials",
  schedule: "0 6 * * *", // nightly at 06:00
  run,
};
