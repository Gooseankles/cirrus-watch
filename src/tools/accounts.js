// The state of the user accounts in the tenant, one finding per account:
// enabled members and guests nobody uses (no sign-in for a long time, never
// signed in, guest invitations never accepted), active members with no MFA
// method registered or only phone and text message, plus two smaller checks:
// successful sign-ins with legacy clients that cannot do MFA, and users Entra
// ID Protection marks as risky that nobody has dealt with.
//
// Stale and MFA used to be two scans that listed the same accounts twice: an
// account nobody uses has no MFA method either. Here an unused account is one
// finding (its detail says when it also has no MFA), and MFA is judged only for
// accounts that are in use (a sign-in within the stale window): an account that
// has never signed in cannot have registered a method yet.
//
// Replaces the Stale accounts, MFA coverage, Legacy sign-ins and Risky users
// scans (0.72.0.0); their finding kinds and ids are kept, so accepted findings
// and ages carry over. Graph: User.Read.All and AuditLog.Read.All (sign-in
// activity, the authentication methods report and the sign-in log need
// Microsoft Entra ID P1 or P2); the risky users part is an extra Graph check
// (extraChecks.js, IdentityRiskyUser.Read.All, needs P2). Admins' MFA is left
// to Privileged roles (privileged-no-mfa), guests' MFA to their own tenant.
const log = require("../log");
const { graphGet, graphGetAll } = require("../graphClient");
const { numberSetting, mapLimit, runChecks, scanError, itemErrors, graphHint } = require("./util");
const extra = require("./extraChecks");

const TOOL_ID = "accounts";
const DAY = 86400000;
const day = (t) => new Date(t).toISOString().slice(0, 10);
const ageDays = (t, now) => Math.floor((now - t) / DAY);

// ---- Accounts: stale, never used, no MFA ----

const PHONE = new Set(["mobilePhone", "alternateMobilePhone", "officePhone"]);
// Methods that are not a second factor on their own.
const NOT_MFA = new Set(["email", "securityQuestion", "temporaryAccessPass"]);

const lastSignIn = (u) => {
  const a = u.signInActivity || {};
  // The other two also count failed attempts (someone guessing passwords
  // keeps them fresh), so a successful sign-in wins when Graph has one.
  const ok = Date.parse(a.lastSuccessfulSignInDateTime);
  if (Number.isFinite(ok)) return ok;
  const times = [a.lastSignInDateTime, a.lastNonInteractiveSignInDateTime].filter(Boolean).map(Date.parse).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
};

// The MFA state of a member from its registration report row: "none" (no
// method that counts), "weak" (phone or text message only), "ok", or null when
// the row says nothing (no row, or an admin, left to Privileged roles).
function mfaState(r) {
  if (!r || r.isAdmin) return null;
  const methods = (r.methodsRegistered || []).filter((m) => !NOT_MFA.has(m));
  if (!r.isMfaRegistered || !methods.length) return { state: "none", methods: r.methodsRegistered || [] };
  if (methods.every((m) => PHONE.has(m))) return { state: "weak", methods };
  return { state: "ok", methods };
}

// users: Graph users with signInActivity; rows: userRegistrationDetails. Pure.
function classify(users, rows, { memberDays, guestDays, newDays, now = Date.now() }) {
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  const findings = [];
  for (const u of users) {
    if (u.accountEnabled === false) continue;
    const guest = u.userType === "Guest";
    const limit = guest ? guestDays : memberDays;
    const created = Date.parse(u.createdDateTime);
    const synced = u.onPremisesSyncEnabled === true;
    const where = synced ? "Synced from on-premises AD" : "Cloud-only account";
    // Synced accounts get no advice: on-premises use (service accounts, AD
    // sign-ins) never shows in Entra's sign-in activity.
    const advice = guest || !synced ? ". Disable it if nobody needs it" : "";
    const base = { name: u.userPrincipalName || u.displayName || u.id, resourceGroup: null, subscriptionId: null, principalId: u.id, source: synced ? "ad-synced" : "cloud" };
    const mfa = guest ? null : mfaState(byId.get(u.id));
    const last = lastSignIn(u);
    if (guest && u.externalUserState === "PendingAcceptance") {
      if (Number.isFinite(created) && ageDays(created, now) > limit) {
        findings.push({ ...base, kind: "guest-invite-pending", id: `${u.id}#pending`, detail: `Guest invited ${day(created)} never accepted the invitation; delete it or send it again` });
      }
      continue;
    }
    if (last == null) {
      // No MFA finding: a method is registered at a sign-in, so there is none
      // to judge yet. Past the limit the account itself is the finding.
      if (Number.isFinite(created) && ageDays(created, now) > limit) {
        findings.push({ ...base, kind: "never-signed-in", id: `${u.id}#never`, detail: `${guest ? "Guest" : where} created ${day(created)} has never signed in` });
      }
      continue;
    }
    const age = ageDays(last, now);
    if (age > limit) {
      // One finding for an unused account, even when it has no MFA either.
      const noMfa = mfa && mfa.state === "none" ? "; it also has no MFA method registered" : "";
      findings.push({ ...base, kind: guest ? "stale-guest" : "stale-user", id: `${u.id}#stale`, detail: `${guest ? "Guest" : where}: no sign-in for ${age} days (last ${day(last)})${noMfa}${advice}` });
      continue;
    }
    // In use: MFA is judged, once the account has had time to set it up.
    if (!mfa || mfa.state === "ok") continue;
    if (Number.isFinite(created) && now - created < newDays * DAY) continue;
    if (mfa.state === "none") {
      const has = mfa.methods.length ? ` (only ${mfa.methods.join(", ")})` : "";
      findings.push({ ...base, kind: "user-no-mfa", id: `${u.id}#no-mfa`, detail: `No MFA method registered${has}; anyone with the password can sign in where MFA is not enforced` });
    } else {
      findings.push({ ...base, kind: "mfa-weak-only", id: `${u.id}#weak`, detail: `Only phone or text message (${mfa.methods.join(", ")}); add Microsoft Authenticator, a passkey or Windows Hello` });
    }
  }
  return findings;
}

