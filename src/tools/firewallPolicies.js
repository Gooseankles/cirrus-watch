// Firewall policies: every Azure Firewall policy with its rule collection
// groups, rule collections and rules (the nested "rules inside rules"), plus
// firewalls that still use classic rules. Rules are put in the order the
// firewall really uses them (DNAT, then network, then application rules; a
// parent policy's rules before its child's; then group priority, collection
// priority and position), and each rule is compared with the rules before it:
// exact duplicates, denies an earlier allow already lets through, allows an
// earlier deny already blocks, rules a wider earlier rule already covers, and
// application rules a network rule answers first. Also over-wide rules (any to
// any, every port, every FQDN, DNAT of admin ports from anywhere), IP groups
// that do not exist, unused or empty policies, threat intelligence off and
// IDPS off on Premium. Each run saves the rules with their marks as
// firewall/inventory.json for the Rules view. IPv4 only; IPv6 entries and
// service tags are compared as names. Reader is enough.
const store = require("../findingsStore");
const tenants = require("../tenants");
const { resourceGraphQuery, armGet } = require("../armClient");
const { mapLimit, runChecks, itemErrors, nameOf } = require("./util");
const ip = require("./ipv4");

const TOOL_ID = "firewall-policies";
const INVENTORY_KEY = "firewall/inventory.json";
const RCG_API = "api-version=2024-05-01";
const CONCURRENCY = 8;
const MAX_PAGES = 20;
const MAX_COMPARE = 4000; // rules of one type in one policy compared pair by pair
const MAX_RULE_FINDINGS = 400; // rule findings per policy
const MAX_HOSTS = 20000;
const ADMIN_PORTS = [22, 23, 135, 139, 445, 1433, 1521, 3306, 3389, 5432, 5985, 5986, 6379, 9200, 27017];
const TYPE_RANK = { Nat: 0, Network: 1, Application: 2 };
const TYPE_LETTER = { Nat: "D", Network: "N", Application: "A" };

const list = (v) => (Array.isArray(v) ? v : v == null || v === "" ? [] : [v]);
const lower = (s) => String(s || "").toLowerCase();
const plural = (n, word) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/* ---------- Reading ---------- */

async function readAll() {
  const q = (kql) => resourceGraphQuery(kql, { toolId: TOOL_ID });
  const [policies, firewalls, ipGroups, hosts] = await Promise.all([
    q(`Resources | where type =~ 'microsoft.network/firewallpolicies'
      | project id = tolower(id), name, resourceGroup, subscriptionId, location,
          tier = tostring(properties.sku.tier), base = tolower(tostring(properties.basePolicy.id)),
          children = properties.childPolicies, firewalls = properties.firewalls, groups = properties.ruleCollectionGroups,
          threatIntel = tostring(properties.threatIntelMode), idps = tostring(properties.intrusionDetection.mode),
          dnsProxy = properties.dnsSettings.enableProxy, state = tostring(properties.provisioningState)`),
    q(`Resources | where type =~ 'microsoft.network/azurefirewalls'
      | project id = tolower(id), name, resourceGroup, subscriptionId, location, tier = tostring(properties.sku.tier),
          policy = tolower(tostring(properties.firewallPolicy.id)), threatIntel = tostring(properties.threatIntelMode),
          app = properties.applicationRuleCollections, net = properties.networkRuleCollections, nat = properties.natRuleCollections,
          state = tostring(properties.provisioningState)`),
    q(`Resources | where type =~ 'microsoft.network/ipgroups' | project id = tolower(id), name, ips = properties.ipAddresses`),
    // Private addresses of VMs and other NICs, for the Reach map (pick a VM instead of typing its address).
    q(`Resources | where type =~ 'microsoft.network/networkinterfaces'
      | mv-expand c = properties.ipConfigurations
      | project nic = name, vm = tostring(properties.virtualMachine.id), pe = tostring(properties.privateEndpoint.id),
          ip = tostring(c.properties.privateIPAddress), resourceGroup, subscriptionId
      | where ip != ''`).catch(() => []),
  ]);
  return { policies, firewalls, ipGroups, hosts };
}

