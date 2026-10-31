// The organisation's own internet domains and their mail settings. Domains come
// from what the scan identity can already read: the suffixes of member user
// names and mail addresses (Graph, User.Read.All), App Service custom host
// names, Azure DNS zones and App Service Domains (Resource Graph, Reader).
// Graph's domain list is not used: it needs Domain.Read.All, which the app does
// not have. For each registrable domain the public registration data (RDAP,
// through rdap.org) gives the expiry date and the registrar lock; public DNS
// gives the delegation of Azure DNS zones and, for domains that receive mail,
// SPF, DMARC and (for Exchange Online) DKIM. Nothing in the tenant is changed;
// the public lookups send only domain names.
//
// Off by default: DOMAIN_CHECKS = on (or "dns" for DNS only, no RDAP) turns it
// on per tenant; when off, run() returns at once and calls nothing.
//
// Removal checklist (this tool is opt-in and may be dropped). Delete
// src/tools/domains.js and test/domains.test.js, then remove the lines that
// mention "domains" / "Domains and mail" / DOMAIN_CHECKS in:
//   server.js (registerScanTool line), src/toolPermissions.js (NEEDS),
//   src/access.js (TOOL_AREAS), src/settings.js (DOMAIN_CHECKS field and
//   TOOL_SPNS entry), public/app.js (TOOLS entry and the domain-, asd-, spf-,
//   dmarc-, dkim-, dns-zone-not-delegated KINDS), public/compliance.js
//   (KIND_CONTROLS block and TOOL_KINDS entry), .env.example (DOMAIN_CHECKS
//   block), docs/tools.md (section), docs/permissions.md (Reader row note),
//   docs/architecture.md, docs/lld-setup.md and docs/hld.md (outbound hosts
//   sentence). Then run npm run docs and npm run diagrams -- arch-inside-app
//   (tool count). DATA_DIR/rdap-cache.json can be deleted.
const dns = require("dns");
const fs = require("fs");
const path = require("path");
const settings = require("../settings");
const { DATA_DIR } = require("../paths");
const { writeAtomic } = require("../jsonFile");
const { graphGet } = require("../graphClient");
const { resourceGraphQuery } = require("../armClient");
const { mapLimit, runChecks, scanError, graphHint, daysUntil } = require("./util");

const TOOL_ID = "domains";
const MAX_USERS = 200000; // user accounts read for their name and mail suffixes
const MAX_DOMAINS = 300; // domains whose mail settings are checked
const MAX_REGISTRABLE = 200; // registrable domains looked up in RDAP
const RDAP_URL = "https://rdap.org/domain/";
const RDAP_TTL_MS = 24 * 3600 * 1000;
const RDAP_KEEP_MS = 7 * RDAP_TTL_MS; // a failed lookup falls back to an answer up to a week old
const RDAP_TIMEOUT_MS = 10000;
const RDAP_CONCURRENCY = 3;
const DNS_CONCURRENCY = 8;
const SPF_MAX_LOOKUPS = 10; // RFC 7208 4.6.4
const SPF_MAX_DEPTH = 10;
const EXPIRY_HIGH_DAYS = 30;
const EXPIRY_MEDIUM_DAYS = 60;
const CACHE_FILE = path.join(DATA_DIR, "rdap-cache.json");

const arr = (a) => (Array.isArray(a) ? a : []);
const lc = (s) => String(s || "").toLowerCase();
const cleanHost = (h) => lc(h).trim().replace(/\.$/, "");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/* ---------- Which domains ---------- */