async function accountFindings() {
  const memberDays = numberSetting("STALE_ACCOUNT_DAYS", 90, { min: 7, max: 3650 });
  const guestDays = numberSetting("STALE_GUEST_DAYS", 90, { min: 7, max: 3650 });
  const newDays = numberSetting("MFA_NEW_USER_DAYS", 14, { min: 0, max: 365 });
  let users, rows;
  try {
    [users, rows] = await Promise.all([
      graphGetAll(
        "/users?$select=id,displayName,userPrincipalName,userType,accountEnabled,createdDateTime,externalUserState,onPremisesSyncEnabled,signInActivity&$top=500",
        TOOL_ID
      ),
      graphGetAll("/reports/authenticationMethods/userRegistrationDetails?$select=id,isAdmin,isMfaRegistered,methodsRegistered", TOOL_ID),
    ]);
  } catch (err) {
    throw new Error(graphHint(err, "AuditLog.Read.All (and User.Read.All)"));
  }
  return classify(users, rows, { memberDays, guestDays, newDays });
}

// ---- Legacy sign-ins ----
//
// Successful sign-ins in the last 7 days with legacy (basic authentication)
// clients: IMAP, POP, SMTP AUTH, Exchange ActiveSync, older Outlook protocols
// and "Other clients". Legacy authentication cannot do MFA, so a password
// alone is enough. One finding per user and client, with the count and the
// last time. Each client is read with its own filter and a page cap, so a busy
// tenant does not pull its whole sign-in log. Graph v1.0 lists the interactive
// user sign-ins (and successful federated ones); legacy sign-ins that Entra
// files as non-interactive are not seen, so the counts are a floor.
// clientAppUsed only supports an eq filter (no ne, no in), so each client value
// is its own query. The sign-in report endpoint is throttled at 5 requests per
// 10 seconds per tenant and sends no Retry-After (graphClient backs off with
// jitter), hence the low concurrency and page cap. Without P1 the part notes
// that in the log and reports nothing.
const LEGACY_ID = "legacy-sign-ins"; // the old scan's id, kept in finding ids
const LEGACY_DAYS = 7;
const LEGACY_MAX_PAGES = 3; // per client value, 1000 rows a page
const LEGACY_CONCURRENCY = 2;
// clientAppUsed values counted as legacy. Microsoft Learn lists the short names
// (IMAP, POP, SMTP, MAPI); the portal's Client app filter and real logs show the
// long ones (IMAP4, POP3, Authenticated SMTP, MAPI Over HTTP). Both are asked
// for; an unused value costs one empty page.
const LEGACY_CLIENTS = [
  "Exchange ActiveSync", "IMAP4", "IMAP", "POP3", "POP", "Authenticated SMTP", "SMTP", "MAPI Over HTTP", "MAPI",
  "Other clients", "AutoDiscover", "Exchange Web Services", "Exchange Online PowerShell", "Offline Address Book",
  "Outlook Anywhere (RPC over HTTP)", "Reporting Web Services", "Universal Outlook",
];
const LEGACY_SET = new Set(LEGACY_CLIENTS.map((c) => c.toLowerCase()));
const odataString = (s) => s.replace(/'/g, "''");

// rows: sign-in records. Keeps successful ones with a legacy client, grouped
// per user and client. Pure, for the tests.
function groupLegacy(rows) {
  const seen = new Set();
  const groups = new Map();
  for (const r of rows || []) {
    if (r.id && seen.has(r.id)) continue;
    if (r.id) seen.add(r.id);
    const client = String(r.clientAppUsed || "");
    if (!LEGACY_SET.has(client.toLowerCase())) continue;
    if (r.status && Number(r.status.errorCode) !== 0) continue;
    const user = r.userId || r.userPrincipalName || "unknown";
    const key = `${user}|${client.toLowerCase()}`;
    const g = groups.get(key) || { userId: r.userId || null, upn: r.userPrincipalName || "", displayName: r.userDisplayName || "", client, count: 0, last: null, apps: new Set() };
    g.count++;
    if (!g.last || String(r.createdDateTime) > g.last) g.last = r.createdDateTime || g.last;
    if (r.appDisplayName) g.apps.add(r.appDisplayName);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    kind: "legacy-signin-used",
    id: `${LEGACY_ID}/${g.userId || g.upn}/${g.client.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: g.upn || g.displayName || g.userId || "Unknown user",
    detail: `${g.count} successful interactive sign-in(s) with ${g.client} in the last ${LEGACY_DAYS} days, last at ${g.last}${g.apps.size ? ` (${[...g.apps].slice(0, 3).join(", ")})` : ""}. Legacy clients cannot do MFA; move this user or mailbox to modern authentication and block legacy authentication with Conditional Access`,
    resourceGroup: null,
    subscriptionId: null,
    ...(g.userId && { principalId: g.userId }),
  }));
}

// One client value, at most LEGACY_MAX_PAGES pages. -> { rows, capped }
async function readClient(client, since) {
  const filter = `createdDateTime ge ${since} and clientAppUsed eq '${odataString(client)}' and status/errorCode eq 0`;
  let next = `/auditLogs/signIns?$filter=${encodeURIComponent(filter)}&$top=1000`;
  const rows = [];
  for (let page = 0; next && page < LEGACY_MAX_PAGES; page++) {
    const data = await graphGet(next, TOOL_ID);
    rows.push(...(data.value || []));
    next = data["@odata.nextLink"] || null;
  }
  return { rows, capped: Boolean(next) };
}

async function legacyFindings() {
  const since = new Date(Date.now() - LEGACY_DAYS * DAY).toISOString();
  // The first client alone tells whether the tenant can read sign-ins at all.
  let first;
  try {
    first = await readClient(LEGACY_CLIENTS[0], since);
  } catch (err) {
    if (extra.noPremium(err)) {
      log.record({ tool: TOOL_ID, level: "info", message: "Legacy sign-ins not checked: reading sign-in logs through Graph needs Microsoft Entra ID P1 or P2 in this tenant" });
      return [];
    }
    throw new Error(graphHint(err, "AuditLog.Read.All"));
  }
  const rows = [...first.rows];
  const capped = first.capped ? [LEGACY_CLIENTS[0]] : [];
  const failures = await mapLimit(LEGACY_CLIENTS.slice(1), LEGACY_CONCURRENCY, async (client) => {
    const r = await readClient(client, since);
    rows.push(...r.rows);
    if (r.capped) capped.push(client);
  });
  if (capped.length) {
    log.record({ tool: TOOL_ID, level: "info", message: `Legacy sign-ins: only the newest ${LEGACY_MAX_PAGES * 1000} sign-ins were read for ${capped.join(", ")}; counts for those clients are lower than the real ones` });
  }
  return [...groupLegacy(rows), ...itemErrors(TOOL_ID, "clients", "legacy client types", failures.map((f) => ({ ...f, message: graphHint({ message: f.message }, "AuditLog.Read.All") })), LEGACY_CLIENTS.length)];
}

// ---- Risky users ----
//
// Users Microsoft Entra ID Protection marks as risky and nobody has dealt with:
// risk state confirmedCompromised, or atRisk at risk level high or medium.
// Remediated, dismissed and confirmed-safe users are left out, as are low risk
// and deleted users. Oldest first (the longest left alone), compromised and
// high before medium, at most RISKY_USERS_MAX findings. Extra Graph check
// `risky-users` (extraChecks.js): IdentityRiskyUser.Read.All. Risk detections
// are not read, so IdentityRiskEvent.Read.All is not needed. Reading risky
// users needs Microsoft Entra ID P2; without it the part notes that and
// reports nothing. GET /identityProtection/riskyUsers takes $filter and $top
// (500 at most) but no $orderby, so the sort is done here.
const RISKY_ID = "risky-users"; // the extra check's id and the old scan's id, kept in finding ids
const RISKY_LABEL = "Risky users";
const RISKY_STATES = ["confirmedCompromised", "atRisk"];
const RISKY_MAX_PAGES = 4; // per state, 500 users a page
const RISKY_DEFAULT_MAX = 50;
const RANK = { compromised: 0, high: 1, medium: 2 };

// riskyUser -> "compromised" | "high" | "medium" | null (not reported). Pure.
function riskLevel(u) {
  if (!u || u.isDeleted) return null;
  if (u.riskState === "confirmedCompromised") return "compromised";
  if (u.riskState !== "atRisk") return null;
  if (u.riskLevel === "high") return "high";
  if (u.riskLevel === "medium") return "medium";
  return null;
}

// riskyUser records -> findings, worst and oldest first, capped. Pure.
function riskyFindings(users, max = RISKY_DEFAULT_MAX, now = Date.now()) {
  const seen = new Set();
  const rows = [];
  for (const u of users || []) {
    if (!u || seen.has(u.id)) continue;
    seen.add(u.id);
    const level = riskLevel(u);
    if (level) rows.push({ u, level });
  }
  rows.sort((a, b) => RANK[a.level] - RANK[b.level] || String(a.u.riskLastUpdatedDateTime || "").localeCompare(String(b.u.riskLastUpdatedDateTime || "")));
  const kept = rows.slice(0, max);
  const findings = kept.map(({ u, level }) => {
    const since = u.riskLastUpdatedDateTime ? Math.max(0, Math.floor((now - Date.parse(u.riskLastUpdatedDateTime)) / DAY)) : null;
    const what = level === "compromised" ? "An admin confirmed this account as compromised" : `ID Protection rates this account ${level} risk`;
    return {
      kind: `risky-user-${level}`,
      id: `${RISKY_ID}/${u.id}`,
      name: u.userPrincipalName || u.userDisplayName || u.id,
      detail: `${what} (state ${u.riskState}${u.riskDetail && u.riskDetail !== "none" ? `, ${u.riskDetail}` : ""})${since !== null ? `, last changed ${since} day(s) ago` : ""}. Not remediated: reset the password or revoke sessions, check the sign-ins, then confirm safe or dismiss in Entra ID Protection`,
      resourceGroup: null,
      subscriptionId: null,
      principalId: u.id,
    };
  });
  return { findings, total: rows.length };
}

async function readRiskState(state) {
  const filter = encodeURIComponent(`riskState eq '${state}'`);
  let next = `/identityProtection/riskyUsers?$filter=${filter}&$top=500`;
  const rows = [];
  for (let page = 0; next && page < RISKY_MAX_PAGES; page++) {
    const data = await graphGet(next, TOOL_ID);
    rows.push(...(data.value || []));
    next = data["@odata.nextLink"] || null;
  }
  if (next) log.record({ tool: TOOL_ID, level: "info", message: `Risky users: more than ${rows.length} users in state ${state}, only the first ${rows.length} were read` });
  return rows;
}

async function riskyUserFindings() {
  if (!extra.isOn(RISKY_ID)) return [];
  let users = [];
  try {
    for (const state of RISKY_STATES) users = users.concat(await readRiskState(state));
  } catch (err) {
    if (extra.noPremium(err)) {
      log.record({ tool: TOOL_ID, level: "info", message: "Risky users not checked: Entra ID Protection risk data needs Microsoft Entra ID P2 in this tenant" });
      return [];
    }
    if (extra.refused(err)) return extra.permissionMissing(RISKY_ID, RISKY_LABEL, err, TOOL_ID);
    throw err;
  }
  const max = numberSetting("RISKY_USERS_MAX", RISKY_DEFAULT_MAX, { min: 1, max: 1000 });
  const { findings, total } = riskyFindings(users, max);
  if (total > findings.length) {
    log.record({ tool: TOOL_ID, level: "info", message: `Risky users: ${total} users at risk, the ${findings.length} worst and oldest are listed (RISKY_USERS_MAX)` });
  }
  return findings;
}

// ---- The run ----

// The account part is the scan: when it fails (Graph down, no licence) the run
// fails and the tenant keeps its last results, instead of thousands of account
// findings going and coming back. The two smaller parts run beside it; one that
// fails becomes a scan-error finding (runChecks), never a lost run.
async function run() {
  const [accounts, extras] = await Promise.all([
    accountFindings(),
    runChecks(TOOL_ID, { "Legacy sign-ins": legacyFindings, "Risky users": riskyUserFindings }).catch((err) => [
      scanError(TOOL_ID, "checks", "Legacy sign-ins and Risky users not checked", String(err.message || err).slice(0, 300)),
    ]),
  ]);
  return [...accounts, ...extras];
}

module.exports = {
  id: TOOL_ID,
  label: "Accounts",
  schedule: "30 5 * * *", // daily at 05:30
  replaces: ["stale-accounts", "mfa-coverage", "legacy-sign-ins", "risky-users"],
  run,
  _test: {
    classify,
    mfaState,
    legacy: { groupLegacy, LEGACY_CLIENTS, run: legacyFindings },
    risky: { classify: riskLevel, riskyFindings, run: riskyUserFindings },
  },
};
