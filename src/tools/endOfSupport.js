// Software that is out of support or soon will be: AKS Kubernetes versions,
// App Service language runtimes, VM operating systems, and services that still
// accept TLS 1.0/1.1. Reader is enough. Runtime and OS dates come from
// endoflife.date when it can be reached (eolDates.js); the tables below are the
// fallback and fill gaps.
const { resourceGraphQuery, armGet } = require("../armClient");
const { numberSetting, mapLimit, runChecks, itemErrors, scanError, daysUntil } = require("./util");
const eolDates = require("../eolDates");
const log = require("../log");

const TOOL_ID = "end-of-support";
const CONCURRENCY = 6;
const MAX_SITES = 800;

// Built-in upstream end-of-life dates (App Service follows them), used when
// endoflife.date has none. Newer versions than these are only flagged with the
// live dates.
const RUNTIME_EOL = {
  node: { 12: "2022-04-30", 14: "2023-04-30", 16: "2023-09-11", 18: "2025-04-30", 20: "2026-04-30", 22: "2027-04-30", 24: "2028-04-30", 26: "2029-04-30" },
  python: { "3.6": "2021-12-23", "3.7": "2023-06-27", "3.8": "2024-10-07", "3.9": "2025-10-31", "3.10": "2026-10-31", "3.11": "2027-10-31", "3.12": "2028-10-31", "3.13": "2029-10-31" },
  dotnet: { "3.1": "2022-12-13", 5: "2022-05-10", 6: "2024-11-12", 7: "2024-05-14", 8: "2026-11-10", 9: "2026-11-10", 10: "2028-11-14" },
  php: { "7.4": "2022-11-28", "8.0": "2023-11-26", "8.1": "2025-12-31", "8.2": "2026-12-31", "8.3": "2027-12-31", "8.4": "2028-12-31" },
};
const RUNTIME_LABEL = { node: "Node.js", python: "Python", dotnet: ".NET", php: "PHP" };

// Windows Server release year -> end of extended support.
const WINDOWS_EOL = { 2008: "2020-01-14", 2012: "2023-10-10", 2016: "2027-01-12", 2019: "2029-01-09", 2022: "2031-10-14", 2025: "2034-11-14" };
// [pattern on "offer sku osName osVersion", OS name, end of standard support]
const LINUX_EOL = [
  [/ubuntu.*(14[._]04|trusty)/, "Ubuntu 14.04", "2019-04-30"],
  [/ubuntu.*(16[._]04|xenial)/, "Ubuntu 16.04", "2021-04-30"],
  [/ubuntu.*(18[._]04|bionic)/, "Ubuntu 18.04", "2023-05-31"],
  [/ubuntu.*(20[._]04|focal)/, "Ubuntu 20.04", "2025-05-31"],
  [/ubuntu.*(22[._]04|jammy)/, "Ubuntu 22.04", "2027-06-01"],
  [/centos/, "CentOS", "2024-06-30"],
  [/(rhel|red ?hat).*\b(6|7)(\d?[-_.]|\b)/, "Red Hat Enterprise Linux 7 or older", "2024-06-30"],
  [/debian.*\b(8|9|jessie|stretch)\b/, "Debian 9 or older", "2022-06-30"],
  [/debian.*\b(10|buster)\b/, "Debian 10", "2024-06-30"],
  [/debian.*\b(11|bullseye)\b/, "Debian 11", "2026-08-31"],
  [/sles.*\b12\b/, "SUSE Linux Enterprise 12", "2024-10-31"],
];

