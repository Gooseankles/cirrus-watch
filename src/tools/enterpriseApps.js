// Enterprise apps (service principals): SAML signing certificates that expire,
// secrets and certificates set on the service principal itself (Expiring app
// credentials reads only app registrations), SSO apps anyone in the tenant may
// sign in to, apps from this tenant with no owner, other companies' apps nobody
// has used for a long time, and disabled apps that still hold Azure roles.
// Microsoft's own apps and managed identities are left out.
// Graph: Application.Read.All; AuditLog.Read.All for sign-in activity (optional,
// skipped when refused). Azure: Reader for the role assignment check (optional).
const { graphGetAll, getGraphToken } = require("../graphClient");
const { resourceGraphQuery } = require("../armClient");
const log = require("../log");
const { numberSetting, runChecks, graphHint } = require("./util");

const TOOL_ID = "enterprise-apps";
const DAY = 86400000;
const URGENT_DAYS = 14;
const MICROSOFT_TENANTS = new Set(["f8cdef31-a31e-4b4a-93e4-5f571e91255a", "72f988bf-86f1-41af-91ab-2d7cd011db47"]);
const SIGN_IN_ACTIVITY = "https://graph.microsoft.com/beta/reports/servicePrincipalSignInActivities";
const TENANT = { resourceGroup: null, subscriptionId: null };
const SELECT = [
  "id", "appId", "displayName", "accountEnabled", "appOwnerOrganizationId", "servicePrincipalType", "preferredSingleSignOnMode",
  "preferredTokenSigningKeyThumbprint", "appRoleAssignmentRequired", "keyCredentials", "passwordCredentials",
].join(",");

// Same window as Expiring app credentials.
function warnDays() {
  return numberSetting("SECRET_EXPIRY_WARN_DAYS", 30, { min: 1 });
}

const lower = (s) => String(s || "").toLowerCase();
const day = (t) => new Date(t).toISOString().slice(0, 10);
const microsoft = (sp) => MICROSOFT_TENANTS.has(lower(sp.appOwnerOrganizationId));
const ours = (sp, tenantId) => !!tenantId && lower(sp.appOwnerOrganizationId) === lower(tenantId);
const thirdParty = (sp, tenantId) => !!sp.appOwnerOrganizationId && !ours(sp, tenantId) && !microsoft(sp);
const saml = (sp) => lower(sp.preferredSingleSignOnMode) === "saml";
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// customKeyIdentifier is binary (base64 in JSON); for SAML certificates it holds the thumbprint, either as the raw
// bytes or as the hex text. Compare both ways.
function keyThumbprints(c) {
  const raw = String(c.customKeyIdentifier || "");
  if (!raw) return [];
  const out = [raw.toUpperCase()];
  try {
    const buf = Buffer.from(raw, "base64");
    out.push(buf.toString("hex").toUpperCase(), buf.toString("utf8").toUpperCase());
  } catch {
    /* not base64: the raw text is all there is */
  }
  return out;
}

// The SAML signing certificate in use: the Sign key matching preferredTokenSigningKeyThumbprint, else the Sign key
// that lasts longest.
function activeSigningCert(sp) {
  const sign = (sp.keyCredentials || []).filter((c) => lower(c.usage) === "sign");
  if (!sign.length) return null;
  const thumb = String(sp.preferredTokenSigningKeyThumbprint || "").toUpperCase();
  if (thumb) {
    const hit = sign.find((c) => keyThumbprints(c).includes(thumb));
    if (hit) return hit;
  }
  return [...sign].sort((a, b) => (Date.parse(b.endDateTime) || 0) - (Date.parse(a.endDateTime) || 0))[0];
}

// Expiry band: expired, soon (under 14 days) or within the warning window; null when further off or no end date.
function expiryBand(endDateTime, { warn, now }) {
  const end = Date.parse(endDateTime);
  if (!Number.isFinite(end)) return null;
  const days = (end - now) / DAY;
  if (days <= 0) return "expired";
  if (days < URGENT_DAYS) return "soon";
  if (days <= warn) return "expiring";
  return null;
}
const inDays = (endDateTime, now) => Math.max(0, Math.ceil((Date.parse(endDateTime) - now) / DAY));

// The service principal's own credentials that are not the SAML signing set (the Sign and Verify certificates and the
// password that protects the signing key share one customKeyIdentifier).
function ownCredentials(sp) {
  const keys = sp.keyCredentials || [];
  const passwords = sp.passwordCredentials || [];
  if (!saml(sp)) return { keys, passwords };
  const signing = new Set(keys.filter((c) => lower(c.usage) === "sign").flatMap(keyThumbprints));
  const samlSet = (c) => keyThumbprints(c).some((t) => signing.has(t));
  return {
    keys: keys.filter((c) => lower(c.usage) !== "sign" && lower(c.usage) !== "verify" && !samlSet(c)),
    passwords: passwords.filter((c) => !samlSet(c)),
  };
}