async function readGroups(policyId) {
  let url = `https://management.azure.com${policyId}/ruleCollectionGroups?${RCG_API}`;
  const out = [];
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const body = (await armGet(url, TOOL_ID)) || {};
    out.push(...(body.value || []));
    url = body.nextLink;
  }
  return out;
}

/* ---------- Normalising: one shape for policy rules and classic rules ---------- */

function policyRule(r) {
  const type = r.ruleType === "NatRule" ? "Nat" : r.ruleType === "ApplicationRule" ? "Application" : "Network";
  return {
    name: r.name,
    type,
    ...(r.description && { description: r.description }),
    src: list(r.sourceAddresses),
    srcGroups: list(r.sourceIpGroups).map(lower),
    dst: list(r.destinationAddresses),
    dstGroups: list(r.destinationIpGroups).map(lower),
    fqdns: list(r.destinationFqdns),
    ports: list(r.destinationPorts),
    protocols: type === "Application" ? list(r.protocols).map((p) => `${p.protocolType}:${p.port}`) : list(r.ipProtocols),
    targets: list(r.targetFqdns),
    urls: list(r.targetUrls),
    tags: list(r.fqdnTags),
    categories: list(r.webCategories),
    ...(r.terminateTLS && { tls: true }),
    ...(type === "Nat" && { translated: `${r.translatedAddress || r.translatedFqdn || ""}:${r.translatedPort || ""}` }),
  };
}

function policyGroups(raw) {
  return raw.map((g) => {
    const p = g.properties || {};
    return {
      name: g.name,
      priority: Number(p.priority) || 0,
      collections: list(p.ruleCollections).map((c) => ({
        name: c.name,
        priority: Number(c.priority) || 0,
        kind: c.ruleCollectionType === "FirewallPolicyNatRuleCollection" ? "nat" : "filter",
        action: (c.action && c.action.type) || (c.ruleCollectionType === "FirewallPolicyNatRuleCollection" ? "DNAT" : "Allow"),
        rules: list(c.rules).map(policyRule),
      })),
    };
  });
}

// A classic firewall's three lists become one group, so they are drawn and checked like a policy.
function classicGroups(fw) {
  const coll = (c, type) => {
    const p = c.properties || {};
    const action = type === "Nat" ? "DNAT" : (p.action && p.action.type) || "Allow";
    return {
      name: c.name,
      priority: Number(p.priority) || 0,
      kind: type === "Nat" ? "nat" : "filter",
      action: action === "Dnat" ? "DNAT" : action,
      rules: list(p.rules).map((r) => ({
        name: r.name,
        type,
        ...(r.description && { description: r.description }),
        src: list(r.sourceAddresses),
        srcGroups: list(r.sourceIpGroups).map(lower),
        dst: list(r.destinationAddresses),
        dstGroups: list(r.destinationIpGroups).map(lower),
        fqdns: list(r.destinationFqdns),
        ports: list(r.destinationPorts),
        protocols: type === "Application" ? list(r.protocols).map((x) => `${x.protocolType}:${x.port}`) : list(r.protocols),
        targets: list(r.targetFqdns),
        urls: [],
        tags: list(r.fqdnTags),
        categories: [],
        ...(type === "Nat" && { translated: `${r.translatedAddress || r.translatedFqdn || ""}:${r.translatedPort || ""}` }),
      })),
    };
  };
  const collections = [...list(fw.nat).map((c) => coll(c, "Nat")), ...list(fw.net).map((c) => coll(c, "Network")), ...list(fw.app).map((c) => coll(c, "Application"))];
  return collections.length ? [{ name: "Classic rules", priority: 0, collections }] : [];
}

/* ---------- Sets: addresses, ports, protocols ---------- */

