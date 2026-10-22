// Accounts nobody uses: enabled members and guests with no sign-in for a long
// time, accounts that never signed in, and guest invitations never accepted.
// Graph: User.Read.All and AuditLog.Read.All (sign-in activity needs
// Microsoft Entra ID P1 or P2).
const { graphGetAll } = require("../graphClient");
const { numberSetting, graphHint } = require("./util");

const TOOL_ID = "stale-accounts";
const DAY = 86400000;

const lastSignIn = (u) => {
  const a = u.signInActivity || {};
  // The other two also count failed attempts (someone guessing passwords
  // keeps them fresh), so a successful sign-in wins when Graph has one.
  const ok = Date.parse(a.lastSuccessfulSignInDateTime);
  if (Number.isFinite(ok)) return ok;
  const times = [a.lastSignInDateTime, a.lastNonInteractiveSignInDateTime].filter(Boolean).map(Date.parse).filter(Number.isFinite);
  return times.length ? Math.max(...times) : null;
};
const ageDays = (t, now) => Math.floor((now - t) / DAY);
const day = (t) => new Date(t).toISOString().slice(0, 10);

function classify(users, { memberDays, guestDays, now = Date.now() }) {
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
    const last = lastSignIn(u);
    if (guest && u.externalUserState === "PendingAcceptance") {
      if (Number.isFinite(created) && ageDays(created, now) > limit) {
        findings.push({ ...base, kind: "guest-invite-pending", id: `${u.id}#pending`, detail: `Guest invited ${day(created)} never accepted the invitation; delete it or send it again` });
      }
      continue;
    }
    if (last == null) {
      if (Number.isFinite(created) && ageDays(created, now) > limit) {
        findings.push({ ...base, kind: "never-signed-in", id: `${u.id}#never`, detail: `${guest ? "Guest" : where} created ${day(created)} has never signed in` });
      }
      continue;
    }
    const age = ageDays(last, now);
    if (age > limit) {
      findings.push({ ...base, kind: guest ? "stale-guest" : "stale-user", id: `${u.id}#stale`, detail: `${guest ? "Guest" : where}: no sign-in for ${age} days (last ${day(last)})${advice}` });
    }
  }
  return findings;
}

async function run() {
  const memberDays = numberSetting("STALE_ACCOUNT_DAYS", 90, { min: 7, max: 3650 });
  const guestDays = numberSetting("STALE_GUEST_DAYS", 90, { min: 7, max: 3650 });
  let users;
  try {
    users = await graphGetAll(
      "/users?$select=id,displayName,userPrincipalName,userType,accountEnabled,createdDateTime,externalUserState,onPremisesSyncEnabled,signInActivity",
      TOOL_ID
    );
  } catch (err) {
    throw new Error(graphHint(err, "AuditLog.Read.All (and User.Read.All)"));
  }
  return classify(users, { memberDays, guestDays });
}

module.exports = {
  id: TOOL_ID,
  label: "Stale accounts",
  schedule: "30 5 * * *", // daily at 05:30
  run,
  _test: { classify },
};
