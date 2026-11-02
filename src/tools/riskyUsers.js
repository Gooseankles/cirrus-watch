// Users Microsoft Entra ID Protection marks as risky and nobody has dealt with:
// risk state confirmedCompromised, or atRisk at risk level high or medium.
// Remediated, dismissed and confirmed-safe users are left out, as are low risk
// and deleted users. Oldest first (the longest left alone), compromised and
// high before medium, at most RISKY_USERS_MAX findings.
// Extra Graph check, on by default (extraChecks.js): Graph IdentityRiskyUser.Read.All. Risk detections
// are not read, so IdentityRiskEvent.Read.All is not needed. Reading risky
// users needs Microsoft Entra ID P2; without it the run notes that and reports
// nothing. GET /identityProtection/riskyUsers takes $filter and $top (500 at
// most) but no $orderby, so the sort is done here.
const log = require("../log");
const { graphGet } = require("../graphClient");
const { numberSetting } = require("./util");
const { isOn, noPremium, refused, permissionMissing } = require("./extraChecks");

const TOOL_ID = "risky-users";
const LABEL = "Risky users";
const STATES = ["confirmedCompromised", "atRisk"];
const MAX_PAGES = 4; // per state, 500 users a page
const DEFAULT_MAX = 50;

const RANK = { compromised: 0, high: 1, medium: 2 };

// riskyUser -> "compromised" | "high" | "medium" | null (not reported). Pure.
function classify(u) {
  if (!u || u.isDeleted) return null;
  if (u.riskState === "confirmedCompromised") return "compromised";
  if (u.riskState !== "atRisk") return null;
  if (u.riskLevel === "high") return "high";
  if (u.riskLevel === "medium") return "medium";
  return null;
}

// riskyUser records -> findings, worst and oldest first, capped. Pure.
function riskyFindings(users, max = DEFAULT_MAX, now = Date.now()) {
  const seen = new Set();
  const rows = [];
  for (const u of users || []) {
    if (!u || seen.has(u.id)) continue;
    seen.add(u.id);
    const level = classify(u);
    if (level) rows.push({ u, level });
  }
  rows.sort((a, b) => RANK[a.level] - RANK[b.level] || String(a.u.riskLastUpdatedDateTime || "").localeCompare(String(b.u.riskLastUpdatedDateTime || "")));
  const kept = rows.slice(0, max);
  const findings = kept.map(({ u, level }) => {
    const since = u.riskLastUpdatedDateTime ? Math.max(0, Math.floor((now - Date.parse(u.riskLastUpdatedDateTime)) / 86400000)) : null;
    const what = level === "compromised" ? "An admin confirmed this account as compromised" : `ID Protection rates this account ${level} risk`;
    return {
      kind: `risky-user-${level}`,
      id: `${TOOL_ID}/${u.id}`,
      name: u.userPrincipalName || u.userDisplayName || u.id,
      detail: `${what} (state ${u.riskState}${u.riskDetail && u.riskDetail !== "none" ? `, ${u.riskDetail}` : ""})${since !== null ? `, last changed ${since} day(s) ago` : ""}. Not remediated: reset the password or revoke sessions, check the sign-ins, then confirm safe or dismiss in Entra ID Protection`,
      resourceGroup: null,
      subscriptionId: null,
      principalId: u.id,
    };
  });
  return { findings, total: rows.length };
}

async function readState(state) {
  const filter = encodeURIComponent(`riskState eq '${state}'`);
  let next = `/identityProtection/riskyUsers?$filter=${filter}&$top=500`;
  const rows = [];
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const data = await graphGet(next, TOOL_ID);
    rows.push(...(data.value || []));
    next = data["@odata.nextLink"] || null;
  }
  if (next) log.record({ tool: TOOL_ID, level: "info", message: `Risky users: more than ${rows.length} users in state ${state}, only the first ${rows.length} were read` });
  return rows;
}

async function run() {
  if (!isOn(TOOL_ID)) return [];
  let users = [];
  try {
    for (const state of STATES) users = users.concat(await readState(state));
  } catch (err) {
    if (noPremium(err)) {
      log.record({ tool: TOOL_ID, level: "info", message: "Risky users not checked: Entra ID Protection risk data needs Microsoft Entra ID P2 in this tenant" });
      return [];
    }
    if (refused(err)) return permissionMissing(TOOL_ID, LABEL, err);
    throw err;
  }
  const max = numberSetting("RISKY_USERS_MAX", DEFAULT_MAX, { min: 1, max: 1000 });
  const { findings, total } = riskyFindings(users, max);
  if (total > findings.length) {
    log.record({ tool: TOOL_ID, level: "info", message: `Risky users: ${total} users at risk, the ${findings.length} worst and oldest are listed (RISKY_USERS_MAX)` });
  }
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: LABEL,
  schedule: "35 5 * * *", // daily at 05:35
  run,
  _test: { classify, riskyFindings },
};
