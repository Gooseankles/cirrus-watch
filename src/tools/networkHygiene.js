// Network settings that look fine but protect or route nothing: WAF policies
// in Detection mode or turned off (Application Gateway and Front Door), WAF
// gateways with no WAF at all, public Standard gateways with no WAF, DNS
// records that point at an Azure name nobody owns any more (subdomain
// takeover) or at a deleted resource, and routes whose virtual appliance IP
// sits in a scanned VNet but belongs to nothing (traffic is dropped). DDoS
// protection is left alone on purpose. Reader is enough; the DNS check also
// asks public DNS whether a CNAME target still exists.
const dns = require("dns");
const { resourceGraphQuery, armGet, subscriptionIdsToScan } = require("../armClient");
const { mapLimit, runChecks, itemErrors, scanError, nameOf } = require("./util");

const TOOL_ID = "network-hygiene";
const CONCURRENCY = 6;
const MAX_ZONES = 300; // DNS zones whose record sets are listed
const MAX_RECORDS = 5000; // record sets read per zone
const MAX_LOOKUPS = 1000; // CNAME targets looked up in public DNS
const DNS_API = "api-version=2018-05-01";

const arr = (a) => (Array.isArray(a) ? a : []);
const lc = (s) => String(s || "").toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const subOf = (id) => (lc(id).match(/^\/subscriptions\/([^/]+)/) || [])[1];

/* ---------- WAF ---------- */

// The gateways or Front Doors a WAF policy is linked to, by name.
function linkedTo(links) {
  const names = new Set();
  for (const l of links) {
    const m = String(l.id || "").match(/\/(?:applicationgateways|frontdoors|profiles)\/([^/]+)/i);
    if (m) names.add(m[1]);
  }
  return [...names];
}

// p: { type, mode, state, links: [{ id }] }. Null when fine or not linked to anything (then it filters nothing anyway).
function judgeWafPolicy(p) {
  const links = arr(p.links);
  if (!links.length) return null;
  const fd = /frontdoorwebapplicationfirewallpolicies/i.test(p.type);
  const where = `${fd ? "Front Door WAF policy" : "Application Gateway WAF policy"} linked to ${linkedTo(links).join(", ") || plural(links.length, "listener")}`;
  if (/^disabled$/i.test(p.state)) {
    return { kind: "waf-disabled", detail: `${where} is turned off, so requests reach the app unfiltered. Enable the policy in Prevention mode` };
  }
  if (/^detection$/i.test(p.mode)) {
    return { kind: "waf-detection", detail: `${where} is in Detection mode: it logs attacks but lets them through. Once the logs show no false positives, switch it to Prevention` };
  }
  return null;
}

// g: { tier, policyId, waf (legacy webApplicationFirewallConfiguration), listeners, frontends }. A linked WAF policy is
// judged on the policy itself.
function judgeGateway(g) {
  const tier = lc(g.tier);
  if (tier === "waf_v2" || tier === "waf") {
    const hasPolicy = Boolean(g.policyId) || arr(g.listeners).some((l) => l.properties && l.properties.firewallPolicy && l.properties.firewallPolicy.id);
    if (hasPolicy) return null;
    const waf = g.waf || {};
    if (!g.waf || waf.enabled === false) {
      return { kind: "waf-disabled", detail: "WAF gateway with no WAF policy and its WAF turned off: it costs WAF prices and filters nothing. Attach a WAF policy in Prevention mode" };
    }
    if (/^detection$/i.test(waf.firewallMode)) {
      return { kind: "waf-detection", detail: "The gateway's built-in WAF setting is in Detection mode: it logs attacks but lets them through. Move it to a WAF policy in Prevention mode" };
    }
    return null;
  }
  const isPublic = arr(g.frontends).some((f) => f.properties && f.properties.publicIPAddress && f.properties.publicIPAddress.id);
  if (isPublic) {
    return { kind: "agw-no-waf", detail: `Public ${g.tier || "Standard"} gateway with no web application firewall in front of the apps behind it. Fine if Front Door with a WAF sits in front of it; otherwise consider the WAF_v2 SKU` };
  }
  return null;
}