// { all, spans: merged [start, end], atoms: names (service tags, FQDNs, IPv6, missing IP groups) }
function addrSet(entries, groupIds, groups, missing) {
  const ranges = [];
  const atoms = new Set();
  let all = false;
  const add = (e) => {
    const s = String(e || "").trim();
    if (!s) return;
    if (s === "*" || s === "0.0.0.0/0" || /^any$/i.test(s)) return (all = true);
    const r = ip.parseEntry(s);
    if (r) ranges.push(r);
    else atoms.add(s.toLowerCase());
  };
  entries.forEach(add);
  for (const id of groupIds) {
    const g = groups.get(id);
    if (g) g.ips.forEach(add);
    else {
      atoms.add(`ipgroup:${id}`);
      if (missing) missing.add(id);
    }
  }
  return { all, spans: ip.merge(ranges), atoms };
}

function portSet(ports) {
  const ranges = [];
  const atoms = new Set();
  let all = false;
  for (const p of ports) {
    const s = String(p).trim();
    if (s === "*") all = true;
    else {
      const m = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(s);
      if (m) ranges.push({ start: Number(m[1]), end: Number(m[2] || m[1]) });
      else if (s) atoms.add(s);
    }
  }
  const spans = ip.merge(ranges);
  if (spans.length === 1 && spans[0][0] <= 1 && spans[0][1] >= 65535) all = true;
  return { all, spans, atoms };
}

function protoSet(protocols) {
  const atoms = new Set(protocols.map((p) => String(p).toUpperCase()));
  return { all: atoms.has("ANY"), spans: [], atoms };
}

function spansCover(a, b) {
  return b.every(([s, e]) => a.some(([as, ae]) => as <= s && e <= ae));
}
function setCovers(a, b) {
  if (a.all) return true;
  if (b.all) return false;
  for (const x of b.atoms) if (!a.atoms.has(x)) return false;
  return spansCover(a.spans, b.spans);
}
const setEmpty = (s) => !s.all && !s.spans.length && !s.atoms.size;

// "*.contoso.com" covers "a.contoso.com" and "*.b.contoso.com", not "contoso.com".
function fqdnCovers(a, b) {
  if (a === "*" || a === b) return true;
  return a.startsWith("*") && b.endsWith(a.slice(1)) && b.length > a.length - 1;
}

/* ---------- Matching ---------- */

function matcher(rule, groups, missing) {
  const m = {
    type: rule.type,
    src: addrSet(rule.src, rule.srcGroups, groups, missing),
    dst: addrSet([...rule.dst, ...rule.fqdns], rule.dstGroups, groups, missing),
  };
  if (rule.type === "Application") {
    m.protos = new Set(rule.protocols.map(lower));
    m.ports = portSet(rule.protocols.map((p) => String(p).split(":")[1] || ""));
    m.targets = rule.targets.map(lower);
    m.tags = new Set(rule.tags.map(lower));
    m.categories = new Set(rule.categories.map(lower));
    m.urls = new Set(rule.urls.map(lower));
    m.anyTarget = m.targets.includes("*");
    m.empty = setEmpty(m.src) || (!m.targets.length && !m.tags.size && !m.categories.size && !m.urls.size && setEmpty(m.dst));
  } else {
    m.ports = portSet(rule.ports);
    m.protos = protoSet(rule.protocols);
    m.empty = setEmpty(m.src) || setEmpty(m.dst);
  }
  return m;
}

const subset = (a, b) => [...b].every((x) => a.has(x));

// Does every packet rule b matches also match rule a? Same type only.
function covers(a, b) {
  if (!setCovers(a.src, b.src)) return false;
  if (b.type === "Application") {
    if (!subset(a.protos, b.protos)) return false;
    if (a.anyTarget) return true;
    if (!b.targets.every((t) => a.targets.some((x) => fqdnCovers(x, t)))) return false;
    if (b.anyTarget) return false;
    return subset(a.tags, b.tags) && subset(a.categories, b.categories) && subset(a.urls, b.urls) && setCovers(a.dst, b.dst);
  }
  return setCovers(a.dst, b.dst) && setCovers(a.ports, b.ports) && setCovers(a.protos, b.protos);
}