// Public suffixes with more than one label that are common enough to matter. A short list, not the full Public
// Suffix List: a domain under a multi-part suffix that is missing here is treated as one level too high (for
// example "example.ac.za" as "ac.za"), so its registration lookup finds nothing and is skipped quietly.
const MULTI_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "ac.uk", "gov.uk", "nhs.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "asn.au", "id.au",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "gov.za", "ac.za",
  "priv.no", "stat.no", "dep.no", "mil.no", "vgs.no", "fhs.no", "idrett.no", "museum.no",
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp",
  "com.br", "net.br", "org.br", "gov.br",
  "com.mx", "org.mx", "gob.mx",
  "co.in", "net.in", "org.in", "gov.in",
  "co.kr", "or.kr", "com.cn", "net.cn", "org.cn", "gov.cn", "com.hk", "com.sg", "com.tw", "com.my",
  "co.il", "org.il", "com.tr", "gov.tr", "com.ar", "com.co", "com.pl", "co.at", "or.at", "ac.at",
]);

// Names Microsoft owns: tenant default domains and the default host names of Azure services.
const MICROSOFT_DOMAINS = new Set([
  "onmicrosoft.com", "onmschina.cn", "azurewebsites.net", "azurewebsites.us", "chinacloudsites.cn", "cloudapp.net", "azure.com",
  "azure.net", "windows.net", "trafficmanager.net", "azurefd.net", "azureedge.net", "azurestaticapps.net", "azure-api.net",
  "azurecontainer.io", "azurecontainerapps.io", "appserviceenvironment.net", "microsoft.com", "microsoftonline.com",
]);

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

// "Shop.Example.co.uk." -> "example.co.uk"; null for a bad name, a bare suffix or a Microsoft-owned name.
function registrableDomain(name) {
  const host = cleanHost(name).replace(/^\*\./, "");
  if (!HOST_RE.test(host)) return null;
  const labels = host.split(".");
  const two = labels.slice(-2).join(".");
  const keep = MULTI_SUFFIXES.has(two) ? 3 : 2;
  if (labels.length < keep) return null;
  const reg = labels.slice(-keep).join(".");
  if (MICROSOFT_DOMAINS.has(reg) || MICROSOFT_DOMAINS.has(two)) return null;
  return reg;
}

// A domain name worth checking itself (not only its registrable parent): valid, public, not Microsoft's.
const usableDomain = (name) => {
  const host = cleanHost(name).replace(/^\*\./, "");
  return registrableDomain(host) ? host : null;
};

// The domain part of "someone@example.com" or "SMTP:someone@example.com".
const domainOfAddress = (s) => {
  const m = String(s || "").match(/@([^@\s>]+)$/);
  return m ? m[1] : null;
};

// Graph users -> Set of domains from member user names and SMTP addresses (guests' names hold another tenant's domain).
function domainsFromUsers(users) {
  const out = new Set();
  for (const u of users) {
    const upn = String((u && u.userPrincipalName) || "");
    if (!upn || upn.includes("#EXT#")) continue;
    const add = (d) => {
      const host = usableDomain(d);
      if (host) out.add(host);
    };
    add(domainOfAddress(upn));
    for (const p of arr(u.proxyAddresses)) if (/^smtp:/i.test(p)) add(domainOfAddress(p));
  }
  return out;
}

async function userDomains() {
  let next = "/users?$select=userPrincipalName,proxyAddresses&$top=999";
  const users = [];
  try {
    while (next && users.length < MAX_USERS) {
      const page = await graphGet(next, TOOL_ID);
      users.push(...arr(page.value));
      next = page["@odata.nextLink"] || null;
    }
  } catch (err) {
    throw new Error(graphHint(err, "User.Read.All"));
  }
  return { domains: domainsFromUsers(users), capped: Boolean(next) };
}

async function azureSources() {
  const q = (kql) => resourceGraphQuery(kql, { toolId: TOOL_ID });
  const [hosts, zones, registered] = await Promise.all([
    q(`resources
    | where type in~ ('microsoft.web/sites', 'microsoft.web/sites/slots')
    | mv-expand h = properties.hostNames
    | project h = tolower(tostring(h))
    | where isnotempty(h)
    | distinct h`),
    q(`resources
    | where type =~ 'microsoft.network/dnszones'
    | project id, name = tolower(name), resourceGroup, subscriptionId, zoneType = tostring(properties.zoneType), nameServers = properties.nameServers`),
    q(`resources
    | where type =~ 'microsoft.domainregistration/domains'
    | project id, name = tolower(name), resourceGroup, subscriptionId, expirationTime = tostring(properties.expirationTime),
        autoRenew = properties.autoRenew, status = tostring(properties.registrationStatus)`),
  ]);
  return {
    hosts: hosts.map((r) => r.h),
    zones: zones.filter((z) => !/^private$/i.test(z.zoneType)),
    registered,
  };
}