// sps: service principals with owners expanded ([{ id }]). Options: tenantId (this tenant), warnDays, unusedDays,
// signIns (Map appId -> last sign-in time in ms, or null when sign-in activity could not be read), now. Pure, for
// the tests.
function classify(sps, { tenantId, warnDays: warn = 30, unusedDays = 90, signIns = null, now = Date.now() } = {}) {
  const findings = [];
  for (const sp of sps) {
    if (sp.servicePrincipalType && sp.servicePrincipalType !== "Application") continue; // managed identities, legacy
    if (microsoft(sp)) continue;
    const base = { ...TENANT, name: sp.displayName || sp.appId || sp.id, appId: sp.appId, principalId: sp.id };
    const enabled = sp.accountEnabled !== false;

    // --- SAML signing certificate ---
    if (saml(sp)) {
      const cert = activeSigningCert(sp);
      const band = cert && expiryBand(cert.endDateTime, { warn, now });
      if (band) {
        const when = band === "expired" ? `expired ${day(cert.endDateTime)}` : `expires ${day(cert.endDateTime)} (in ${plural(inDays(cert.endDateTime, now), "day")})`;
        findings.push({
          ...base,
          kind: { expired: "ent-saml-cert-expired", soon: "ent-saml-cert-expiring-soon", expiring: "ent-saml-cert-expiring" }[band],
          id: `${sp.id}/${cert.keyId}#saml-cert`,
          expires: cert.endDateTime,
          detail: `SAML signing certificate ${when}${enabled ? "" : " (the app is disabled)"}. Sign-in to the app stops working when it runs out: add a new certificate, give it to the app's vendor, then make it active`,
        });
      }
    }

    // --- Credentials on the service principal itself ---
    const own = ownCredentials(sp);
    const creds = [...own.passwords.map((c) => ({ ...c, what: "secret" })), ...own.keys.map((c) => ({ ...c, what: "certificate" }))];
    for (const c of creds) {
      const band = expiryBand(c.endDateTime, { warn, now });
      if (!band) continue;
      const label = c.displayName ? `"${c.displayName}"` : c.keyId;
      const when = band === "expired" ? `expired ${day(c.endDateTime)}` : `expires ${day(c.endDateTime)} (in ${plural(inDays(c.endDateTime, now), "day")})`;
      findings.push({
        ...base,
        kind: { expired: "ent-sp-credential-expired", soon: "ent-sp-credential-expiring-soon", expiring: "ent-sp-credential-expiring" }[band],
        id: `${sp.id}/${c.keyId}#sp-credential`,
        expires: c.endDateTime,
        detail: `Service principal ${c.what} ${label} ${when}. It is set on the enterprise app, not the app registration, so it does not show under Certificates & secrets: renew it there or remove it`,
      });
    }
    const liveSecrets = own.passwords.filter((c) => !c.endDateTime || Date.parse(c.endDateTime) > now);
    if (liveSecrets.length && ours(sp, tenantId)) {
      findings.push({
        ...base,
        kind: "ent-sp-secret",
        id: `${sp.id}#sp-secret`,
        detail: `${plural(liveSecrets.length, "client secret")} set on the service principal itself, where the portal does not show ${liveSecrets.length === 1 ? "it" : "them"} and owners of the app registration do not see ${liveSecrets.length === 1 ? "it" : "them"}. Move to a secret or certificate on the app registration, or a federated credential`,
      });
    }

    // --- Anyone in the tenant may sign in ---
    const sso = lower(sp.preferredSingleSignOnMode);
    if (enabled && sp.appRoleAssignmentRequired === false && (sso === "saml" || (sso === "oidc" && thirdParty(sp, tenantId)))) {
      findings.push({
        ...base,
        kind: "ent-open-sign-in",
        id: `${sp.id}#open-sign-in`,
        detail: `${sso === "saml" ? "SAML" : "OpenID Connect"} single sign-on is set up and assignment is not required, so every account in the tenant (guests included) can sign in. Turn on "Assignment required" and assign the users or groups who need it`,
      });
    }

    // --- No owner ---
    if (enabled && ours(sp, tenantId) && !(sp.owners || []).length) {
      findings.push({ ...base, kind: "ent-no-owner", id: `${sp.id}#no-owner`, detail: "Enterprise app from this tenant has no owner, so nobody is answerable for who may sign in and what it may do. Add an owner, or disable it if it is not used" });
    }

    // --- Other companies' apps nobody uses ---
    if (enabled && signIns && thirdParty(sp, tenantId) && signIns.has(sp.appId)) {
      const last = signIns.get(sp.appId);
      const age = last == null ? null : Math.floor((now - last) / DAY);
      if (age != null && age >= unusedDays) {
        findings.push({ ...base, kind: "ent-unused-app", id: `${sp.id}#unused`, detail: `Another company's app with no sign-in for ${age} days (last ${day(last)}). It keeps the permissions it was given: disable or delete it if nobody needs it` });
      }
    }
  }
  return findings;
}