// A network rule the firewall checks before an application rule and that
// takes all its traffic: same sources (or wider), any destination, TCP, and
// every port the application rule listens on.
function networkTakes(n, a) {
  if (!setCovers(n.src, a.src) || !n.dst.all) return false;
  if (!(n.protos.all || n.protos.atoms.has("TCP"))) return false;
  return setCovers(n.ports, a.ports);
}

/* ---------- Analysis ---------- */

const where = (p) => ({ subscriptionId: p.subscriptionId, resourceGroup: lower(p.resourceGroup) });
const isAllow = (row) => row.action === "Allow" || row.action === "DNAT";
const label = (row) => `${TYPE_LETTER[row.type]}${row.order} ${row.name}`;
const at = (row) => `${row.group} › ${row.collection}${row.inherited ? ` (from ${row.inherited})` : ""}`;

// The rules of a policy with its parents' rules first, in processing order.
function effectiveRows(policy, byId) {
  const chain = [];
  const seen = new Set();
  for (let p = policy; p && !seen.has(p.id); p = p.base ? byId.get(p.base) : null) {
    seen.add(p.id);
    chain.unshift(p);
  }
  const rows = [];
  chain.forEach((p, depth) => {
    for (const g of p.groups || []) {
      for (const c of g.collections) {
        // DNAT rules belong to the firewalls of the policy that holds them; a child policy does not inherit them.
        if (p !== policy && c.kind === "nat") continue;
        c.rules.forEach((r, i) => {
          rows.push({
            ...r,
            group: g.name,
            groupPriority: g.priority,
            collection: c.name,
            collectionPriority: c.priority,
            action: c.action,
            depth,
            index: i,
            key: `${depth}|${g.name}|${c.name}|${i}`,
            ...(p !== policy && { inherited: p.name }),
          });
        });
      }
    }
  });
  rows.sort((a, b) => TYPE_RANK[a.type] - TYPE_RANK[b.type] || a.depth - b.depth || a.groupPriority - b.groupPriority || a.collectionPriority - b.collectionPriority || a.index - b.index);
  const n = { Nat: 0, Network: 0, Application: 0 };
  for (const r of rows) r.order = ++n[r.type];
  const parentFailed = chain.some((p) => p !== policy && (p.rulesError || p.rulesRead === false));
  return { rows, chain, chainBroken: !!(chain[0].base && !byId.has(chain[0].base)) || parentFailed };
}