/* ---------- RDAP (registration data) ---------- */

// RDAP status "client transfer prohibited" or EPP "clientTransferProhibited" -> "clienttransferprohibited".
const normStatus = (s) => lc(s).replace(/[^a-z]/g, "");

// One RDAP domain reply -> { expires (ISO or null), statuses, locked (true/false/null), registrar }. Pure, for the tests.
function rdapSummary(json) {
  const events = arr(json && json.events);
  const exp = events.find((e) => /^expiration$/i.test(String((e && e.eventAction) || "")) && !Number.isNaN(Date.parse(e.eventDate)));
  const statuses = arr(json && json.status).map(String);
  const norm = statuses.map(normStatus);
  const locked = statuses.length ? norm.includes("clienttransferprohibited") || norm.includes("servertransferprohibited") : null;
  let registrar = null;
  for (const ent of arr(json && json.entities)) {
    if (!arr(ent && ent.roles).some((r) => /^registrar$/i.test(r))) continue;
    const card = arr(arr(ent.vcardArray)[1]).find((f) => Array.isArray(f) && f[0] === "fn");
    registrar = (card && String(card[3])) || (ent.handle && String(ent.handle)) || null;
    break;
  }
  return { expires: exp ? new Date(exp.eventDate).toISOString() : null, statuses, locked, registrar };
}

// Days left -> finding kind, or null when there is time enough.
function expiryKind(days) {
  if (days < 0) return "domain-expired";
  if (days < EXPIRY_HIGH_DAYS) return "domain-expiring";
  if (days < EXPIRY_MEDIUM_DAYS) return "domain-renewal-due";
  return null;
}

// The registrar lock check only means something under generic TLDs; country registries often have no such status.
const isGenericTld = (domain) => !/\.[a-z]{2}$/.test(domain);

// DOMAIN_CHECKS: off (default), on, or dns (everything but the RDAP lookups).
const mode = () => {
  const v = lc(String(settings.get("DOMAIN_CHECKS") || "").trim());
  return v === "on" || v === "dns" ? v : "off";
};

function readCache() {
  try {
    const kept = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    return kept && typeof kept === "object" && kept.domains ? kept : { domains: {} };
  } catch {
    return { domains: {} };
  }
}

// { status: "ok", summary } | { status: "none" } (no RDAP for that TLD or not registered) | throws on a failure.
async function fetchRdap(domain) {
  const res = await fetch(RDAP_URL + encodeURIComponent(domain), {
    signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
    headers: { Accept: "application/rdap+json, application/json", "User-Agent": "CirrusWatch domain check (self-hosted Azure dashboard)" },
    redirect: "follow",
  });
  if (res.status === 404 || res.status === 400 || res.status === 501) return { status: "none" };
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { status: "ok", summary: rdapSummary(await res.json()) };
}