// Linux release from image text, for the live dates: [our product key, label, pattern]. The
// pattern's first group is the release (endoflife.date's name); codenames are mapped first.
const CODENAMES = {
  trusty: "14.04", xenial: "16.04", bionic: "18.04", focal: "20.04", jammy: "22.04", noble: "24.04",
  jessie: "8", stretch: "9", buster: "10", bullseye: "11", bookworm: "12", trixie: "13",
};
const LINUX_LIVE = [
  ["ubuntu", "Ubuntu", /ubuntu/, /(?:^|\D)(\d{2})[._](04|10)(?:\D|$)/, (m) => `${m[1]}.${m[2]}`],
  ["debian", "Debian", /debian/, /(?:^|[\s_-])(\d{1,2})(?=[\s._-]|$)/, (m) => m[1]],
  ["rhel", "Red Hat Enterprise Linux", /rhel|red ?hat/, /(?:^|[\s_-])(\d{1,2})(?=[\s._-]|$)/, (m) => m[1]],
  ["centos", "CentOS", /centos/, /(?:^|[\s_-])(\d{1,2})(?=[\s._-]|$)/, (m) => m[1]],
  ["sles", "SUSE Linux Enterprise", /sles|suse/, /(?:^|\D)(1\d)(?:\D|$)/, (m) => m[1]],
];

// Dates for this run: endoflife.date's tables (empty when not reachable).
let live = {};

const warnDays = () => numberSetting("EOS_WARN_DAYS", 180, { min: 0, max: 3650 });

// Past = crit kind, within the warning window = warn kind, later = nothing.
function dated(kindPast, kindSoon, endDate, extra) {
  const days = daysUntil(endDate);
  if (days < 0) return { kind: kindPast, expires: endDate, ...extra };
  if (days <= warnDays()) return { kind: kindSoon, expires: endDate, ...extra };
  return null;
}

/* AKS: compare with the versions Azure still supports in that region. */
async function aksFindings() {
  const clusters = await resourceGraphQuery(
    `Resources
    | where type =~ 'microsoft.containerservice/managedclusters'
    | project id, name, resourceGroup, subscriptionId, location,
        version = tostring(coalesce(properties.currentKubernetesVersion, properties.kubernetesVersion)),
        plan = tostring(properties.supportPlan)`,
    { toolId: TOOL_ID }
  );
  const pairs = [...new Set(clusters.map((c) => `${c.subscriptionId}|${c.location}`))];
  const supported = new Map(); // sub|loc -> { official: [minor], lts: [minor] }
  const failures = await mapLimit(pairs, CONCURRENCY, async (pair) => {
    const [sub, loc] = pair.split("|");
    const data = await armGet(`https://management.azure.com/subscriptions/${sub}/providers/Microsoft.ContainerService/locations/${loc}/kubernetesVersions?api-version=2024-02-01`, TOOL_ID);
    const official = [], lts = [];
    for (const v of data.values || []) {
      if (v.isPreview) continue;
      const plans = (v.capabilities || {}).supportPlan || [];
      if (plans.includes("KubernetesOfficial")) official.push(v.version);
      if (plans.includes("AKSLongTermSupport")) lts.push(v.version);
    }
    supported.set(pair, { official, lts });
  });
  const minor = (v) => String(v || "").split(".").slice(0, 2).join(".");
  const cmp = (a, b) => a.localeCompare(b, "en", { numeric: true });
  const findings = [];
  for (const c of clusters) {
    const s = supported.get(`${c.subscriptionId}|${c.location}`);
    if (!s || !s.official.length) continue;
    const m = minor(c.version);
    const base = { name: c.name, resourceGroup: c.resourceGroup, subscriptionId: c.subscriptionId };
    const isLts = c.plan === "AKSLongTermSupport" && s.lts.includes(m);
    const oldest = [...s.official].sort(cmp)[0];
    if (!s.official.includes(m) && !isLts) {
      findings.push({ ...base, kind: "aks-unsupported", id: `${c.id}#aks-version`, detail: `Kubernetes ${c.version} is out of AKS support in ${c.location}. Supported: ${[...s.official].sort(cmp).join(", ")}` });
    } else if (!isLts && m === oldest) {
      findings.push({ ...base, kind: "aks-oldest-supported", id: `${c.id}#aks-version`, detail: `Kubernetes ${c.version} is the oldest version AKS supports in ${c.location}; it drops out when the next version ships` });
    }
  }
  return [...findings, ...itemErrors(TOOL_ID, "aks", "AKS regions", failures.map((f) => ({ ...f, item: { subscriptionId: f.item.split("|")[0] } })), pairs.length)];
}