// Marks on each rule (what an earlier rule does to it) and the findings for the policy's own rules.
function analyse(policy, byId, ipGroups) {
  const { rows, chain, chainBroken } = effectiveRows(policy, byId);
  const missing = new Set();
  const findings = [];
  const base = { ...where(policy), policy: policy.name };
  const ruleId = (r) => `${policy.id}/rules/${lower(r.group)}/${lower(r.collection)}/${lower(r.name)}`;
  const path = (r) => [{ t: "policy", label: r.inherited || policy.name }, { t: "group", label: r.group }, { t: "coll", label: `${r.collection} · ${r.action}` }];
  const push = (r, suffix, kind, detail) => {
    if (r.inherited) return; // reported on the parent policy
    findings.push({ ...base, id: `${ruleId(r)}#${suffix}`, kind, name: r.name, path: path(r), ruleType: r.type, order: label(r), detail });
  };
  const ms = rows.map((r) => matcher(r, ipGroups, r.inherited ? null : missing));
  const capped = new Set();
  for (const type of ["Nat", "Network", "Application"]) {
    const idx = rows.map((r, i) => (r.type === type ? i : -1)).filter((i) => i >= 0);
    if (idx.length > MAX_COMPARE) {
      capped.add(type);
      continue;
    }
    for (let k = 0; k < idx.length; k++) {
      const b = rows[idx[k]];
      const mb = ms[idx[k]];
      if (mb.empty) continue;
      let hit = null;
      for (let j = 0; j < k && !hit; j++) {
        const ma = ms[idx[j]];
        if (!ma.empty && covers(ma, mb)) hit = rows[idx[j]];
      }
      // An application rule a network rule answers first.
      let byNet = null;
      if (type === "Application") {
        for (let j = 0; j < rows.length && !byNet; j++) if (rows[j].type === "Network" && !ms[j].empty && networkTakes(ms[j], mb)) byNet = rows[j];
      }
      const first = byNet || hit;
      if (!first) continue;
      const mf = byNet ? ms[rows.indexOf(byNet)] : ms[rows.indexOf(hit)];
      const same = !byNet && covers(mb, mf);
      const sameDest = b.type !== "Nat" || b.translated === first.translated;
      let kind, mark, detail;
      const who = `${label(first)} in ${at(first)}`;
      if (b.type === "Nat" && !sameDest) {
        kind = "fw-shadowed-allow";
        mark = "never hit";
        detail = `Never used: ${who} catches the same traffic first and sends it to ${first.translated}, not ${b.translated}`;
      } else if (isAllow(first) !== isAllow(b)) {
        kind = isAllow(b) ? "fw-shadowed-allow" : "fw-shadowed-deny";
        mark = "never hit";
        detail = isAllow(b)
          ? `Never used: ${who} denies all of this traffic first, so this allow does nothing`
          : `Never used: ${who} already allows all of this traffic, so this deny blocks nothing`;
        if (byNet) detail += " (network rules are checked before application rules)";
      } else if (same) {
        kind = "fw-duplicate";
        mark = "duplicate";
        detail = `Same match as ${who}. Remove one of them`;
      } else {
        kind = "fw-redundant";
        mark = "covered";
        detail = byNet
          ? `${who} is a network rule that already lets this traffic through before application rules are checked; this rule is never used`
          : `${who} already covers all of this traffic with the same action; removing this rule changes nothing`;
      }
      b.mark = { kind: mark, by: label(first), text: detail };
      push(b, "covered", kind, detail);
    }
  }
  // Over-wide rules.
  rows.forEach((r, i) => {
    const m = ms[i];
    const wide = [];
    if (m.empty) {
      wide.push("matches nothing");
      return void (r.wide = wide);
    }
    if (r.type === "Network" && r.action === "Allow") {
      if (m.src.all && m.dst.all && m.ports.all && m.protos.all) {
        wide.push("any to any");
        push(r, "anyany", "fw-any-any", "Allows every protocol and port from any source to any destination: the firewall lets everything through here");
      } else if (m.ports.all && (m.protos.all || [...m.protos.atoms].some((p) => p !== "ICMP"))) {
        wide.push("every port");
        push(r, "anyport", "fw-any-port", `Allows every port${m.protos.all ? " and protocol" : ""}${m.src.all ? " from any source" : ""}${m.dst.all ? " to any destination" : ""}. List the ports the service needs`);
      }
    }
    if (r.type === "Application" && r.action === "Allow" && m.anyTarget) {
      wide.push("every FQDN");
      push(r, "anyfqdn", "fw-app-any-fqdn", `Allows ${m.src.all ? "any source" : "these sources"} to reach every web address on ${r.protocols.join(", ") || "its protocols"}. Name the sites instead`);
    }
    if (r.type === "Nat" && m.src.all) {
      const port = Number(String(r.translated || "").split(":").pop());
      const open = ADMIN_PORTS.filter((p) => p === port || m.ports.spans.some(([s, e]) => s <= p && p <= e));
      if (open.length) {
        wide.push("admin port from anywhere");
        push(r, "dnatadmin", "fw-dnat-open-admin", `Forwards port ${open.join(", ")} from any internet address to ${r.translated}: remote admin or database ports open to the world. Limit the sources or use Bastion or a VPN`);
      }
    }
    if (wide.length) r.wide = wide;
  });
  // Network rules with FQDNs only match reliably when the firewall resolves names itself (DNS proxy).
  const fqdnRules = rows.filter((r) => !r.inherited && r.type === "Network" && r.fqdns.length);
  // A policy no firewall uses only matters through its children, which may turn DNS proxy on themselves.
  const users = policy.firewalls.length || !policy.children.length ? [policy] : policy.children.map((id) => byId.get(id)).filter(Boolean);
  if (fqdnRules.length && !policy.classic && users.some((p) => !p.dnsProxy)) {
    findings.push({
      ...base, id: `${policy.id}#dnsproxy`, kind: "fw-fqdn-no-dns-proxy", name: policy.name, count: fqdnRules.length,
      detail: `${plural(fqdnRules.length, "network rule")} use FQDNs (${fqdnRules.slice(0, 3).map((r) => r.name).join(", ")}) but DNS proxy is off: the firewall and the clients can resolve the names to different addresses, so the rules miss traffic. Turn on DNS proxy and point the VNets' DNS at the firewall`,
    });
  }
  if (missing.size) {
    findings.push({
      ...base, id: `${policy.id}#ipgroup-missing`, kind: "fw-ipgroup-missing", name: policy.name, count: missing.size,
      detail: `Rules use ${plural(missing.size, "IP group")} that could not be found: ${[...missing].slice(0, 5).map(nameOf).join(", ")}${missing.size > 5 ? ` and ${missing.size - 5} more` : ""}. They may be deleted or in a subscription the scan cannot read`,
    });
  }
  for (const type of capped) {
    findings.push({ ...base, id: `${policy.id}#capped-${lower(type)}`, kind: "fw-not-compared", name: policy.name, detail: `More than ${MAX_COMPARE.toLocaleString("en-US")} ${type === "Nat" ? "DNAT" : lower(type)} rules: they were listed but not compared with each other` });
  }
  if (chainBroken) {
    findings.push({ ...base, id: `${policy.id}#base-missing`, kind: "fw-not-compared", name: policy.name, detail: "The rules of its parent policy could not be read, so inherited rules are missing here and duplicates against them are not found. Give the scan Reader on the parent's subscription" });
  }
  // Keep the page and the list readable on a policy full of duplicates.
  const ruleFindings = findings.filter((f) => f.ruleType);
  if (ruleFindings.length > MAX_RULE_FINDINGS) {
    const keep = new Set(ruleFindings.slice(0, MAX_RULE_FINDINGS));
    const dropped = ruleFindings.length - MAX_RULE_FINDINGS;
    return {
      rows,
      chain,
      findings: [
        ...findings.filter((f) => !f.ruleType || keep.has(f)),
        { ...base, id: `${policy.id}#more`, kind: "fw-not-compared", name: policy.name, detail: `${plural(dropped, "more rule finding")} left out; the Rules view marks every rule` },
      ],
    };
  }
  return { rows, chain, findings };
}