// domain -> { status: "ok" | "none" | "failed", summary?, at }. Answers younger than a day come from the kept copy;
// a failed lookup uses a kept answer up to a week old.
async function rdapLookup(domains) {
  const kept = readCache();
  const now = Date.now();
  const out = new Map();
  const ask = [];
  for (const d of domains) {
    const k = kept.domains[d];
    if (k && now - Date.parse(k.at) < RDAP_TTL_MS) out.set(d, k);
    else ask.push(d);
  }
  let failedInRow = 0;
  await mapLimit(ask, RDAP_CONCURRENCY, async (d) => {
    if (failedInRow >= 5) {
      // rdap.org is down or blocked: stop asking.
      const k = kept.domains[d];
      out.set(d, k && now - Date.parse(k.at) < RDAP_KEEP_MS ? k : { status: "failed", error: "skipped after repeated failures" });
      return;
    }
    try {
      const got = await fetchRdap(d);
      failedInRow = 0;
      const entry = { ...got, at: new Date().toISOString() };
      kept.domains[d] = entry;
      out.set(d, entry);
    } catch (err) {
      failedInRow++;
      const k = kept.domains[d];
      out.set(d, k && now - Date.parse(k.at) < RDAP_KEEP_MS ? k : { status: "failed", error: String(err.message || err).slice(0, 200) });
    }
  });
  if (ask.length) {
    for (const [d, v] of Object.entries(kept.domains)) if (now - Date.parse(v.at) > RDAP_KEEP_MS) delete kept.domains[d];
    try {
      writeAtomic(CACHE_FILE, kept);
    } catch {
      // still usable for this run
    }
  }
  return out;
}

function rdapFindings(domain, summary, { skipExpiry = false } = {}) {
  const out = [];
  const base = { id: `${TOOL_ID}/${domain}`, name: domain, resourceGroup: null, subscriptionId: null };
  const by = summary.registrar ? ` (registrar ${summary.registrar})` : "";
  if (summary.expires && !skipExpiry) {
    const days = daysUntil(summary.expires);
    const kind = expiryKind(days);
    const date = summary.expires.slice(0, 10);
    const text = {
      "domain-expired": `The registration of ${domain} expired on ${date}${by}. Renew it now: mail and websites on it stop working, and someone else can register it`,
      "domain-expiring": `The registration of ${domain} expires on ${date}, in ${plural(days, "day")}${by}. Renew it or turn on auto-renew at the registrar`,
      "domain-renewal-due": `The registration of ${domain} expires on ${date}, in ${plural(days, "day")}${by}. Check that it renews automatically`,
    }[kind];
    if (kind) out.push({ ...base, id: `${base.id}#${kind}`, kind, expires: summary.expires, detail: text });
  }
  if (summary.locked === false && isGenericTld(domain)) {
    out.push({
      ...base,
      id: `${base.id}#domain-unlocked`,
      kind: "domain-unlocked",
      detail: `${domain} has no transfer lock (status: ${summary.statuses.join(", ") || "none"})${by}. Turn on the registrar lock so the domain cannot be moved to another registrar without you`,
    });
  }
  return out;
}

/* ---------- App Service Domains ---------- */

function judgeAppServiceDomain(d) {
  const base = { name: d.name, resourceGroup: d.resourceGroup, subscriptionId: d.subscriptionId };
  const out = [];
  const auto = d.autoRenew === true || /^true$/i.test(String(d.autoRenew));
  if (d.expirationTime && !Number.isNaN(Date.parse(d.expirationTime))) {
    const days = daysUntil(d.expirationTime);
    const kind = expiryKind(days);
    const date = new Date(d.expirationTime).toISOString().slice(0, 10);
    if (kind) {
      const left = days < 0 ? `expired on ${date}` : `expires on ${date}, in ${plural(days, "day")}`;
      out.push({
        ...base,
        id: `${d.id}#${kind}`,
        kind,
        expires: new Date(d.expirationTime).toISOString(),
        detail: `App Service Domain ${d.name} ${left}${auto ? " (auto-renew is on: check the payment method of the subscription)" : " and auto-renew is off"}. Renew it in the portal`,
      });
    }
  }
  if (!auto && !/^(expired|cancelled|deleted)$/i.test(String(d.status || ""))) {
    out.push({ ...base, id: `${d.id}#asd-auto-renew-off`, kind: "asd-auto-renew-off", detail: `App Service Domain ${d.name} does not renew by itself. Turn on auto-renew, or note the expiry date somewhere it will be seen` });
  }
  return out;
}

/* ---------- DNS zone delegation ---------- */