async function wafFindings() {
  const q = (kql) => resourceGraphQuery(kql, { toolId: TOOL_ID });
  const [policies, gateways] = await Promise.all([
    q(`Resources
    | where type in~ ('microsoft.network/applicationgatewaywebapplicationfirewallpolicies', 'microsoft.network/frontdoorwebapplicationfirewallpolicies')
    | project id, name, type = tolower(type), resourceGroup, subscriptionId, mode = tostring(properties.policySettings.mode),
        state = tostring(properties.policySettings.state), enabledState = tostring(properties.policySettings.enabledState),
        gws = properties.applicationGateways, listeners = properties.httpListeners, paths = properties.pathBasedRules,
        endpoints = properties.frontendEndpointLinks, secPolicies = properties.securityPolicyLinks, rules = properties.routingRuleLinks`),
    q(`Resources
    | where type =~ 'microsoft.network/applicationgateways' and tostring(properties.operationalState) !~ 'Stopped'
    | project id, name, resourceGroup, subscriptionId, tier = tostring(properties.sku.tier), policyId = tostring(properties.firewallPolicy.id),
        waf = properties.webApplicationFirewallConfiguration, listeners = properties.httpListeners, frontends = properties.frontendIPConfigurations`),
  ]);
  const findings = [];
  for (const p of policies) {
    const links = [p.gws, p.listeners, p.paths, p.endpoints, p.secPolicies, p.rules].flatMap(arr);
    const bad = judgeWafPolicy({ type: p.type, mode: p.mode, state: p.state || p.enabledState, links });
    if (bad) findings.push({ kind: bad.kind, id: `${p.id}#waf-mode`, name: p.name, resourceGroup: p.resourceGroup, subscriptionId: p.subscriptionId, detail: bad.detail });
  }
  for (const g of gateways) {
    const bad = judgeGateway(g);
    if (bad) findings.push({ kind: bad.kind, id: `${g.id}#waf`, name: g.name, resourceGroup: g.resourceGroup, subscriptionId: g.subscriptionId, detail: bad.detail });
  }
  return findings;
}

/* ---------- Dangling DNS ---------- */

// Azure names that anyone can create again once the resource is deleted (Microsoft's "Prevent dangling DNS entries" list
// plus a few more).
const TAKEOVER_SUFFIXES = [
  "azurewebsites.net", "cloudapp.net", "cloudapp.azure.com", "trafficmanager.net", "blob.core.windows.net", "web.core.windows.net",
  "azureedge.net", "azurefd.net", "azure-api.net", "azurecontainer.io", "azurestaticapps.net", "search.windows.net",
  "redis.cache.windows.net", "database.windows.net", "servicebus.windows.net", "azurehdinsight.net",
];
const takeoverSuffix = (host) => TAKEOVER_SUFFIXES.find((s) => host === s || host.endsWith(`.${s}`)) || null;
const cleanHost = (h) => lc(h).trim().replace(/\.$/, "");

// Resource types whose host name is their name plus a fixed suffix.
const NAME_HOSTS = {
  "microsoft.search/searchservices": ["search.windows.net"],
  "microsoft.cache/redis": ["redis.cache.windows.net"],
  "microsoft.sql/servers": ["database.windows.net"],
  "microsoft.servicebus/namespaces": ["servicebus.windows.net"],
  "microsoft.eventhub/namespaces": ["servicebus.windows.net"],
  "microsoft.hdinsight/clusters": ["azurehdinsight.net"],
  "microsoft.classiccompute/domainnames": ["cloudapp.net"],
  "microsoft.apimanagement/service": ["azure-api.net"],
  "microsoft.network/frontdoors": ["azurefd.net"],
  "microsoft.storage/storageaccounts": ["blob.core.windows.net"],
};
// Types an alias record can point at (their deletion can be judged from Resource Graph).
const ALIAS_TYPES = [
  "microsoft.network/publicipaddresses", "microsoft.network/trafficmanagerprofiles", "microsoft.cdn/profiles/endpoints",
  "microsoft.cdn/profiles/afdendpoints", "microsoft.network/frontdoors",
];
const HOST_TYPES = [
  ...new Set([
    ...Object.keys(NAME_HOSTS), ...ALIAS_TYPES, "microsoft.web/sites", "microsoft.web/sites/slots", "microsoft.web/staticsites",
    "microsoft.containerinstance/containergroups",
  ]),
];