function policyFindings(p) {
  const out = [];
  const base = { ...where(p), id: p.id, name: p.name, policy: p.name };
  if (p.state && p.state !== "Succeeded") {
    out.push({ ...base, id: `${p.id}#state`, kind: "fw-policy-failed", detail: `Provisioning state is ${p.state}: the last change did not finish, so the firewalls may run older rules. Save the policy again` });
  }
  if (p.classic) {
    out.push({ ...base, id: `${p.id}#classic`, kind: "fw-classic-rules", detail: "Uses classic rules on the firewall itself. Microsoft recommends a firewall policy: it can be shared, inherited and holds IDPS and TLS settings" });
  } else if (!p.firewalls.length && !p.children.length) {
    out.push({ ...base, id: `${p.id}#unused`, kind: "fw-policy-unused", detail: "No firewall and no child policy uses it. Delete it if it is not needed" });
  }
  if (p.rulesRead && !p.ruleCount && !p.inheritedCount) {
    out.push({ ...base, id: `${p.id}#empty`, kind: "fw-empty", detail: p.firewalls.length ? `Has no rules but ${plural(p.firewalls.length, "firewall")} uses it: everything not allowed elsewhere is denied` : "Has no rules" });
  }
  if (lower(p.threatIntel) === "off") {
    out.push({ ...base, id: `${p.id}#ti`, kind: "fw-threat-intel-off", detail: "Threat intelligence is off: traffic to and from known malicious addresses and domains is not even logged. Set it to Alert or Alert and deny" });
  }
  if (lower(p.tier) === "premium" && !p.classic && (!p.idps || lower(p.idps) === "off")) {
    out.push({ ...base, id: `${p.id}#idps`, kind: "fw-idps-off", detail: "Premium policy with IDPS off: you pay for intrusion detection and do not use it. Set it to Alert or Alert and deny" });
  }
  return out;
}