/* App Service: language runtime and minimum TLS version from config/web. */
function runtimeOf(cfg) {
  const fx = String(cfg.linuxFxVersion || "");
  const m = fx.match(/^(NODE|PYTHON|DOTNETCORE|DOTNET|DOTNET-ISOLATED|PHP)\|(.+)$/i);
  if (m) {
    const stack = m[1].toLowerCase().startsWith("dotnet") ? "dotnet" : m[1].toLowerCase();
    return { stack, version: m[2] };
  }
  // Windows apps report a default PHP or Python version even when they do not
  // use it, so only the .NET version is trusted there.
  const net = String(cfg.netFrameworkVersion || "").match(/^v(\d+)\.0$/);
  if (net && Number(net[1]) >= 5) return { stack: "dotnet", version: net[1] };
  return null;
}
function runtimeEol(rt) {
  const table = { ...RUNTIME_EOL[rt.stack], ...live[rt.stack] };
  const v = String(rt.version).replace(/^~/, "").toLowerCase();
  if (rt.stack === "node") return table[(v.match(/^(\d+)/) || [])[1]];
  if (rt.stack === "dotnet") {
    const [maj, min] = v.split(".");
    return table[maj === "3" ? `3.${min || 1}` : maj];
  }
  const mm = v.match(/^(\d+\.\d+)/);
  return mm ? table[mm[1]] : undefined;
}

async function appServiceFindings() {
  const sites = await resourceGraphQuery(
    `Resources
    | where type =~ 'microsoft.web/sites' or type =~ 'microsoft.web/sites/slots'
    | project id, name, resourceGroup, subscriptionId, kind`,
    { toolId: TOOL_ID }
  );
  const findings = [];
  const checked = sites.slice(0, MAX_SITES);
  const failures = await mapLimit(checked, CONCURRENCY, async (s) => {
    const cfg = (await armGet(`https://management.azure.com${s.id}/config/web?api-version=2023-12-01`, TOOL_ID)).properties || {};
    const base = { name: s.name, resourceGroup: s.resourceGroup, subscriptionId: s.subscriptionId };
    const rt = runtimeOf(cfg);
    const end = rt && runtimeEol(rt);
    if (end) {
      const label = `${RUNTIME_LABEL[rt.stack]} ${rt.version}`;
      const f = dated("runtime-end-of-support", "runtime-support-ending", end, { ...base, id: `${s.id}#runtime` });
      if (f) findings.push({ ...f, detail: `${label} ${daysUntil(end) < 0 ? "went out of support" : "goes out of support"} on ${end}` });
    }
    if (["1.0", "1.1"].includes(String(cfg.minTlsVersion))) {
      findings.push({ ...base, kind: "tls-old-allowed", id: `${s.id}#tls`, detail: `Accepts TLS ${cfg.minTlsVersion}; set the minimum TLS version to 1.2` });
    }
  });
  if (sites.length > MAX_SITES) findings.push(scanError(TOOL_ID, "sites-cap", `Checked ${MAX_SITES} of ${sites.length} web apps`, "The rest were skipped to keep the run short"));
  return [...findings, ...itemErrors(TOOL_ID, "sites", "web apps", failures, checked.length)];
}

/* Storage, SQL and Redis still accepting TLS 1.0/1.1 (from Resource Graph). */
async function tlsFindings() {
  const rows = await resourceGraphQuery(
    `Resources
    | where type in~ ('microsoft.storage/storageaccounts', 'microsoft.sql/servers', 'microsoft.cache/redis')
    | extend tls = tostring(coalesce(properties.minimumTlsVersion, properties.minimalTlsVersion))
    | where tls in~ ('TLS1_0', 'TLS1_1', '1.0', '1.1', 'None') or (type =~ 'microsoft.storage/storageaccounts' and isempty(tls))
    | project id, name, type = tolower(type), resourceGroup, subscriptionId, tls`,
    { toolId: TOOL_ID }
  );
  const what = { "microsoft.storage/storageaccounts": "Storage account", "microsoft.sql/servers": "SQL server", "microsoft.cache/redis": "Redis cache" };
  return rows.map((r) => ({
    kind: "tls-old-allowed",
    id: `${r.id}#tls`,
    name: r.name,
    resourceGroup: r.resourceGroup,
    subscriptionId: r.subscriptionId,
    detail: `${what[r.type]} accepts ${!r.tls ? "TLS 1.0 (no minimum set)" : r.tls === "None" ? "any TLS version" : "TLS " + r.tls.replace("TLS", "").replace("_", ".")}; set the minimum to TLS 1.2`,
  }));
}