// zoneNs: the zone's name servers in Azure; publicNs: what public DNS answers for the zone's NS (null = the name does not
// exist). Returns null when they match, otherwise { missing, extra } (lower-case, no trailing dot).
function compareDelegation(zoneNs, publicNs) {
  const want = new Set(arr(zoneNs).map(cleanHost).filter(Boolean));
  const got = new Set(arr(publicNs).map(cleanHost).filter(Boolean));
  if (!want.size) return null;
  const missing = [...want].filter((n) => !got.has(n));
  const extra = [...got].filter((n) => !want.has(n));
  return missing.length || extra.length ? { missing, extra } : null;
}

async function zoneFindings(zones, resolver) {
  const findings = [];
  let unknown = 0;
  await mapLimit(zones, DNS_CONCURRENCY, async (z) => {
    let ns;
    try {
      ns = await resolver.resolveNs(z.name);
    } catch (err) {
      if (err && (err.code === "ENOTFOUND" || err.code === "ENODATA")) ns = [];
      else {
        unknown++;
        return;
      }
    }
    const diff = compareDelegation(z.nameServers, ns);
    if (!diff) return;
    const detail = !ns.length
      ? `Public DNS does not know ${z.name}: the zone is not delegated, so its records answer nothing on the internet. Set its name servers (${arr(z.nameServers).map(cleanHost).join(", ")}) at the registrar or parent zone, or delete the zone`
      : diff.missing.length === arr(z.nameServers).length
        ? `Public DNS sends ${z.name} to other name servers (${ns.map(cleanHost).join(", ")}), not to this Azure DNS zone, so its records are not used. Point the delegation at the zone's name servers or delete the zone`
        : `The delegation of ${z.name} only partly matches this Azure DNS zone: public DNS lists ${ns.map(cleanHost).join(", ")}${diff.missing.length ? `; missing ${diff.missing.join(", ")}` : ""}. Use exactly the zone's four name servers`;
    findings.push({ kind: "dns-zone-not-delegated", id: `${z.id}#delegation`, name: z.name, resourceGroup: z.resourceGroup, subscriptionId: z.subscriptionId, detail });
  });
  if (unknown) findings.push(scanError(TOOL_ID, "delegation-lookups", `${plural(unknown, "DNS zone")} not judged: the DNS lookup failed`, "The server could not reach public DNS or the lookup timed out"));
  return findings;
}

/* ---------- Mail: SPF, DMARC, DKIM ---------- */

// TXT answers come as arrays of strings of at most 255 characters; one record is their concatenation.
const txtRecords = (answer) => arr(answer).map((r) => (Array.isArray(r) ? r.join("") : String(r)));
const spfRecords = (txts) => txts.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));

// "v=spf1 include:_spf.example.com mx -all" -> { all, redirect, lookups (in this record), follow: [domains] }. Pure.
// Mechanisms that cost a DNS lookup (RFC 7208 4.6.4): include, a, mx, ptr, exists and the redirect modifier.
function parseSpf(text) {
  const terms = String(text || "").trim().split(/\s+/).slice(1);
  let all = null;
  let redirect = null;
  let lookups = 0;
  const follow = [];
  for (const raw of terms) {
    const t = raw.toLowerCase();
    const m = t.match(/^([+?~-]?)(all|include|a|mx|ptr|exists|ip4|ip6)(?=$|[:/])(?::(.*))?/);
    if (m) {
      const [, q, mech, value] = m;
      if (mech === "all") all = q || "+";
      else if (["include", "a", "mx", "ptr", "exists"].includes(mech)) {
        lookups++;
        if (mech === "include" && value && !value.includes("%")) follow.push(cleanHost(value));
      }
      continue;
    }
    const r = t.match(/^redirect=(.+)$/);
    if (r) {
      redirect = cleanHost(r[1]);
      lookups++;
      if (!redirect.includes("%")) follow.push(redirect);
    }
  }
  // A redirect only applies when there is no "all".
  return { all: all || null, redirect: all ? null : redirect, lookups, follow: all && redirect ? follow.filter((f) => f !== redirect) : follow };
}