// Every host name found in a value (strings, URLs, arrays, objects), lower-case.
function hostsIn(value, out = new Set()) {
  if (typeof value === "string") {
    for (const m of value.matchAll(/[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+/gi)) out.add(cleanHost(m[0]));
  } else if (Array.isArray(value)) {
    for (const v of value) hostsIn(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) hostsIn(v, out);
  }
  return out;
}

// rows: [{ id, type, name, h }] -> { hosts: Set, ids: Set }
function ownedNames(rows) {
  const hosts = new Set();
  const ids = new Set();
  for (const r of rows) {
    ids.add(lc(r.id));
    hostsIn(r.h, hosts);
    for (const s of NAME_HOSTS[lc(r.type)] || []) hosts.add(`${lc(r.name)}.${s}`);
  }
  return { hosts, ids };
}

async function owned() {
  const rows = await resourceGraphQuery(
    `Resources
    | where type in~ (${HOST_TYPES.map((t) => `'${t}'`).join(", ")})
    | project id, type, name, h = pack_array(properties.defaultHostName, properties.hostNames, properties.enabledHostNames,
        properties.dnsSettings.fqdn, properties.dnsConfig.fqdn, properties.primaryEndpoints, properties.secondaryEndpoints,
        properties.hostName, properties.frontendEndpoints, properties.cname, properties.gatewayUrl, properties.portalUrl,
        properties.developerPortalUrl, properties.managementApiUrl, properties.scmUrl, properties.hostnameConfigurations,
        properties.ipAddress.fqdn, properties.defaultHostname, properties.fullyQualifiedDomainName, properties.serviceBusEndpoint)`,
    { toolId: TOOL_ID }
  );
  return ownedNames(rows);
}

// One record set. Returns null, { cname } (a takeover-prone target nobody in the scanned subscriptions owns: look it
// up) or { kind: "dns-alias-missing", target } (an alias to a deleted resource).
function judgeRecord(rs, own, subs) {
  const p = rs.properties || {};
  const aliasId = lc(p.targetResource && p.targetResource.id);
  if (aliasId) {
    // Only types listed in Resource Graph and only in scanned subscriptions; anything else cannot be judged.
    if (ALIAS_TYPES.includes(typeOfId(aliasId)) && subs.has(subOf(aliasId)) && !own.ids.has(aliasId)) return { kind: "dns-alias-missing", target: p.targetResource.id };
    return null;
  }
  const cname = cleanHost(p.CNAMERecord && p.CNAMERecord.cname);
  if (!cname || !takeoverSuffix(cname) || own.hosts.has(cname)) return null;
  return { cname };
}

// "microsoft.network/publicipaddresses" from a resource ID, "microsoft.cdn/profiles/endpoints" for child resources.
function typeOfId(id) {
  const m = lc(id).match(/\/providers\/([^/]+)\/(.+)$/);
  if (!m) return "";
  const parts = m[2].split("/");
  return [m[1], ...parts.filter((_, i) => i % 2 === 0)].join("/");
}

// Public DNS answer for a CNAME target: "missing" (no such name), "exists" or "unknown" (lookup failed).
function lookupStatus(code) {
  if (!code) return "exists";
  if (code === "ENOTFOUND") return "missing";
  if (code === "ENODATA") return "exists"; // the name exists, just has no CNAME of its own
  return "unknown";
}

async function lookup(resolver, host) {
  try {
    await resolver.resolveCname(host);
    return "exists";
  } catch (err) {
    return lookupStatus(err && err.code);
  }
}

async function recordSets(zoneId) {
  const out = [];
  let url = `https://management.azure.com${zoneId}/recordsets?${DNS_API}`;
  let capped = false;
  while (url) {
    const page = await armGet(url, TOOL_ID);
    out.push(...(page.value || []));
    if (out.length >= MAX_RECORDS) {
      capped = Boolean(page.nextLink);
      break;
    }
    url = page.nextLink;
  }
  return { list: out.slice(0, MAX_RECORDS), capped };
}

async function dnsFindings() {
  const [zones, own, subList] = await Promise.all([
    resourceGraphQuery(
      `Resources
      | where type =~ 'microsoft.network/dnszones'
      | project id, name, resourceGroup, subscriptionId, records = toint(properties.numberOfRecordSets)`,
      { toolId: TOOL_ID }
    ),
    owned(),
    subscriptionIdsToScan(TOOL_ID),
  ]);
  const subs = new Set(subList.map(lc));
  const findings = [];
  const candidates = []; // { zone, rs, cname }
  const cappedZones = [];
  const checked = zones.slice(0, MAX_ZONES);
  const failures = await mapLimit(checked, CONCURRENCY, async (z) => {
    const { list, capped } = await recordSets(z.id);
    if (capped) cappedZones.push(z.name);
    for (const rs of list) {
      const bad = judgeRecord(rs, own, subs);
      if (!bad) continue;
      const fqdn = cleanHost((rs.properties || {}).fqdn) || `${rs.name}.${z.name}`;
      if (bad.cname) {
        candidates.push({ z, rs, fqdn, cname: bad.cname });
        continue;
      }
      findings.push({
        kind: "dns-alias-missing",
        id: `${rs.id}#alias`,
        name: fqdn,
        resourceGroup: z.resourceGroup,
        subscriptionId: z.subscriptionId,
        detail: `Alias record ${fqdn} points to ${nameOf(bad.target)} (${typeOfId(bad.target)}), which no longer exists, so the name answers nothing. Delete the record or point it at the resource that replaced it`,
      });
    }
  });
  // Ask public DNS about each target once: a name that does not exist anywhere can be registered by anyone.
  const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  const targets = [...new Set(candidates.map((c) => c.cname))];
  const status = new Map();
  await mapLimit(targets.slice(0, MAX_LOOKUPS), 10, async (t) => status.set(t, await lookup(resolver, t)));
  let unknown = 0;
  for (const c of candidates) {
    const s = status.get(c.cname);
    if (s !== "missing") {
      if (s === "unknown") unknown++;
      continue;
    }
    findings.push({
      kind: "dns-dangling-cname",
      id: `${c.rs.id}#dangling`,
      name: c.fqdn,
      resourceGroup: c.z.resourceGroup,
      subscriptionId: c.z.subscriptionId,
      detail: `CNAME ${c.fqdn} points to ${c.cname}, which does not exist in public DNS, and no resource in the scanned subscriptions has that name. If it was deleted, anyone can create a ${takeoverSuffix(c.cname)} resource with this name and serve their content on your domain: delete the record or recreate the resource`,
    });
  }
  if (zones.length > MAX_ZONES) findings.push(scanError(TOOL_ID, "zones-cap", `Checked ${MAX_ZONES} of ${zones.length} DNS zones`, "The other zones' records were not checked"));
  if (cappedZones.length) findings.push(scanError(TOOL_ID, "records-cap", `Read the first ${MAX_RECORDS} records of ${plural(cappedZones.length, "zone")}`, cappedZones.slice(0, 10).join(", ")));
  if (targets.length > MAX_LOOKUPS) findings.push(scanError(TOOL_ID, "lookups-cap", `Looked up ${MAX_LOOKUPS} of ${targets.length} CNAME targets`, "The rest were not checked"));
  if (unknown) findings.push(scanError(TOOL_ID, "lookups", `${plural(unknown, "CNAME record")} not judged: the DNS lookup failed`, "The server could not reach public DNS or the lookup timed out"));
  return [...findings, ...itemErrors(TOOL_ID, "zones", "DNS zones", failures, checked.length)];
}

/* ---------- Routes to nowhere ---------- */

function ipToInt(ip) {
  const m = String(ip || "").trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return null;
  return m.slice(1).reduce((n, x) => n * 256 + Number(x), 0);
}

function cidrRange(s) {
  const [ip, bits] = String(s || "").split("/");
  const start = ipToInt(ip);
  const b = bits === undefined ? 32 : Number(bits);
  if (start === null || !(b >= 0 && b <= 32)) return null;
  const size = 2 ** (32 - b);
  const first = Math.floor(start / size) * size;
  return { first, last: first + size - 1 };
}
const inAny = (n, prefixes) => arr(prefixes).some((p) => {
  const r = cidrRange(p);
  return r && n >= r.first && n <= r.last;
});

// tables: route tables attached to subnets [{ id, name, resourceGroup, subscriptionId, routes, subnets }], vnets:
// [{ name, prefixes, subnets }], knownIps: Set of private IPs in use, vmssSubnets: Set of lower-case subnet IDs used
// by scale sets (their instance IPs are not in Resource Graph).
function judgeRoutes(tables, vnets, knownIps, vmssSubnets) {
  const findings = [];
  for (const t of tables) {
    for (const r of arr(t.routes)) {
      const p = r.properties || {};
      if (!/^virtualappliance$/i.test(p.nextHopType || "")) continue;
      const ip = String(p.nextHopIpAddress || "").trim();
      const n = ipToInt(ip);
      if (n === null || knownIps.has(ip)) continue;
      const vnet = vnets.find((v) => inAny(n, v.prefixes));
      if (!vnet) continue; // on-premises or a VNet that is not scanned: cannot judge
      const subnet = arr(vnet.subnets).find((s) => {
        const sp = s.properties || {};
        return inAny(n, [sp.addressPrefix, ...arr(sp.addressPrefixes)].filter(Boolean));
      });
      if (subnet) {
        const sp = subnet.properties || {};
        // Scale sets, delegated subnets and gateway subnets hold addresses Resource Graph does not list.
        if (vmssSubnets.has(lc(subnet.id)) || arr(sp.delegations).length || /^(gatewaysubnet|routeserversubnet)$/i.test(subnet.name)) continue;
      }
      const attached = arr(t.subnets).length;
      findings.push({
        kind: "route-next-hop-missing",
        id: `${r.id || `${t.id}/routes/${r.name}`}#next-hop`,
        name: `${t.name} / ${r.name}`,
        resourceGroup: t.resourceGroup,
        subscriptionId: t.subscriptionId,
        detail: `Route ${r.name} (${p.addressPrefix}) sends traffic to the appliance ${ip} in VNet ${vnet.name}${subnet ? ` (subnet ${subnet.name})` : ", outside every subnet"}, but no network interface, internal load balancer or Azure Firewall in the scanned subscriptions has that address, so that traffic from ${plural(attached, "subnet")} is dropped. Point the route at the appliance's current address or remove it`,
      });
    }
  }
  return findings;
}

async function routeFindings() {
  const q = (kql) => resourceGraphQuery(kql, { toolId: TOOL_ID });
  // Route tables on no subnet are left to the Orphaned resources scan.
  const [tables, vnets, ips, vmss] = await Promise.all([
    q(`Resources
    | where type =~ 'microsoft.network/routetables' and array_length(properties.subnets) > 0
    | project id, name, resourceGroup, subscriptionId, routes = properties.routes, subnets = properties.subnets`),
    q(`Resources
    | where type =~ 'microsoft.network/virtualnetworks'
    | project name, prefixes = properties.addressSpace.addressPrefixes, subnets = properties.subnets`),
    q(`Resources
    | where type in~ ('microsoft.network/networkinterfaces', 'microsoft.network/azurefirewalls')
    | mv-expand c = properties.ipConfigurations
    | project ip = tostring(c.properties.privateIPAddress)
    | union (Resources | where type in~ ('microsoft.network/loadbalancers', 'microsoft.network/applicationgateways')
        | mv-expand c = properties.frontendIPConfigurations | project ip = tostring(c.properties.privateIPAddress))
    | union (Resources | where type =~ 'microsoft.network/azurefirewalls' | project ip = tostring(properties.hubIPAddresses.privateIPAddress))
    | where isnotempty(ip)
    | distinct ip`),
    q(`Resources
    | where type =~ 'microsoft.compute/virtualmachinescalesets'
    | mv-expand n = properties.virtualMachineProfile.networkProfile.networkInterfaceConfigurations
    | mv-expand c = n.properties.ipConfigurations
    | project subnet = tolower(tostring(c.properties.subnet.id))
    | where isnotempty(subnet)
    | distinct subnet`),
  ]);
  return judgeRoutes(tables, vnets, new Set(ips.map((r) => r.ip)), new Set(vmss.map((r) => r.subnet)));
}

async function run() {
  return runChecks(TOOL_ID, { WAF: wafFindings, "Dangling DNS": dnsFindings, Routes: routeFindings });
}

module.exports = {
  id: TOOL_ID,
  label: "Network hygiene",
  schedule: "5 5 * * *", // daily at 05:05
  run,
  _test: { judgeWafPolicy, judgeGateway, hostsIn, ownedNames, judgeRecord, typeOfId, takeoverSuffix, lookupStatus, judgeRoutes, ipToInt, cidrRange },
};