// Last sign-in per appId from the sign-in activity report: the newest of the times it lists.
function signInTimes(rows) {
  const out = new Map();
  for (const r of rows) {
    if (!r.appId) continue;
    const times = Object.values(r)
      .filter((v) => v && typeof v === "object" && v.lastSignInDateTime)
      .map((v) => Date.parse(v.lastSignInDateTime))
      .filter(Number.isFinite);
    const prev = out.get(r.appId);
    const t = times.length ? Math.max(...times) : null;
    out.set(r.appId, prev == null ? t : t == null ? prev : Math.max(prev, t));
  }
  return out;
}

// Disabled service principals that still hold Azure role assignments. rows: Resource Graph role assignments
// ({ principalId, scope, subscriptionId, roleDefinitionId }). Pure, for the tests.
function disabledWithRoles(sps, rows) {
  const disabled = new Map(sps.filter((sp) => sp.accountEnabled === false).map((sp) => [lower(sp.id), sp]));
  const byPrincipal = new Map();
  for (const r of rows) {
    const sp = disabled.get(lower(r.principalId));
    if (!sp) continue;
    if (!byPrincipal.has(sp.id)) byPrincipal.set(sp.id, { sp, scopes: new Set(), subs: new Set() });
    const e = byPrincipal.get(sp.id);
    e.scopes.add(r.scope);
    if (r.subscriptionId) e.subs.add(r.subscriptionId);
  }
  return [...byPrincipal.values()].map(({ sp, scopes, subs }) => ({
    ...TENANT,
    subscriptionId: subs.size === 1 ? [...subs][0] : null,
    kind: "ent-disabled-azure-roles",
    id: `${sp.id}#disabled-azure-roles`,
    name: sp.displayName || sp.appId || sp.id,
    appId: sp.appId,
    principalId: sp.id,
    detail: `Disabled enterprise app still holds ${plural(scopes.size, "Azure role assignment")} (${[...scopes].slice(0, 3).join(", ")}${scopes.size > 3 ? " …" : ""}). Enabling it again gives the access back: remove the assignments if it is retired`,
  }));
}

// This tenant's id, from the Graph token (no extra permission needed).
async function tenantIdOf() {
  try {
    const token = await getGraphToken(TOOL_ID);
    return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8")).tid || null;
  } catch {
    return null;
  }
}

async function readSignIns() {
  try {
    return signInTimes(await graphGetAll(SIGN_IN_ACTIVITY, TOOL_ID));
  } catch (err) {
    log.record({ tool: TOOL_ID, level: "info", message: `Unused third-party apps not checked: sign-in activity could not be read (needs AuditLog.Read.All; ${String(err.message || err).slice(0, 160)})` });
    return null;
  }
}

async function roleAssignmentFindings(sps) {
  if (!sps.some((sp) => sp.accountEnabled === false)) return [];
  let rows;
  try {
    rows = await resourceGraphQuery(
      `AuthorizationResources
       | where type =~ 'microsoft.authorization/roleassignments'
       | where properties.principalType =~ 'ServicePrincipal'
       | project subscriptionId, principalId = tolower(tostring(properties.principalId)), scope = tostring(properties.scope),
           roleDefinitionId = tostring(properties.roleDefinitionId)`,
      { toolId: TOOL_ID }
    );
  } catch (err) {
    log.record({ tool: TOOL_ID, level: "info", message: `Azure roles of disabled apps not checked: role assignments could not be read (needs Reader; ${String(err.message || err).slice(0, 160)})` });
    return [];
  }
  return disabledWithRoles(sps, rows);
}

async function run() {
  let sps;
  try {
    sps = await graphGetAll(`/servicePrincipals?$select=${SELECT}&$expand=owners($select=id)&$top=100`, TOOL_ID);
  } catch (err) {
    throw new Error(graphHint(err, "Application.Read.All"));
  }
  const [tenantId, signIns] = await Promise.all([tenantIdOf(), readSignIns()]);
  if (!tenantId) log.record({ tool: TOOL_ID, level: "warn", message: "Could not tell this tenant's id from the Graph token: owner and secret checks for this tenant's apps skipped" });
  const unusedDays = numberSetting("ENTERPRISE_APP_UNUSED_DAYS", 90, { min: 7, max: 3650 });
  return runChecks(TOOL_ID, {
    "Enterprise apps": async () => classify(sps, { tenantId, warnDays: warnDays(), unusedDays, signIns }),
    "Azure roles of disabled apps": () => roleAssignmentFindings(sps),
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Enterprise apps",
  schedule: "20 5 * * *", // daily at 05:20
  run,
  _test: { classify, activeSigningCert, ownCredentials, signInTimes, disabledWithRoles },
};
