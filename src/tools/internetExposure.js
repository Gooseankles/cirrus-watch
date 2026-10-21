// What the internet can reach: NSG rules open to any source, VMs with a
// public IP, storage containers anyone can read, database firewalls open to
// everyone. Reader is enough.
const { resourceGraphQuery, armGet } = require("../armClient");
const { mapLimit, runChecks, itemErrors, nameOf } = require("./util");

const TOOL_ID = "internet-exposure";
const CONCURRENCY = 6;
const MAX_ACCOUNTS = 500; // storage accounts whose containers are listed
const MAX_SERVERS = 500;

const ANY_SOURCE = new Set(["*", "internet", "any", "0.0.0.0", "0.0.0.0/0", "::/0"]);
const ADMIN_PORTS = { 22: "SSH", 3389: "RDP", 5985: "WinRM", 5986: "WinRM" };
const DB_PORTS = { 1433: "SQL Server", 3306: "MySQL", 5432: "PostgreSQL", 27017: "MongoDB", 6379: "Redis", 9200: "Elasticsearch" };

const list = (one, many) => [...(one ? [one] : []), ...(Array.isArray(many) ? many : [])];
const fromAnywhere = (p) => list(p.sourceAddressPrefix, p.sourceAddressPrefixes).some((s) => ANY_SOURCE.has(String(s).toLowerCase()));

function portRanges(p) {
  return list(p.destinationPortRange, p.destinationPortRanges).map((r) => {
    const s = String(r).trim();
    if (s === "*") return [0, 65535];
    const [a, b] = s.split("-").map(Number);
    return [a, Number.isFinite(b) ? b : a];
  });
}
const covers = (ranges, port) => ranges.some(([a, b]) => port >= a && port <= b);
const coversAll = (ranges) => ranges.some(([a, b]) => a <= 1 && b >= 65535);

// Inbound rules that let any source in, minus ports a higher-priority Deny
// from any source already closes.
function openings(rules) {
  const inbound = (rules || [])
    .map((r) => ({ name: r.name, ...(r.properties || {}) }))
    .filter((p) => String(p.direction).toLowerCase() === "inbound" && fromAnywhere(p))
    .sort((a, b) => (a.priority || 0) - (b.priority || 0));
  const out = { all: [], admin: [], db: [] };
  const blocked = (rule, port) => inbound.some((d) => String(d.access).toLowerCase() === "deny" && d.priority < rule.priority && covers(portRanges(d), port));
  for (const rule of inbound) {
    if (String(rule.access).toLowerCase() !== "allow") continue;
    const ranges = portRanges(rule);
    const label = `${rule.name} (priority ${rule.priority})`;
    if (coversAll(ranges) && !inbound.some((d) => String(d.access).toLowerCase() === "deny" && d.priority < rule.priority && coversAll(portRanges(d)))) {
      out.all.push(`${label}: all ports`);
      continue;
    }
    for (const [table, bucket] of [[ADMIN_PORTS, out.admin], [DB_PORTS, out.db]]) {
      const ports = Object.keys(table).map(Number).filter((port) => covers(ranges, port) && !blocked(rule, port));
      if (ports.length) bucket.push(`${label}: ${ports.map((port) => `${port} ${table[port]}`).join(", ")}`);
    }
  }
  return out;
}

async function nsgFindings() {
  const rows = await resourceGraphQuery(
    `Resources
    | where type =~ 'microsoft.network/networksecuritygroups'
    | project id, name, resourceGroup, subscriptionId, rules = properties.securityRules,
        attached = coalesce(array_length(properties.subnets), 0) + coalesce(array_length(properties.networkInterfaces), 0)`,
    { toolId: TOOL_ID }
  );
  const findings = [];
  for (const r of rows) {
    const o = openings(r.rules);
    const base = { name: r.name, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId };
    const hits = [["nsg-open-all-ports", o.all], ["nsg-open-admin-port", o.admin], ["nsg-open-db-port", o.db]].filter(([, l]) => l.length);
    if (!hits.length) continue;
    if (!r.attached) {
      findings.push({ ...base, kind: "nsg-open-unattached", id: `${r.id}#unattached`, detail: `Not attached to a subnet or NIC, but would open: ${hits.flatMap(([, l]) => l).join("; ")}` });
      continue;
    }
    for (const [kind, l] of hits) findings.push({ ...base, kind, id: `${r.id}#${kind}`, detail: `Open to the internet: ${l.join("; ")}` });
  }
  return findings;
}

async function vmPublicIpFindings() {
  const [nics, pips] = await Promise.all([
    resourceGraphQuery(
      `Resources
      | where type =~ 'microsoft.network/networkinterfaces' and isnotempty(properties.virtualMachine.id)
      | mv-expand ipc = properties.ipConfigurations
      | where isnotempty(ipc.properties.publicIPAddress.id)
      | project nic = name, vmId = tostring(properties.virtualMachine.id), pipId = tolower(tostring(ipc.properties.publicIPAddress.id)), subscriptionId, resourceGroup`,
      { toolId: TOOL_ID }
    ),
    resourceGraphQuery(
      `Resources | where type =~ 'microsoft.network/publicipaddresses' | project id = tolower(id), ip = tostring(properties.ipAddress)`,
      { toolId: TOOL_ID }
    ),
  ]);
  const ipOf = new Map(pips.map((p) => [p.id, p.ip]));
  const byVm = new Map();
  for (const n of nics) {
    const key = n.vmId.toLowerCase();
    if (!byVm.has(key)) byVm.set(key, { vmId: n.vmId, subscriptionId: n.subscriptionId, resourceGroup: n.resourceGroup, ips: [] });
    byVm.get(key).ips.push(`${ipOf.get(n.pipId) || "(not allocated)"} (${nameOf(n.pipId)} on NIC ${n.nic})`);
  }
  return [...byVm.values()].map((v) => ({
    kind: "vm-public-ip",
    id: `${v.vmId}#public-ip`,
    name: nameOf(v.vmId),
    resourceGroup: v.resourceGroup,
    subscriptionId: v.subscriptionId,
    detail: `Public IP ${v.ips.join(", ")}. Reach it through Bastion, a VPN or a load balancer instead`,
  }));
}

