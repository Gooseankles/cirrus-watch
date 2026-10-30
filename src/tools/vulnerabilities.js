// Known vulnerabilities (CVEs) that Microsoft Defender for Cloud found on
// machines and container images, one finding per CVE and subscription with the
// resources it is on. Ranked with free data (cveFeeds.js): CVEs on CISA's
// Known Exploited Vulnerabilities list first, then CVEs with a high EPSS
// score, then by Defender's severity. Subscriptions with machines or
// registries but no vulnerability assessment at all are flagged too. Reader is
// enough; the data itself needs a Defender plan that scans (Defender for
// Servers, Defender CSPM or Defender for Containers).
const { resourceGraphQuery } = require("../armClient");
const settings = require("../settings");
const cveFeeds = require("../cveFeeds");
const { numberSetting, runChecks, nameOf } = require("./util");

const TOOL_ID = "vulnerabilities";
const SEVERITIES = ["low", "medium", "high", "critical"];
const CVE_RE = /CVE-\d{4}-\d{4,7}/gi;
const NAMES_SHOWN = 5;
const nvdLink = (cve) => `https://nvd.nist.gov/vuln/detail/${cve}`;

// Defender assessments that hold vulnerability findings, by what they cover. A subscription with any of them
// (healthy or not) is scanned; the CVEs themselves are found by their text, so a new assessment still shows.
const MACHINE_ASSESSMENTS = [
  "ffff0522-1e88-47fc-8382-2a80ba848f5d", // Machines should have vulnerability findings resolved (Defender Vulnerability Management)
  "1195afff-c881-495e-9bc5-1486211ae03f", // Vulnerabilities in your virtual machines should be remediated (older scanners)
];
const IMAGE_ASSESSMENTS = [
  "c0b7cfc6-3172-465a-b378-53c7ff2cc0d5", // Azure registry container images should have vulnerabilities resolved
  "c609cf0f-71ab-41e9-a3c6-9a1f7fe1b8d5", // Azure running container images should have vulnerabilities resolved
  "dbd0cb49-b563-45e7-9724-889e799fa648", // Container registry images should have vulnerability findings resolved (older scanner)
  "41503391-efa5-47ee-9282-4eff6131462c", // Running container images should have vulnerability findings resolved (older scanner)
];

const minSeverity = () => {
  const raw = String(settings.get("CVE_MIN_SEVERITY") || "critical").trim().toLowerCase();
  if (raw === "off") return null;
  return SEVERITIES.includes(raw) ? raw : "critical";
};
const epssMin = () => numberSetting("CVE_EPSS_MIN", 0.1, { min: 0, max: 1 });

// One row per assessed resource, CVE text, severity and package; container images are counted, not listed.
// Sub-assessments come in three shapes: Defender Vulnerability Management (properties.id is the CVE, details under
// additionalData.vulnerabilityDetails and softwareDetails) and the older Qualys scanner (additionalData.cve is a
// list of CVEs, additionalData.patchable). The text is matched for CVE ids in code.
async function cveRows() {
  return resourceGraphQuery(
    `securityresources
    | where type =~ 'microsoft.security/assessments/subassessments'
    | where tostring(properties.status.code) =~ 'Unhealthy'
    | extend cveText = strcat(tostring(properties.id), ' ', tostring(properties.displayName), ' ', tostring(properties.additionalData.cve), ' ', tostring(properties.additionalData.vulnerabilityDetails.cveId))
    | where cveText contains 'CVE-'
    | extend target = tostring(split(id, '/providers/Microsoft.Security/assessments/')[0]),
        sev = tolower(tostring(properties.status.severity)),
        pkg = tostring(properties.additionalData.softwareDetails.packageName),
        fixed = tostring(properties.additionalData.softwareDetails.fixStatus) =~ 'FixAvailable' or tostring(properties.additionalData.patchable) =~ 'true',
        cvss = todouble(properties.additionalData.vulnerabilityDetails.cvss['3.0'].base)
    | summarize images = count(), fixes = countif(fixed), cvssMax = max(cvss) by subscriptionId, target, cveText, sev, pkg`,
    { toolId: TOOL_ID }
  );
}

