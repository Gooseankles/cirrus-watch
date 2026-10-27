// App registration secrets and certificates that expire soon, and app
// registration hygiene: apps with no owner, apps that sign in with client
// secrets only (no certificate or federated credential), and client secrets
// made to last longer than the set maximum. Key Vault items are checked by the
// Key Vault tool; app permissions by App permissions.
// Graph: Application.Read.All.
const { graphGetAll } = require("../graphClient");
const settings = require("../settings");
const { numberSetting, mapLimit, runChecks, itemErrors, scanError, graphHint } = require("./util");

const TOOL_ID = "secret-expiry";
const MAX_FEDERATED_LOOKUPS = 300;
const DAY = 86400000;
const TENANT = { resourceGroup: null, subscriptionId: null };

function warnDays() {
  return Number(settings.get("SECRET_EXPIRY_WARN_DAYS")) || 30;
}

function withinWarnWindow(endDateTime) {
  if (!endDateTime) return false;
  const msLeft = new Date(endDateTime).getTime() - Date.now();
  return msLeft <= warnDays() * 24 * 60 * 60 * 1000;
}

async function expiryFindings() {
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

// Credentials that still work: no end date or an end date ahead.
const live = (creds, now) => (creds || []).filter((c) => !c.endDateTime || Date.parse(c.endDateTime) > now);
const lifeDays = (c) => (Date.parse(c.endDateTime) - Date.parse(c.startDateTime)) / DAY;

// app: { id, appId, displayName, owners, passwordCredentials, keyCredentials, federated (count, or undefined when
// not looked up) }. Pure, for the tests.
function judgeHygiene(app, { maxSecretDays = 365, now = Date.now() } = {}) {
  const base = { ...TENANT, name: app.displayName || app.appId || app.id, appId: app.appId };
  const out = [];
  if (!(app.owners || []).length) {
    out.push({ ...base, kind: "app-no-owner", id: `${app.id}#no-owner`, detail: "App registration has no owner, so nobody is answerable for its secrets and permissions. Add an owner, or delete the app if it is not used" });
  }
  const secrets = live(app.passwordCredentials, now);
  if (secrets.length && !live(app.keyCredentials, now).length && app.federated === 0) {
    out.push({ ...base, kind: "app-secret-only", id: `${app.id}#secret-only`, detail: `Signs in with ${secrets.length} client secret${secrets.length === 1 ? "" : "s"} and no certificate or federated credential. Prefer a certificate or a federated credential (workload identity federation)` });
  }
  // A day of slack: the portal's "12 months" can be 366 days.
  const long = secrets.filter((c) => c.startDateTime && c.endDateTime && lifeDays(c) > maxSecretDays + 1);
  if (long.length) {
    const days = Math.round(Math.max(...long.map(lifeDays)));
    out.push({ ...base, kind: "app-secret-long-lived", id: `${app.id}#secret-long`, detail: `${long.length} client secret${long.length === 1 ? " is" : "s are"} valid for more than ${maxSecretDays} days (longest ${days} days). Replace with a shorter secret, a certificate or a federated credential` });
  }
  return out;
}

async function hygieneFindings() {
  const maxSecretDays = numberSetting("APP_SECRET_MAX_DAYS", 365, { min: 1 });
  let apps;
  try {
    apps = await graphGetAll("/applications?$select=id,appId,displayName,passwordCredentials,keyCredentials&$expand=owners($select=id)&$top=100", TOOL_ID);
  } catch (err) {
    throw new Error(graphHint(err, "Application.Read.All"));
  }
  // Federated credentials are a separate call per app; only needed for apps with secrets and no certificate.
  const now = Date.now();
  const need = apps.filter((a) => live(a.passwordCredentials, now).length && !live(a.keyCredentials, now).length);
  const list = need.slice(0, MAX_FEDERATED_LOOKUPS);
  const failures = await mapLimit(list, 6, async (a) => {
    a.federated = (await graphGetAll(`/applications/${a.id}/federatedIdentityCredentials?$select=id`, TOOL_ID)).length;
  });
  const findings = apps.flatMap((a) => judgeHygiene(a, { maxSecretDays, now }));
  findings.push(...itemErrors(TOOL_ID, "federated", "apps checked for federated credentials", failures, list.length));
  if (need.length > list.length) {
    findings.push(scanError(TOOL_ID, "federated-cap", `${need.length - list.length} secret-only apps not checked`, `Only the first ${MAX_FEDERATED_LOOKUPS} apps with secrets and no certificate were checked for federated credentials`));
  }
  return findings;
}

async function run() {
  return runChecks(TOOL_ID, {
    "Expiring credentials": expiryFindings,
    "App hygiene": hygieneFindings,
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Expiring app credentials",
  schedule: "0 6 * * *", // nightly at 06:00
  run,
  _test: { judgeHygiene },
};
