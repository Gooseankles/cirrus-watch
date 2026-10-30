// The Vulnerabilities (CVEs) scan: grouping Defender's sub-assessment rows by CVE,
// ranking with the CISA and EPSS data, the finding text, and the coverage check.
// Plain data in, no Azure and no network.
const { test, after } = require("node:test");
const assert = require("node:assert/strict");

const env = require("./_env");
const { groupByCve, classify, toFinding, judgeCoverage } = require("../src/tools/vulnerabilities")._test;
const { parseKev, parseEpss } = require("../src/cveFeeds")._test;

after(env.cleanup);

const VM1 = "/subscriptions/s1/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/vm1";
const VM2 = "/subscriptions/s1/resourceGroups/rg-app/providers/Microsoft.Compute/virtualMachines/vm2";
const ACR = "/subscriptions/s1/resourceGroups/rg-build/providers/Microsoft.ContainerRegistry/registries/acr1";

// One row per shape the query returns: Defender Vulnerability Management (CVE as the id), the older scanner (a list
// of CVEs in additionalData.cve), and a registry with several images.
const rows = [
  { subscriptionId: "s1", target: VM1, cveText: "CVE-2024-3094 CVE-2024-3094  ", sev: "critical", pkg: "xz-utils", images: 1, fixes: 1, cvssMax: 10 },
  { subscriptionId: "s1", target: VM2, cveText: "CVE-2024-3094 CVE-2024-3094  ", sev: "high", pkg: "xz-utils", images: 1, fixes: 0, cvssMax: null },
  { subscriptionId: "s1", target: VM2, cveText: "105489 OpenSSL [{\"title\":\"CVE-2022-0778\"},{\"title\":\"cve-2023-0286\"}] ", sev: "medium", pkg: "", images: 1, fixes: 1, cvssMax: null },
  { subscriptionId: "s1", target: ACR, cveText: "CVE-2023-44487 CVE-2023-44487  CVE-2023-44487", sev: "high", pkg: "golang.org/x/net", images: 4, fixes: 4, cvssMax: 7.5 },
  { subscriptionId: "s2", target: "/subscriptions/s2/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm9", cveText: "CVE-2024-3094", sev: "critical", pkg: "xz-utils", images: 1, fixes: 0, cvssMax: 10 },
];

test("groups rows by CVE and subscription, keeping the worst severity, any fix and the highest CVSS", () => {
  const groups = groupByCve(rows);
  const xz = groups.find((g) => g.subscriptionId === "s1" && g.cve === "CVE-2024-3094");
  assert.equal(xz.targets.size, 2);
  assert.equal(xz.sev, "critical");
  assert.equal(xz.fix, true);
  assert.equal(xz.cvss, 10);
  assert.deepEqual([...xz.pkgs], ["xz-utils"]);
  // The older scanner's list gives two CVEs, lower-case ids are normalised.
  assert.ok(groups.find((g) => g.cve === "CVE-2022-0778"));
  assert.ok(groups.find((g) => g.cve === "CVE-2023-0286"));
  // Images are counted for registries only.
  assert.equal(groups.find((g) => g.cve === "CVE-2023-44487").images, 4);
  assert.equal(xz.images, 0);
  // The same CVE in another subscription is its own group.
  assert.equal(groups.filter((g) => g.cve === "CVE-2024-3094").length, 2);
});

test("ranks known exploited, then EPSS, then severity from the setting", () => {
  const g = (cve, sev) => ({ cve, sev });
  const opts = { kev: { "CVE-1111-0001": {} }, epss: { "CVE-1111-0002": 0.4, "CVE-1111-0003": 0.01 }, epssFrom: 0.1, sevFrom: "critical" };
  assert.equal(classify(g("CVE-1111-0001", "low"), opts), "cve-known-exploited");
  assert.equal(classify(g("CVE-1111-0002", "medium"), opts), "cve-likely-exploited");
  assert.equal(classify(g("CVE-1111-0003", "critical"), opts), "cve-critical");
  assert.equal(classify(g("CVE-1111-0003", "high"), opts), null);
  assert.equal(classify(g("CVE-1111-0003", "high"), { ...opts, sevFrom: "high" }), "cve-high");
  assert.equal(classify(g("CVE-1111-0003", ""), { ...opts, sevFrom: "low" }), null);
  // EPSS 0 turns the EPSS rank off; severity off lists only the ranked ones.
  assert.equal(classify(g("CVE-1111-0002", "medium"), { ...opts, epssFrom: 0 }), null);
  assert.equal(classify(g("CVE-1111-0003", "critical"), { ...opts, sevFrom: null }), null);
});