// rows -> [{ subscriptionId, cve, targets: Set, sev, pkgs: Set, fix, cvss, images }], one per CVE and subscription.
// Pure, for the tests.
function groupByCve(rows) {
  const out = new Map();
  for (const r of rows) {
    const cves = new Set((String(r.cveText || "").match(CVE_RE) || []).map((c) => c.toUpperCase()));
    for (const cve of cves) {
      const key = `${r.subscriptionId}|${cve}`;
      let g = out.get(key);
      if (!g) {
        g = { subscriptionId: r.subscriptionId, cve, targets: new Set(), sev: "", pkgs: new Set(), fix: false, cvss: null, images: 0 };
        out.set(key, g);
      }
      g.targets.add(String(r.target || "").toLowerCase());
      if (SEVERITIES.indexOf(r.sev) > SEVERITIES.indexOf(g.sev)) g.sev = r.sev;
      if (r.pkg) g.pkgs.add(r.pkg);
      if (Number(r.fixes) > 0) g.fix = true;
      const cvss = Number(r.cvssMax);
      if (r.cvssMax !== null && r.cvssMax !== undefined && Number.isFinite(cvss) && (g.cvss === null || cvss > g.cvss)) g.cvss = cvss;
      if (/\/registries\//i.test(r.target || "")) g.images += Number(r.images) || 0;
    }
  }
  return [...out.values()];
}

// The kind for one CVE, or null when it is not listed: known exploited > likely exploited (EPSS) > severity.
// Pure, for the tests.
function classify(g, { kev, epss, epssFrom, sevFrom }) {
  if (kev[g.cve]) return "cve-known-exploited";
  if (epss[g.cve] !== undefined && epssFrom > 0 && epss[g.cve] >= epssFrom) return "cve-likely-exploited";
  if (!sevFrom) return null;
  const at = SEVERITIES.indexOf(g.sev);
  if (at < SEVERITIES.indexOf(sevFrom)) return null;
  return at >= SEVERITIES.indexOf("critical") ? "cve-critical" : `cve-${g.sev}`;
}

function listNames(targets) {
  const names = [...targets].map(nameOf).sort();
  const shown = names.slice(0, NAMES_SHOWN).join(", ");
  return names.length > NAMES_SHOWN ? `${shown} and ${names.length - NAMES_SHOWN} more` : shown;
}

// One finding. Pure, for the tests.
function toFinding(g, kind, { kev, epss }) {
  const n = g.targets.size;
  const parts = [`On ${n} resource${n === 1 ? "" : "s"}: ${listNames(g.targets)}${g.images ? ` (${g.images} container image${g.images === 1 ? "" : "s"})` : ""}.`];
  const facts = [];
  if (g.sev) facts.push(`severity ${g.sev}`);
  if (g.cvss !== null) facts.push(`CVSS ${g.cvss}`);
  if (epss[g.cve] !== undefined) facts.push(`EPSS ${Math.floor(epss[g.cve] * 1000 + 1e-9) / 10}%`); // rounded down: 0.99999 is not 100%
  if (facts.length) parts.push(`${facts.join(", ").replace(/^./, (c) => c.toUpperCase())}.`);
  const k = kev[g.cve];
  if (k) parts.push(`CISA known exploited${k.name ? `: ${k.name}` : ""} (added ${k.added}${k.ransomware ? ", used in ransomware" : ""}).`);
  parts.push(g.fix ? "A fix is available." : "No fix listed yet.");
  parts.push(nvdLink(g.cve));
  const pkgs = [...g.pkgs];
  const groups = new Set([...g.targets].map((t) => (t.match(/\/resourcegroups\/([^/]+)/) || [])[1]).filter(Boolean));
  return {
    kind,
    id: `/subscriptions/${g.subscriptionId}/providers/Microsoft.Security/vulnerabilities/${g.cve}`,
    name: pkgs.length === 1 ? `${g.cve} in ${pkgs[0]}` : g.cve,
    subscriptionId: g.subscriptionId,
    ...(groups.size === 1 && { resourceGroup: [...groups][0] }),
    cve: g.cve,
    resources: n,
    severity: g.sev || null,
    epss: epss[g.cve] ?? null,
    knownExploited: Boolean(k),
    fixAvailable: g.fix,
    detail: parts.join(" "),
  };
}

// { findings, targets }: targets are the assessed resources with CVE rows, for the coverage check.
async function cves() {
  const rows = await cveRows();
  const groups = groupByCve(rows);
  const { kev, note: kevNote } = await cveFeeds.loadKev();
  const { scores: epss, note: epssNote } = await cveFeeds.epss(groups.map((g) => g.cve));
  const feedNote = [kevNote, epssNote].filter(Boolean).join("; ");
  const opts = { kev, epss, epssFrom: epssMin(), sevFrom: minSeverity() };
  const findings = [];
  for (const g of groups) {
    const kind = classify(g, opts);
    if (kind) findings.push(toFinding(g, kind, opts));
  }
  // Worst first: known exploited, likely exploited, then by severity; within each, the higher EPSS and more resources.
  const rank = (f) => ["cve-known-exploited", "cve-likely-exploited", "cve-critical", "cve-high", "cve-medium", "cve-low"].indexOf(f.kind);
  findings.sort((a, b) => rank(a) - rank(b) || (b.epss ?? -1) - (a.epss ?? -1) || b.resources - a.resources);
  if (feedNote) {
    findings.push({ kind: "cve-feed-note", id: `${TOOL_ID}/feeds`, name: "CVE ranking data", detail: `${feedNote}. Findings still come from Defender; only the ranking is affected` });
  }
  return { findings, targets: new Set(rows.map((r) => String(r.target || "").toLowerCase())) };
}

// Subscriptions with machines or registries that Defender does not scan for vulnerabilities. Pure, for the tests.
// counts: [{ subscriptionId, machines, registries }]; assessed: [{ subscriptionId, akey }]; scannedSubs: { machines:
// Set, images: Set } of subscriptions with CVE rows.
function judgeCoverage(counts, assessed, scannedSubs) {
  const has = (subId, keys) => assessed.some((a) => a.subscriptionId === subId && keys.includes(String(a.akey).toLowerCase()));
  const findings = [];
  for (const c of counts) {
    const m = Number(c.machines) || 0;
    const r = Number(c.registries) || 0;
    if (m && !has(c.subscriptionId, MACHINE_ASSESSMENTS) && !scannedSubs.machines.has(c.subscriptionId)) {
      findings.push({
        kind: "cve-no-data",
        id: `/subscriptions/${c.subscriptionId}/providers/Microsoft.Security/vulnerabilities/no-data-machines`,
        name: "Machines not scanned for vulnerabilities",
        subscriptionId: c.subscriptionId,
        resources: m,
        detail: `${m} machine${m === 1 ? "" : "s"} (VMs, scale sets, Arc servers) but no vulnerability assessment from Defender. Turn on Defender for Servers (Plan 1 or 2) or Defender CSPM, which scans without an agent`,
      });
    }
    if (r && !has(c.subscriptionId, IMAGE_ASSESSMENTS) && !scannedSubs.images.has(c.subscriptionId)) {
      findings.push({
        kind: "cve-no-data",
        id: `/subscriptions/${c.subscriptionId}/providers/Microsoft.Security/vulnerabilities/no-data-images`,
        name: "Container images not scanned for vulnerabilities",
        subscriptionId: c.subscriptionId,
        resources: r,
        detail: `${r} container registr${r === 1 ? "y" : "ies"} but no image vulnerability assessment from Defender. Turn on Defender for Containers or Defender CSPM`,
      });
    }
  }
  return findings;
}

async function coverage(scannedTargets) {
  const [counts, assessed] = await Promise.all([
    resourceGraphQuery(
      `Resources
      | where type in~ ('microsoft.compute/virtualmachines', 'microsoft.compute/virtualmachinescalesets', 'microsoft.hybridcompute/machines', 'microsoft.containerregistry/registries')
      | summarize machines = countif(type !~ 'microsoft.containerregistry/registries'), registries = countif(type =~ 'microsoft.containerregistry/registries') by subscriptionId`,
      { toolId: TOOL_ID }
    ),
    resourceGraphQuery(
      `securityresources
      | where type =~ 'microsoft.security/assessments'
      | where name in~ (${[...MACHINE_ASSESSMENTS, ...IMAGE_ASSESSMENTS].map((k) => `'${k}'`).join(", ")})
      | summarize n = count() by subscriptionId, akey = tolower(name)`,
      { toolId: TOOL_ID }
    ),
  ]);
  const scannedSubs = { machines: new Set(), images: new Set() };
  for (const t of scannedTargets) {
    const sub = (t.match(/^\/subscriptions\/([^/]+)/) || [])[1];
    if (!sub) continue;
    if (/\/registries\//.test(t)) scannedSubs.images.add(sub);
    else scannedSubs.machines.add(sub);
  }
  return judgeCoverage(counts, assessed, scannedSubs);
}

async function run() {
  const cveRun = cves();
  return runChecks(TOOL_ID, {
    CVEs: async () => (await cveRun).findings,
    // Waits for the CVE rows: a subscription with CVEs on its machines counts as scanned, whatever the assessment.
    Coverage: async () => coverage(await cveRun.then((r) => r.targets, () => new Set())),
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Vulnerabilities (CVEs)",
  schedule: "55 6 * * *", // daily at 06:55, after Defender for Cloud
  run,
  _test: { groupByCve, classify, toFinding, judgeCoverage },
};
