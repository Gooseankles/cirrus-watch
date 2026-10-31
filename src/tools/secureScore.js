// Microsoft Secure Score (Microsoft 365 / Defender XDR, not Defender for
// Cloud's score). One tenant finding when the score fell by at least
// SECURE_SCORE_DROP_POINTS percentage points against the snapshot about a week
// older, and, for information, the five open improvement actions worth the most
// points. Always one info finding with the current score, so the page shows it.
// Opt-in (extraChecks.js): Graph SecurityEvents.Read.All.
//   GET /security/secureScores?$top=8   daily snapshots, newest first
//   GET /security/secureScoreControlProfiles   the improvement actions
// A control is open when it is not deprecated, its latest state is not Ignored
// (risk accepted) or ThirdParty, and the newest snapshot gives it fewer points
// than its maxScore. Profile id = the snapshot's controlName.
const log = require("../log");
const { graphGet, graphGetAll } = require("../graphClient");
const { numberSetting } = require("./util");
const { isOn, refused, permissionMissing } = require("./extraChecks");

const TOOL_ID = "secure-score";
const LABEL = "Microsoft Secure Score";
const TOP_CONTROLS = 5;
const WEEK_MS = 7 * 86400000;
const DAY_MS = 86400000;

const pct = (s) => (s && Number(s.maxScore) > 0 ? (Number(s.currentScore) / Number(s.maxScore)) * 100 : null);
const round1 = (n) => Math.round(n * 10) / 10;
const day = (t) => String(t || "").slice(0, 10);

// Snapshots (any order) -> { latest, previous } where previous is the newest
// snapshot at least 6 days older than latest (so a missed day still counts). Pure.
function pickWeek(snapshots) {
  const list = (snapshots || []).filter((s) => s && s.createdDateTime && pct(s) !== null).sort((a, b) => String(b.createdDateTime).localeCompare(String(a.createdDateTime)));
  const latest = list[0] || null;
  if (!latest) return { latest: null, previous: null };
  const cutoff = Date.parse(latest.createdDateTime) - (WEEK_MS - DAY_MS);
  const previous = list.find((s) => Date.parse(s.createdDateTime) <= cutoff) || null;
  return { latest, previous };
}

// -> findings for the score itself. Pure.
function scoreFindings(latest, previous, dropPoints) {
  if (!latest) return [];
  const now = pct(latest);
  const out = [{
    kind: "secure-score-current",
    id: `${TOOL_ID}/current`,
    name: `Secure Score ${round1(now)}%`,
    detail: `${round1(Number(latest.currentScore))} of ${round1(Number(latest.maxScore))} points on ${day(latest.createdDateTime)}${previous ? ` (${round1(pct(previous))}% on ${day(previous.createdDateTime)})` : ""}. For information`,
    resourceGroup: null,
    subscriptionId: null,
  }];
  if (previous && dropPoints > 0) {
    const drop = pct(previous) - now;
    if (drop >= dropPoints) {
      out.push({
        kind: "secure-score-drop",
        id: `${TOOL_ID}/drop`,
        name: `Secure Score fell ${round1(drop)} points in a week`,
        detail: `From ${round1(pct(previous))}% on ${day(previous.createdDateTime)} to ${round1(now)}% on ${day(latest.createdDateTime)} (threshold ${dropPoints} points). A setting was turned off, an improvement action regressed or new controls were added: see the history in the Microsoft Defender portal (Exposure management, Secure Score)`,
        resourceGroup: null,
        subscriptionId: null,
      });
    }
  }
  return out;
}

const latestState = (p) => {
  const ups = (p.controlStateUpdates || []).filter((u) => u && u.state);
  ups.sort((a, b) => String(b.updatedDateTime || "").localeCompare(String(a.updatedDateTime || "")));
  return ups.length ? ups[0].state : "Default";
};

// The open controls worth the most points, at most `top`. Pure.
function openControls(latest, profiles, top = TOP_CONTROLS) {
  if (!latest) return [];
  const scores = new Map((latest.controlScores || []).map((c) => [String(c.controlName).toLowerCase(), Number(c.score) || 0]));
  const open = [];
  for (const p of profiles || []) {
    if (!p || p.deprecated) continue;
    const key = String(p.id || "").toLowerCase();
    if (!scores.has(key)) continue; // not scored in this tenant
    if (/^(ignored|thirdparty)$/i.test(latestState(p))) continue;
    const left = (Number(p.maxScore) || 0) - scores.get(key);
    if (left > 0.01) open.push({ p, left });
  }
  open.sort((a, b) => b.left - a.left || (Number(a.p.rank) || 9999) - (Number(b.p.rank) || 9999));
  return open.slice(0, top).map(({ p, left }) => {
    const about = [p.service, p.userImpact && `user impact ${p.userImpact}`, p.implementationCost && `cost ${p.implementationCost}`].filter(Boolean);
    return {
      kind: "secure-score-control-open",
      id: `${TOOL_ID}/controls/${p.id}`,
      name: p.title || p.id,
      detail: `${round1(left)} of ${round1(Number(p.maxScore))} points open${about.length ? ` (${about.join(", ")})` : ""}.${p.actionUrl ? ` ${p.actionUrl}` : ""} For information`,
      resourceGroup: null,
      subscriptionId: null,
    };
  });
}

async function run() {
  if (!isOn(TOOL_ID)) return [];
  let snapshots;
  let profiles;
  try {
    snapshots = (await graphGet("/security/secureScores?$top=8", TOOL_ID)).value || [];
    profiles = await graphGetAll("/security/secureScoreControlProfiles", TOOL_ID);
  } catch (err) {
    if (refused(err)) return permissionMissing(TOOL_ID, LABEL, err);
    throw err;
  }
  const { latest, previous } = pickWeek(snapshots);
  if (!latest) {
    log.record({ tool: TOOL_ID, level: "info", message: "Microsoft Secure Score: no score snapshots in this tenant yet (the first one appears a day after Microsoft 365 or Entra ID is set up)" });
    return [];
  }
  const drop = numberSetting("SECURE_SCORE_DROP_POINTS", 5, { min: 0, max: 100 });
  return [...scoreFindings(latest, previous, drop), ...openControls(latest, profiles)];
}

module.exports = {
  id: TOOL_ID,
  label: LABEL,
  schedule: "30 6 * * *", // daily at 06:30 (Microsoft updates the score once a day)
  run,
  _test: { pickWeek, scoreFindings, openControls, pct },
};