test("the finding names the resources, the facts and the fix, with a stable id", () => {
  const xz = groupByCve(rows).find((g) => g.subscriptionId === "s1" && g.cve === "CVE-2024-3094");
  const kev = { "CVE-2024-3094": { name: "XZ Utils Embedded Malicious Code", added: "2024-03-29", ransomware: false } };
  const f = toFinding(xz, "cve-known-exploited", { kev, epss: { "CVE-2024-3094": 0.857 } });
  assert.equal(f.id, "/subscriptions/s1/providers/Microsoft.Security/vulnerabilities/CVE-2024-3094");
  assert.equal(f.name, "CVE-2024-3094 in xz-utils");
  assert.equal(f.resourceGroup, "rg-app");
  assert.equal(f.resources, 2);
  assert.equal(f.knownExploited, true);
  assert.match(f.detail, /^On 2 resources: vm1, vm2\. Severity critical, CVSS 10, EPSS 85\.7%\. CISA known exploited: XZ Utils/);
  assert.match(f.detail, /A fix is available\. https:\/\/nvd\.nist\.gov\/vuln\/detail\/CVE-2024-3094$/);

  const acr = groupByCve(rows).find((g) => g.cve === "CVE-2023-44487");
  const a = toFinding(acr, "cve-high", { kev: {}, epss: {} });
  assert.match(a.detail, /^On 1 resource: acr1 \(4 container images\)\. Severity high, CVSS 7\.5\. A fix/);
});

test("long resource lists are cut after five names", () => {
  const targets = new Set(Array.from({ length: 8 }, (_, i) => `/subscriptions/s1/resourceGroups/rg${i}/providers/x/vm${i}`));
  const f = toFinding({ subscriptionId: "s1", cve: "CVE-2020-0001", targets, sev: "", pkgs: new Set(["a", "b"]), fix: false, cvss: null, images: 0 }, "cve-critical", { kev: {}, epss: {} });
  assert.match(f.detail, /vm0, vm1, vm2, vm3, vm4 and 3 more\. No fix listed yet\./);
  assert.equal(f.name, "CVE-2020-0001");
  assert.equal(f.resourceGroup, undefined);
});

test("coverage flags machines and registries Defender does not scan", () => {
  const counts = [
    { subscriptionId: "s1", machines: 3, registries: 1 },
    { subscriptionId: "s2", machines: 2, registries: 0 },
    { subscriptionId: "s3", machines: 1, registries: 2 },
  ];
  const assessed = [{ subscriptionId: "s1", akey: "ffff0522-1e88-47fc-8382-2a80ba848f5d" }, { subscriptionId: "s1", akey: "c0b7cfc6-3172-465a-b378-53c7ff2cc0d5" }];
  // s2 has CVE rows on a machine, so it counts as scanned without a known assessment.
  const findings = judgeCoverage(counts, assessed, { machines: new Set(["s2"]), images: new Set() });
  assert.deepEqual(
    findings.map((f) => f.id.split("/vulnerabilities/")[1] + "@" + f.subscriptionId),
    ["no-data-machines@s3", "no-data-images@s3"]
  );
  assert.match(findings[1].detail, /^2 container registries/);
});

test("parses CISA's list and FIRST's scores, skipping bad rows", () => {
  const kev = parseKev({
    vulnerabilities: [
      { cveID: "CVE-2024-3094", vulnerabilityName: "XZ", dateAdded: "2024-03-29", dueDate: "2024-04-19", knownRansomwareCampaignUse: "Unknown" },
      { cveID: "cve-2023-4966", vulnerabilityName: "Citrix Bleed", dateAdded: "2023-10-18", knownRansomwareCampaignUse: "Known" },
      { cveID: "not a cve" },
    ],
  });
  assert.deepEqual(Object.keys(kev).sort(), ["CVE-2023-4966", "CVE-2024-3094"]);
  assert.equal(kev["CVE-2023-4966"].ransomware, true);
  assert.equal(kev["CVE-2024-3094"].ransomware, false);
  assert.deepEqual(parseKev(null), {});

  assert.deepEqual(parseEpss({ data: [{ cve: "CVE-2024-3094", epss: "0.85700" }, { cve: "CVE-2020-1", epss: "x" }, { cve: "bad", epss: "0.5" }] }), { "CVE-2024-3094": 0.857 });
});