/* VM operating systems from the image (or the guest's own report). */
function osEol(vm) {
  const text = [vm.offer, vm.sku, vm.osName, vm.osVersion].join(" ").toLowerCase();
  if (String(vm.osType).toLowerCase() === "windows" || /windows/.test(text)) {
    // SQL images name both versions ("sql2016-ws2019"): the ws part is Windows.
    const year = (text.match(/ws(20\d\d)/) || text.match(/windows server (20\d\d)/) || text.match(/(?:^|\s)(20\d\d)-/) || [])[1];
    const end = year && ((live.windows || {})[year] || WINDOWS_EOL[year]);
    return end ? { os: `Windows Server ${year}`, end } : null;
  }
  const fromLive = linuxLive(text);
  if (fromLive) return fromLive;
  const hit = LINUX_EOL.find(([re]) => re.test(text));
  return hit ? { os: hit[1], end: hit[2] } : null;
}

// A Linux release found in the image text and known to endoflife.date.
function linuxLive(text) {
  for (const [key, label, distro, release, name] of LINUX_LIVE) {
    const dates = live[key];
    if (!dates || !distro.test(text)) continue;
    const code = Object.keys(CODENAMES).find((c) => new RegExp(`\\b${c}\\b`).test(text));
    const m = text.replace(distro, " ").match(release);
    const rel = code && (key === "ubuntu") === CODENAMES[code].includes(".") ? CODENAMES[code] : m ? name(m) : null;
    if (!rel) continue;
    // SUSE: a major version ends with its last service pack.
    const end =
      key === "sles"
        ? Object.entries(dates).filter(([n]) => n === rel || n.startsWith(`${rel}.`)).map(([, d]) => d).sort().pop()
        : dates[rel];
    if (end) return { os: `${label} ${rel}`, end };
  }
  return null;
}

async function vmFindings() {
  const vms = await resourceGraphQuery(
    `Resources
    | where type =~ 'microsoft.compute/virtualmachines'
    | project id, name, resourceGroup, subscriptionId,
        offer = tostring(properties.storageProfile.imageReference.offer), sku = tostring(properties.storageProfile.imageReference.sku),
        osType = tostring(properties.storageProfile.osDisk.osType),
        osName = tostring(properties.extended.instanceView.osName), osVersion = tostring(properties.extended.instanceView.osVersion)`,
    { toolId: TOOL_ID }
  );
  const findings = [];
  for (const vm of vms) {
    const hit = osEol(vm);
    if (!hit) continue;
    const f = dated("os-end-of-support", "os-support-ending", hit.end, { id: `${vm.id}#os`, name: vm.name, resourceGroup: vm.resourceGroup, subscriptionId: vm.subscriptionId });
    if (f) findings.push({ ...f, detail: `${hit.os} ${daysUntil(hit.end) < 0 ? "left standard support" : "leaves standard support"} on ${hit.end} (image ${[vm.offer, vm.sku].filter(Boolean).join(" ") || vm.osName || "unknown"})` });
  }
  return findings;
}

async function run() {
  const dates = await eolDates.load();
  live = dates.tables;
  log.record({ tool: TOOL_ID, level: dates.source === "endoflife.date" ? "info" : "warn", message: `End-of-support dates: ${dates.source}${dates.note ? ` (${dates.note})` : ""}` });
  return runChecks(TOOL_ID, {
    "AKS versions": aksFindings,
    "App Service runtimes": appServiceFindings,
    "TLS settings": tlsFindings,
    "VM operating systems": vmFindings,
  });
}

module.exports = {
  id: TOOL_ID,
  label: "End of support",
  schedule: "0 6 * * 1", // weekly, Monday 06:00
  run,
  _test: { runtimeOf, runtimeEol, osEol, setLive: (t) => (live = t || {}) },
};