// Counts the DNS lookups an SPF record costs, following include and redirect. getSpf(domain) -> record text or null.
// Returns { count, problems: [text] }. Loops and depth beyond SPF_MAX_DEPTH stop the walk.
async function countSpfLookups(record, getSpf, depth = 0, seen = new Set()) {
  const p = parseSpf(record);
  let count = p.lookups;
  const problems = [];
  if (depth >= SPF_MAX_DEPTH) return { count, problems: ["includes nested too deep"] };
  for (const d of p.follow) {
    if (seen.has(d)) {
      problems.push(`loop through ${d}`);
      continue;
    }
    seen.add(d);
    const sub = await getSpf(d);
    if (!sub) {
      problems.push(`${d} has no SPF record`);
      continue;
    }
    const r = await countSpfLookups(sub, getSpf, depth + 1, seen);
    count += r.count;
    problems.push(...r.problems);
  }
  return { count, problems };
}

// "v=DMARC1; p=quarantine; sp=none; rua=..." -> { valid, p, sp, tags }. Pure.
function parseDmarc(text) {
  const s = String(text || "").trim();
  if (!/^v\s*=\s*dmarc1\s*(;|$)/i.test(s)) return { valid: false, p: null, sp: null, tags: {} };
  const tags = {};
  for (const part of s.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) tags[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  const pol = (v) => (/^(none|quarantine|reject)$/i.test(v || "") ? v.toLowerCase() : null);
  return { valid: Boolean(pol(tags.p)), p: pol(tags.p), sp: pol(tags.sp), tags };
}

const dmarcRecords = (txts) => txts.filter((t) => /^v\s*=\s*dmarc1/i.test(t.trim()));

// One DNS answer or an empty list for "no such name / no such record"; other failures throw.
async function dnsList(fn) {
  try {
    return await fn();
  } catch (err) {
    if (err && (err.code === "ENOTFOUND" || err.code === "ENODATA")) return [];
    throw err;
  }
}

function makeSpfGetter(resolver) {
  const cache = new Map();
  return (domain) => {
    if (!cache.has(domain)) {
      cache.set(domain, dnsList(() => resolver.resolveTxt(domain)).then((txt) => spfRecords(txtRecords(txt))[0] || null).catch(() => null));
    }
    return cache.get(domain);
  };
}

// The DMARC policy in force for a domain: its own record, else the registrable domain's (sp, then p).
async function dmarcFor(domain, resolver) {
  const own = dmarcRecords(txtRecords(await dnsList(() => resolver.resolveTxt(`_dmarc.${domain}`))));
  if (own.length) return { records: own, from: domain };
  const org = registrableDomain(domain);
  if (org && org !== domain) {
    const parent = dmarcRecords(txtRecords(await dnsList(() => resolver.resolveTxt(`_dmarc.${org}`))));
    if (parent.length) return { records: parent, from: org, inherited: true };
  }
  return { records: [], from: domain };
}

async function hasDkim(name, resolver) {
  const cname = await dnsList(() => resolver.resolveCname(name));
  if (cname.length) return true;
  const txt = txtRecords(await dnsList(() => resolver.resolveTxt(name)));
  return txt.some((t) => /(^|;)\s*p=/i.test(t));
}

async function mailFindings(domain, resolver, getSpf) {
  const mx = await dnsList(() => resolver.resolveMx(domain));
  // No MX, or a null MX ("." : the domain says it takes no mail).
  const exchanges = mx.map((m) => cleanHost(m.exchange)).filter(Boolean);
  if (!exchanges.length) return [];
  const base = { name: domain, resourceGroup: null, subscriptionId: null };
  const id = (kind) => `${TOOL_ID}/${domain}#${kind}`;
  const out = [];

  const spf = spfRecords(txtRecords(await dnsList(() => resolver.resolveTxt(domain))));
  if (!spf.length) {
    out.push({ ...base, id: id("spf-missing"), kind: "spf-missing", detail: `${domain} receives mail (MX ${exchanges[0]}) but has no SPF record, so anyone can send mail as it more easily. Publish one TXT record "v=spf1 … -all" listing the services that send for it` });
  } else if (spf.length > 1) {
    out.push({ ...base, id: id("spf-multiple"), kind: "spf-multiple", detail: `${domain} has ${spf.length} SPF records; receivers then treat SPF as broken (permerror). Merge them into one record` });
  } else {
    const p = parseSpf(spf[0]);
    if (p.all === "+") {
      out.push({ ...base, id: id("spf-pass-all"), kind: "spf-pass-all", detail: `The SPF record of ${domain} ends in "+all", which lets every server on the internet send as it. End it in "-all" or "~all"` });
    } else if (p.all === "?") {
      out.push({ ...base, id: id("spf-neutral-all"), kind: "spf-neutral-all", detail: `The SPF record of ${domain} ends in "?all" (neutral), so it protects nothing. End it in "-all" or "~all"` });
    }
    const { count, problems } = await countSpfLookups(spf[0], getSpf, 0, new Set([domain]));
    if (count > SPF_MAX_LOOKUPS) {
      out.push({
        ...base,
        id: id("spf-too-many-lookups"),
        kind: "spf-too-many-lookups",
        detail: `The SPF record of ${domain} needs ${count} DNS lookups (includes counted through); receivers stop at ${SPF_MAX_LOOKUPS} and fail SPF${problems.length ? ` (${problems.slice(0, 3).join("; ")})` : ""}. Remove includes nobody uses or flatten some into ip4/ip6 ranges`,
      });
    }
  }

  const dmarc = await dmarcFor(domain, resolver);
  const parsed = dmarc.records.length === 1 ? parseDmarc(dmarc.records[0]) : null;
  if (!dmarc.records.length) {
    out.push({ ...base, id: id("dmarc-missing"), kind: "dmarc-missing", detail: `${domain} receives mail but has no DMARC record (_dmarc.${domain}), so receivers have no policy for mail that fails SPF and DKIM. Start with "v=DMARC1; p=none; rua=mailto:…", read the reports, then move to quarantine or reject` });
  } else if (!parsed || !parsed.valid) {
    const why = dmarc.records.length > 1 ? `${dmarc.records.length} DMARC records (receivers then ignore DMARC)` : "a DMARC record without a valid p= policy";
    out.push({ ...base, id: id("dmarc-missing"), kind: "dmarc-missing", detail: `_dmarc.${dmarc.from} has ${why}. Keep one record with p=none, quarantine or reject` });
  } else {
    const policy = dmarc.inherited ? parsed.sp || parsed.p : parsed.p;
    if (policy === "none") {
      out.push({ ...base, id: id("dmarc-none"), kind: "dmarc-none", detail: `The DMARC policy of ${domain}${dmarc.inherited ? ` (from ${dmarc.from})` : ""} is p=none: failures are only reported, never blocked. Once the reports show all real senders pass, move to quarantine or reject` });
    }
  }

  if (exchanges.some((e) => e.endsWith(".mail.protection.outlook.com"))) {
    const missing = [];
    for (const sel of ["selector1", "selector2"]) if (!(await hasDkim(`${sel}._domainkey.${domain}`, resolver))) missing.push(`${sel}._domainkey`);
    if (missing.length) {
      out.push({ ...base, id: id("dkim-missing"), kind: "dkim-missing", detail: `${domain} uses Exchange Online but has no ${missing.join(" or ")} record, so its mail is not DKIM-signed with the domain's own key. Create the CNAMEs shown in Defender (Email authentication settings, DKIM) and turn DKIM signing on` });
    }
  }
  return out;
}

/* ---------- Run ---------- */

async function run() {
  if (mode() === "off") return [];
  // Gather the domains: Graph and Azure separately, so one failing still leaves the other.
  const gathered = await runChecks(TOOL_ID, {
    "User domains": async () => [{ users: await userDomains() }],
    "Azure domains": async () => [{ azure: await azureSources() }],
  });
  const findings = gathered.filter((g) => g.kind === "scan-error");
  const users = (gathered.find((g) => g.users) || {}).users || { domains: new Set(), capped: false };
  const azure = (gathered.find((g) => g.azure) || {}).azure || { hosts: [], zones: [], registered: [] };
  if (users.capped) findings.push(scanError(TOOL_ID, "users-cap", `Read the first ${MAX_USERS} user accounts`, "Domains used only by the other accounts were not found"));

  // Domains checked for mail: user and zone domains as they are, host names and App Service Domains by registrable domain.
  const mailSet = new Set(users.domains);
  for (const z of azure.zones) {
    const d = usableDomain(z.name);
    if (d) mailSet.add(d);
  }
  for (const h of azure.hosts) {
    const r = registrableDomain(h);
    if (r) mailSet.add(r);
  }
  const asdNames = new Set();
  for (const a of azure.registered) {
    const d = usableDomain(a.name);
    if (d) {
      mailSet.add(d);
      asdNames.add(d);
    }
  }
  const registrable = [...new Set([...mailSet].map(registrableDomain).filter(Boolean))].sort();
  const mailDomains = [...mailSet].sort();

  for (const a of azure.registered) findings.push(...judgeAppServiceDomain(a));

  const resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  const checks = {
    "DNS zone delegation": () => zoneFindings(azure.zones, resolver),
    Mail: async () => {
      const getSpf = makeSpfGetter(resolver);
      const out = [];
      const list = mailDomains.slice(0, MAX_DOMAINS);
      const failures = await mapLimit(list, DNS_CONCURRENCY, async (d) => out.push(...(await mailFindings(d, resolver, getSpf))));
      if (failures.length) out.push(scanError(TOOL_ID, "mail-lookups", `${failures.length} of ${list.length} domains' mail settings not checked`, `${failures[0].item}: ${failures[0].message}`));
      if (mailDomains.length > MAX_DOMAINS) out.push(scanError(TOOL_ID, "domains-cap", `Checked the mail settings of ${MAX_DOMAINS} of ${mailDomains.length} domains`, "The rest were not checked"));
      return out;
    },
  };
  if (mode() === "on" && registrable.length) {
    checks.Registration = async () => {
      const list = registrable.slice(0, MAX_REGISTRABLE);
      const answers = await rdapLookup(list);
      const out = [];
      const failed = [];
      for (const d of list) {
        const a = answers.get(d);
        if (!a || a.status === "failed") failed.push(`${d} (${(a && a.error) || "no answer"})`);
        else if (a.status === "ok") out.push(...rdapFindings(d, a.summary, { skipExpiry: asdNames.has(d) }));
        // "none": no RDAP for that TLD, or no expiry published: unknown, no finding.
      }
      if (failed.length) out.push(scanError(TOOL_ID, "rdap", `Registration data not fetched for ${plural(failed.length, "domain")}`, `${failed.slice(0, 3).join(", ")}. The server could not reach rdap.org or the registry; set DOMAIN_CHECKS = dns to skip it`));
      if (registrable.length > MAX_REGISTRABLE) out.push(scanError(TOOL_ID, "rdap-cap", `Looked up the registration of ${MAX_REGISTRABLE} of ${registrable.length} domains`, "The rest were not checked"));
      return out;
    };
  }
  findings.push(...(await runChecks(TOOL_ID, checks)));
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Domains and mail",
  schedule: "25 7 * * *", // daily at 07:25
  run,
  _test: { mailFindings, makeSpfGetter, zoneFindings, registrableDomain, usableDomain, domainsFromUsers, rdapSummary, expiryKind, rdapFindings, judgeAppServiceDomain, compareDelegation, parseSpf, countSpfLookups, parseDmarc, spfRecords, txtRecords },
};