// What the Rules view needs: the parents' groups first, then the policy's
// own, each in priority order with its collections (empty ones too) and rules
// with their marks.
function viewOf(chain, rows) {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const byPriority = (a, b) => a.priority - b.priority;
  const out = [];
  chain.forEach((p, depth) => {
    for (const g of [...(p.groups || [])].sort(byPriority)) {
      if (depth < chain.length - 1 && g.collections.every((c) => c.kind === "nat")) continue;
      out.push({
        name: g.name,
        priority: g.priority,
        ...(depth < chain.length - 1 && { inherited: p.name }),
        collections: [...g.collections].filter((c) => depth === chain.length - 1 || c.kind !== "nat").sort(byPriority).map((c) => ({
          name: c.name,
          priority: c.priority,
          action: c.action,
          rules: c.rules
            .map((_, i) => byKey.get(`${depth}|${g.name}|${c.name}|${i}`))
            .filter(Boolean)
            .map((r) => {
              const x = { ...r };
              for (const k of ["group", "groupPriority", "collection", "collectionPriority", "depth", "inherited", "key", "action"]) delete x[k];
              for (const k of ["src", "srcGroups", "dst", "dstGroups", "fqdns", "ports", "targets", "urls", "tags", "categories"]) if (!x[k].length) delete x[k];
              return x;
            }),
        })),
      });
    }
  });
  return out;
}

/* ---------- Run ---------- */

function build(d, groupsById, failed) {
  const ipGroups = new Map(d.ipGroups.map((g) => [lower(g.id), { name: g.name, ips: list(g.ips).map(String) }]));
  const refs = (v) => list(v).map((x) => lower(x && x.id)).filter(Boolean);
  const fwByPolicy = new Map();
  for (const fw of d.firewalls) if (fw.policy) (fwByPolicy.get(fw.policy) || fwByPolicy.set(fw.policy, []).get(fw.policy)).push(fw.name);
  const policies = d.policies.map((p) => ({
    id: p.id, name: p.name, resourceGroup: lower(p.resourceGroup), subscriptionId: p.subscriptionId, location: p.location,
    tier: p.tier || "Standard", base: p.base || "", children: refs(p.children),
    firewalls: refs(p.firewalls).length ? refs(p.firewalls).map(nameOf) : fwByPolicy.get(p.id) || [],
    threatIntel: p.threatIntel, idps: p.idps, dnsProxyOwn: p.dnsProxy == null || p.dnsProxy === "" ? null : String(p.dnsProxy).toLowerCase() === "true", state: p.state,
    rulesRead: groupsById.has(p.id), ...(failed.has(p.id) && { rulesError: failed.get(p.id) }),
    groups: policyGroups(groupsById.get(p.id) || []),
  }));
  for (const fw of d.firewalls.filter((f) => !f.policy)) {
    policies.push({
      id: fw.id, name: fw.name, resourceGroup: lower(fw.resourceGroup), subscriptionId: fw.subscriptionId, location: fw.location,
      tier: fw.tier || "Standard", base: "", children: [], firewalls: [fw.name], threatIntel: fw.threatIntel, state: fw.state,
      classic: true, rulesRead: true, groups: classicGroups(fw),
    });
  }
  const byId = new Map(policies.map((p) => [p.id, p]));
  // DNS proxy as the firewall runs it: the policy's own setting, else the nearest parent's.
  for (const p of policies) {
    const seen = new Set();
    let q = p;
    while (q && q.dnsProxyOwn == null && q.base && !seen.has(q.id)) {
      seen.add(q.id);
      q = byId.get(q.base);
    }
    p.dnsProxy = !!(q && q.dnsProxyOwn);
  }
  for (const p of policies) delete p.dnsProxyOwn;
  const findings = [];
  for (const p of policies) {
    p.ruleCount = p.groups.reduce((n, g) => n + g.collections.reduce((m, c) => m + c.rules.length, 0), 0);
    const { rows, chain, findings: f } = analyse(p, byId, ipGroups);
    p.inheritedCount = rows.filter((r) => r.inherited).length;
    p.view = viewOf(chain, rows);
    p.marks = { duplicate: 0, "never hit": 0, covered: 0, wide: 0 };
    for (const r of rows.filter((x) => !x.inherited)) {
      if (r.mark) p.marks[r.mark.kind]++;
      if (r.wide && r.wide.length) p.marks.wide++;
    }
    p.findingCount = f.length;
    findings.push(...f, ...policyFindings(p));
  }
  for (const p of policies) delete p.groups;
  const hosts = (d.hosts || []).slice(0, MAX_HOSTS).map((h) => ({
    name: h.vm ? nameOf(h.vm) : h.pe ? `${nameOf(h.pe)} (private endpoint)` : h.nic,
    kind: h.vm ? "vm" : h.pe ? "pe" : "nic",
    ip: h.ip,
    resourceGroup: lower(h.resourceGroup),
    subscriptionId: h.subscriptionId,
  }));
  return { policies, findings, hosts, ipGroups: Object.fromEntries([...ipGroups].map(([id, g]) => [id, { name: g.name, count: g.ips.length, ips: g.ips }])) };
}

