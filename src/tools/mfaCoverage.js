// MFA for everyone: enabled member accounts with no MFA method registered, and
// accounts whose only methods are phone calls or text messages (the weakest).
// Admins are left to Privileged roles (privileged-no-mfa), guests to their own
// tenant. Graph: User.Read.All and AuditLog.Read.All (the authentication
// methods report needs Microsoft Entra ID P1 or P2).
const { graphGetAll } = require("../graphClient");
const { numberSetting, graphHint } = require("./util");

const TOOL_ID = "mfa-coverage";
const DAY = 86400000;
const PHONE = new Set(["mobilePhone", "alternateMobilePhone", "officePhone"]);
// Methods that are not a second factor on their own.
const NOT_MFA = new Set(["email", "securityQuestion", "temporaryAccessPass"]);

function classify(users, rows, { newDays, now = Date.now() }) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const findings = [];
  for (const u of users) {
    if (u.accountEnabled === false || u.userType === "Guest") continue;
    const r = byId.get(u.id);
    if (!r || r.isAdmin) continue;
    const created = Date.parse(u.createdDateTime);
    if (Number.isFinite(created) && now - created < newDays * DAY) continue; // still setting up
    const base = { name: u.userPrincipalName || u.displayName || u.id, resourceGroup: null, subscriptionId: null, principalId: u.id };
    const methods = (r.methodsRegistered || []).filter((m) => !NOT_MFA.has(m));
    if (!r.isMfaRegistered || !methods.length) {
      const has = (r.methodsRegistered || []).length ? ` (only ${r.methodsRegistered.join(", ")})` : "";
      findings.push({ ...base, kind: "user-no-mfa", id: `${u.id}#no-mfa`, detail: `No MFA method registered${has}; anyone with the password can sign in where MFA is not enforced` });
    } else if (methods.every((m) => PHONE.has(m))) {
      findings.push({ ...base, kind: "mfa-weak-only", id: `${u.id}#weak`, detail: `Only phone or text message (${methods.join(", ")}); add Microsoft Authenticator, a passkey or Windows Hello` });
    }
  }
  return findings;
}

async function run() {
  const newDays = numberSetting("MFA_NEW_USER_DAYS", 14, { min: 0, max: 365 });
  let users, rows;
  try {
    [users, rows] = await Promise.all([
      graphGetAll("/users?$select=id,displayName,userPrincipalName,userType,accountEnabled,createdDateTime", TOOL_ID),
      graphGetAll("/reports/authenticationMethods/userRegistrationDetails?$select=id,isAdmin,isMfaRegistered,methodsRegistered", TOOL_ID),
    ]);
  } catch (err) {
    throw new Error(graphHint(err, "AuditLog.Read.All (and User.Read.All)"));
  }
  return classify(users, rows, { newDays });
}

module.exports = {
  id: TOOL_ID,
  label: "MFA coverage",
  schedule: "50 5 * * *", // daily at 05:50
  run,
  _test: { classify },
};
