// Free CVE data that ranks what Defender for Cloud finds (tools/vulnerabilities.js):
// CISA's Known Exploited Vulnerabilities list (CVEs attacked in the wild) and
// FIRST's EPSS score (how likely a CVE is to be exploited in the next 30 days).
// Neither needs a key. Fetched at most once a day and kept in
// DATA_DIR/cve-feeds.json; when a feed cannot be reached the last copy is used.
// CVE_FEEDS = off uses neither (findings then rank by Defender's severity only).
const fs = require("fs");
const path = require("path");
const settings = require("./settings");
const { DATA_DIR } = require("./paths");
const { writeAtomic } = require("./jsonFile");

const KEV_URL = "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";
const EPSS_URL = "https://api.first.org/data/v1/epss";
const FILE = path.join(DATA_DIR, "cve-feeds.json");
const TTL_MS = 24 * 3600 * 1000;
const EPSS_BATCH = 100;
const EPSS_MAX = 3000; // CVEs scored per run; the rest rank by severity only
const CVE_RE = /^CVE-\d{4}-\d{4,7}$/;

const enabled = () => !/^(off|no|false|0)$/i.test(String(settings.get("CVE_FEEDS") || "").trim());

function readKept() {
  try {
    const kept = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return kept && typeof kept === "object" ? kept : {};
  } catch {
    return {};
  }
}

function save(kept) {
  try {
    writeAtomic(FILE, kept);
  } catch {
    // still usable for this run
  }
}

// { "CVE-…": { name, added, due, ransomware } } from CISA's JSON. Pure, for the tests.
function parseKev(json) {
  const out = {};
  for (const v of (json && json.vulnerabilities) || []) {
    const id = String((v && v.cveID) || "").toUpperCase();
    if (!CVE_RE.test(id)) continue;
    out[id] = {
      name: String(v.vulnerabilityName || "").slice(0, 200),
      added: v.dateAdded || "",
      due: v.dueDate || "",
      ransomware: /^known$/i.test(String(v.knownRansomwareCampaignUse || "")),
    };
  }
  return out;
}

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

let pendingKev = null;

// { kev: { "CVE-…": {...} }, source, fetchedAt, note }; source "CISA", "kept copy" or "none".
async function loadKev() {
  if (!enabled()) return { kev: {}, source: "none", fetchedAt: null, note: "CVE feeds turned off (CVE_FEEDS)" };
  const kept = readKept();
  if (kept.kev && Date.now() - Date.parse(kept.kevAt) < TTL_MS) return { kev: kept.kev, source: "CISA", fetchedAt: kept.kevAt, note: "" };
  if (!pendingKev) {
    pendingKev = getJson(KEV_URL)
      .then((json) => ({ kev: parseKev(json) }))
      .catch((err) => ({ error: err.message }))
      .finally(() => {
        pendingKev = null;
      });
  }
  const got = await pendingKev;
  if (got.kev && Object.keys(got.kev).length) {
    const now = new Date().toISOString();
    save({ ...readKept(), kev: got.kev, kevAt: now });
    return { kev: got.kev, source: "CISA", fetchedAt: now, note: "" };
  }
  const why = got.error || "empty list";
  if (kept.kev) return { kev: kept.kev, source: "kept copy", fetchedAt: kept.kevAt, note: `CISA list unreachable (${why}); using the copy from ${String(kept.kevAt).slice(0, 10)}` };
  return { kev: {}, source: "none", fetchedAt: null, note: `CISA list unreachable (${why}); known-exploited CVEs not marked` };
}

// { "CVE-…": 0.0-1.0 } from FIRST's reply. Pure, for the tests.
function parseEpss(json) {
  const out = {};
  for (const r of (json && json.data) || []) {
    const id = String((r && r.cve) || "").toUpperCase();
    const score = Number(r && r.epss);
    if (CVE_RE.test(id) && Number.isFinite(score)) out[id] = score;
  }
  return out;
}

// EPSS scores for these CVEs: { scores, note }. Scores less than a day old come from the kept copy; the rest are
// asked for in batches. A CVE FIRST does not know (too new or rejected) is simply missing.
async function epss(cves) {
  if (!enabled()) return { scores: {}, note: "" };
  const kept = readKept();
  const cache = kept.epss || {};
  const fresh = (id) => cache[id] && Date.now() - Date.parse(cache[id].at) < TTL_MS;
  const wanted = [...new Set(cves.map((c) => String(c).toUpperCase()).filter((c) => CVE_RE.test(c)))];
  const ask = wanted.filter((id) => !fresh(id)).slice(0, EPSS_MAX);
  const failed = [];
  const now = new Date().toISOString();
  for (let i = 0; i < ask.length; i += EPSS_BATCH) {
    const batch = ask.slice(i, i + EPSS_BATCH);
    try {
      const got = parseEpss(await getJson(`${EPSS_URL}?cve=${batch.join(",")}`));
      // Known to FIRST or not, remember the answer so the CVE is not asked for again today.
      for (const id of batch) cache[id] = { score: got[id] ?? null, at: now };
    } catch (err) {
      failed.push(err.message);
      if (failed.length >= 3) break; // FIRST is down: stop asking
    }
  }
  if (ask.length) {
    // Drop scores older than a week so the file does not grow forever.
    for (const [id, v] of Object.entries(cache)) if (Date.now() - Date.parse(v.at) > 7 * TTL_MS) delete cache[id];
    save({ ...readKept(), epss: cache });
  }
  const scores = {};
  for (const id of wanted) if (cache[id] && cache[id].score !== null && cache[id].score !== undefined) scores[id] = cache[id].score;
  const skipped = wanted.filter((id) => !fresh(id)).length - ask.length;
  const notes = [];
  if (failed.length) notes.push(`EPSS not fetched for some CVEs (${failed[0]}); older scores used where kept`);
  if (skipped > 0) notes.push(`${skipped} CVEs over the ${EPSS_MAX} scored per run have no EPSS score`);
  return { scores, note: notes.join("; ") };
}

module.exports = { loadKev, epss, _test: { parseKev, parseEpss } };
