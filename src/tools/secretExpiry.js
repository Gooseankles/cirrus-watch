// App registration secrets and certificates that expire soon, and app
// registration hygiene: apps with no owner, apps that sign in with client
// secrets only (no certificate or federated credential), and client secrets
// made to last longer than the set maximum, federated credentials whose subject
// lets in more than one workload (a wildcard, or any GitHub pull request), and
// redirect URIs that use plain http:// (not localhost) or a wildcard. Key Vault
// items are checked by the Key Vault tool; app permissions by App permissions.
// Graph: Application.Read.All.
const { graphGetAll } = require("../graphClient");
const settings = require("../settings");
const { numberSetting, mapLimit, runChecks, itemErrors, scanError, graphHint } = require("./util");

const TOOL_ID = "secret-expiry";
const MAX_FEDERATED_LOOKUPS = 300;
const MAX_NAMED = 3; // credentials or URIs named in one finding
const LOCAL_HOSTS = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i;
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

// fics: the app's federated identity credentials ({ name, issuer, subject }). Pure, for the tests.
function judgeFederated(app, fics) {
  const broad = (fics || []).filter((f) => {
    const subject = String(f.subject || "");
    return subject.includes("*") || (/^https:\/\/token\.actions\.githubusercontent\.com\/?$/i.test(f.issuer || "") && /:pull_request$/i.test(subject));
  });
  if (!broad.length) return [];
  const list = broad.slice(0, MAX_NAMED).map((f) => `${f.name || "unnamed"} (${f.subject})`).join(", ") + (broad.length > MAX_NAMED ? ` and ${broad.length - MAX_NAMED} more` : "");
  return [{ ...TENANT, name: app.displayName || app.appId || app.id, appId: app.appId, kind: "app-fic-broad-subject", id: `${app.id}#fic-subject`, detail: `Federated credential subject lets in more than one workload: ${list}. A pull_request subject lets any pull request's workflow sign in as the app. Tie the subject to one branch, tag or environment` }];
}

// The redirect URIs of an app registration (web, single-page and public client). Pure, for the tests.
function judgeRedirects(app) {
  const uris = [...(((app.web || {}).redirectUris) || []), ...(((app.spa || {}).redirectUris) || []), ...(((app.publicClient || {}).redirectUris) || [])];
  const bad = [...new Set(uris.filter((u) => {
    if (String(u).includes("*")) return true;
    const m = /^http:\/\/(\[[^\]]+\]|[^/:?#]+)/i.exec(String(u));
    return Boolean(m) && !LOCAL_HOSTS.test(m[1]);
  }))];
  if (!bad.length) return [];
  const list = bad.slice(0, MAX_NAMED).join(", ") + (bad.length > MAX_NAMED ? ` and ${bad.length - MAX_NAMED} more` : "");
  return [{ ...TENANT, name: app.displayName || app.appId || app.id, appId: app.appId, kind: "app-redirect-insecure", id: `${app.id}#redirect`, detail: `Redirect URI uses plain http:// or a wildcard: ${list}. Sign-in codes and tokens sent there can be read or redirected; use https:// and exact addresses (http:// only for localhost)` }];
}

async function hygieneFindings() {
  const maxSecretDays = numberSetting("APP_SECRET_MAX_DAYS", 365, { min: 1 });
  let apps;
  try {
    apps = await graphGetAll("/applications?$select=id,appId,displayName,passwordCredentials,keyCredentials,web,spa,publicClient&$expand=owners($select=id)&$top=100", TOOL_ID);
  } catch (err) {
    throw new Error(graphHint(err, "Application.Read.All"));
  }
  // Federated credentials are a separate call per app. Apps with secrets and no certificate come first (they need the
  // count for the secret-only check); the rest fill the cap for the subject check.
  const now = Date.now();
  const need = apps.filter((a) => live(a.passwordCredentials, now).length && !live(a.keyCredentials, now).length);
  const rest = apps.filter((a) => !need.includes(a));
  const list = [...need, ...rest].slice(0, MAX_FEDERATED_LOOKUPS);
  const failures = await mapLimit(list, 6, async (a) => {
    a.fics = await graphGetAll(`/applications/${a.id}/federatedIdentityCredentials?$select=id,name,issuer,subject`, TOOL_ID);
    a.federated = a.fics.length;
  });
  const findings = apps.flatMap((a) => [...judgeHygiene(a, { maxSecretDays, now }), ...judgeFederated(a, a.fics), ...judgeRedirects(a)]);
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
  _test: { judgeHygiene, judgeFederated, judgeRedirects },
};