async function storageFindings() {
  const accounts = await resourceGraphQuery(
    `Resources
    | where type =~ 'microsoft.storage/storageaccounts'
    | where tostring(properties.allowBlobPublicAccess) != 'false'
    | project id, name, resourceGroup, subscriptionId, network = tostring(properties.publicNetworkAccess), defaultAction = tostring(properties.networkAcls.defaultAction)`,
    { toolId: TOOL_ID }
  );
  const findings = [];
  const checked = accounts.slice(0, MAX_ACCOUNTS);
  const failures = await mapLimit(checked, CONCURRENCY, async (a) => {
    const open = [];
    let url = `https://management.azure.com${a.id}/blobServices/default/containers?api-version=2023-01-01&$maxpagesize=1000`;
    while (url) {
      const page = await armGet(url, TOOL_ID);
      for (const c of page.value || []) {
        const access = (c.properties || {}).publicAccess;
        if (access && access !== "None") open.push(`${c.name} (${access === "Container" ? "anyone can list and read" : "anyone can read blobs"})`);
      }
      url = page.nextLink || null;
    }
    const base = { name: a.name, resourceGroup: a.resourceGroup, subscriptionId: a.subscriptionId };
    const firewall = a.network === "Disabled" || a.defaultAction === "Deny" ? " The account firewall limits who can reach it." : "";
    if (open.length) findings.push({ ...base, kind: "storage-public-container", id: `${a.id}#public-containers`, detail: `Anonymous read on: ${open.join(", ")}.${firewall}` });
    else findings.push({ ...base, kind: "storage-public-allowed", id: `${a.id}#public-allowed`, detail: "Anonymous blob access is allowed on the account (no container uses it yet). Turn off \"Allow Blob anonymous access\"" });
  });
  return [...findings, ...itemErrors(TOOL_ID, "storage", "storage accounts", failures, checked.length)];
}

const SERVER_TYPES = {
  "microsoft.sql/servers": { label: "SQL server", api: "2021-11-01" },
  "microsoft.dbforpostgresql/flexibleservers": { label: "PostgreSQL server", api: "2022-12-01" },
  "microsoft.dbformysql/flexibleservers": { label: "MySQL server", api: "2021-05-01" },
};
const ipNum = (ip) => String(ip || "").split(".").reduce((n, p) => n * 256 + (Number(p) || 0), 0);

async function databaseFindings() {
  const servers = await resourceGraphQuery(
    `Resources
    | where type in~ ('microsoft.sql/servers', 'microsoft.dbforpostgresql/flexibleservers', 'microsoft.dbformysql/flexibleservers')
    | extend network = tostring(coalesce(properties.publicNetworkAccess, properties.network.publicNetworkAccess))
    | where network !~ 'Disabled'
    | project id, name, type = tolower(type), resourceGroup, subscriptionId`,
    { toolId: TOOL_ID }
  );
  const findings = [];
  const checked = servers.slice(0, MAX_SERVERS);
  const failures = await mapLimit(checked, CONCURRENCY, async (s) => {
    const t = SERVER_TYPES[s.type];
    const page = await armGet(`https://management.azure.com${s.id}/firewallRules?api-version=${t.api}`, TOOL_ID);
    const all = [], azure = [], wide = [];
    for (const r of page.value || []) {
      const p = r.properties || {};
      const start = p.startIpAddress, end = p.endIpAddress;
      const label = `${r.name} (${start} - ${end})`;
      if (start === "0.0.0.0" && end === "0.0.0.0") azure.push(label);
      else if (ipNum(start) <= 0 && ipNum(end) >= ipNum("255.255.255.255")) all.push(label);
      else if (ipNum(end) - ipNum(start) + 1 > 65536) wide.push(label);
    }
    const base = { name: s.name, resourceGroup: s.resourceGroup, subscriptionId: s.subscriptionId };
    if (all.length) findings.push({ ...base, kind: "db-firewall-open-all", id: `${s.id}#open-all`, detail: `${t.label} firewall lets every IP address in: ${all.join(", ")}` });
    if (azure.length) findings.push({ ...base, kind: "db-firewall-azure-services", id: `${s.id}#azure-services`, detail: `"Allow Azure services" is on (${azure.join(", ")}): any Azure customer's service can reach the ${t.label}, not only yours` });
    if (wide.length) findings.push({ ...base, kind: "db-firewall-wide-range", id: `${s.id}#wide-range`, detail: `Firewall ranges wider than a /16: ${wide.join(", ")}` });
  });
  return [...findings, ...itemErrors(TOOL_ID, "databases", "database servers", failures, checked.length)];
}

function run() {
  return runChecks(TOOL_ID, {
    "Network security groups": nsgFindings,
    "VM public IPs": vmPublicIpFindings,
    "Storage containers": storageFindings,
    "Database firewalls": databaseFindings,
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Internet exposure",
  schedule: "30 3 * * *", // daily at 03:30
  run,
  _test: { openings },
};