async function run() {
  let doc;
  const findings = await runChecks(TOOL_ID, {
    Policies: async () => {
      const d = await readAll();
      const groupsById = new Map();
      const failedMap = new Map();
      const withGroups = d.policies.filter((p) => list(p.groups).length);
      for (const p of d.policies) if (!list(p.groups).length) groupsById.set(p.id, []);
      const failures = await mapLimit(withGroups, CONCURRENCY, async (p) => {
        try {
          groupsById.set(p.id, await readGroups(p.id));
        } catch (err) {
          failedMap.set(p.id, String(err.message || err).slice(0, 200));
          throw err;
        }
      });
      doc = build(d, groupsById, failedMap);
      return [...doc.findings, ...itemErrors(TOOL_ID, "rule-groups", "policies' rules", failures, withGroups.length)];
    },
  });
  if (doc) await store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), policies: doc.policies, hosts: doc.hosts, ipGroups: doc.ipGroups });
  return findings;
}

async function inventory(keys) {
  const out = { updatedAt: null, policies: [], hosts: [], ipGroups: {}, tenants: [], failures: [] };
  for (const k of keys) {
    let doc;
    try {
      doc = await store.getDoc(INVENTORY_KEY, k);
    } catch (err) {
      out.failures.push({ tenant: k, error: `could not read the saved rules: ${err.message}` });
      continue;
    }
    if (!doc) continue;
    if (doc.updatedAt && (!out.updatedAt || doc.updatedAt > out.updatedAt)) out.updatedAt = doc.updatedAt;
    out.tenants.push({ key: k, name: tenants.nameOf(k) });
    out.policies.push(...(doc.policies || []).map((p) => ({ ...p, tenant: k })));
    out.hosts.push(...(doc.hosts || []).map((h) => ({ ...h, tenant: k })));
    Object.assign(out.ipGroups, doc.ipGroups || {});
  }
  return out;
}

function registerRoutes(app, { readKeys, decorate }) {
  app.get("/api/firewall-policies", async (req, res) => {
    try {
      const inv = await inventory(readKeys(req));
      await decorate(TOOL_ID, inv.policies);
      res.json(inv);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Firewall policies",
  schedule: "50 4 * * *", // daily at 04:50
  run,
  registerRoutes,
  _test: { build, analyse, covers, matcher, fqdnCovers, addrSet, portSet },
};
