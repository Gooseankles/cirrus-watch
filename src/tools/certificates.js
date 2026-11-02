// TLS certificates of websites: the custom domains of App Service apps and
// slots (found in Azure), application gateway listeners, plus any address
// listed in Settings. Each host is opened over TLS and its certificate checked
// for expiry, a trusted chain and a name that matches the host. Gateway
// certificates are also read from the gateway's settings (ARM hands back their
// public part), so private gateways are covered without a connection. Reader is
// enough; the listed addresses need no Azure at all.
// Every certificate seen is also saved as a list (In use on the page): where
// it is used, who issued it, when it expires and its state, also when all is
// well. App Service certificate resources are listed too, with their bindings.
// Every application gateway is saved with its addresses (Application gateways
// on the page): frontends, listeners and what each listener answered live.
const tls = require("tls");
const net = require("net");
const crypto = require("crypto");
const settings = require("../settings");
const store = require("../findingsStore");
const tenants = require("../tenants");
const { resourceGraphQuery } = require("../armClient");
const { numberSetting, mapLimit, runChecks, itemErrors, scanError, daysUntil } = require("./util");

const TOOL_ID = "certificates";
const TIMEOUT_MS = 10000;
const MAX_HOSTS = 500;
const INVENTORY_KEY = "certificates/inventory.json";

// State of a certificate from its days left.
const expiryState = (days, warn) => (days < 0 ? "expired" : days <= warn ? "expiring" : "ok");
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);
const thumbOf = (fp) => String(fp || "").replace(/:/g, "").toUpperCase() || null;

// Names Microsoft owns and keeps valid itself.
const MICROSOFT_HOST = /\.(?:azurewebsites\.net|azurewebsites\.us|chinacloudsites\.cn|trafficmanager\.net|azurefd\.net|azureedge\.net|appserviceenvironment\.net)$/i;

// "https://shop.example.com/path", "example.com:8443" or "example.com" -> { host, port }.
function parseTarget(text) {
  let s = String(text || "").trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || (!net.isIP(host) && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host))) return null;
  return { host, port: Number(u.port) || 443 };
}

function listedTargets() {
  return String(settings.get("CERT_CHECK_URLS") || "")
    .split(/[\s,;]+/)
    .map(parseTarget)
    .filter(Boolean)
    .map((t) => ({ ...t, source: "Settings" }));
}

async function azureTargets() {
  const rows = await resourceGraphQuery(
    `resources
    | where type in~ ('microsoft.web/sites', 'microsoft.web/sites/slots')
    | where tostring(properties.state) =~ 'Running'
    | mv-expand ssl = properties.hostNameSslStates
    | where tostring(ssl.hostType) =~ 'Standard'
    | project id, name, resourceGroup, subscriptionId, host = tolower(tostring(ssl.name)), thumb = toupper(tostring(ssl.thumbprint))`,
    { toolId: TOOL_ID }
  );
  return rows
    .filter((r) => r.host && !MICROSOFT_HOST.test(r.host))
    .map((r) => ({ host: r.host, port: 443, source: r.name, resourceId: r.id, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId, thumb: r.thumb || null, type: "site", usedBy: `Web app ${r.name}` }));
}

// App Service certificate resources (uploaded, App Service managed or from Key
// Vault), with the custom domains they are bound to from the sites' bindings.
async function appServiceCerts(warn, sites) {
  const rows = await resourceGraphQuery(
    `resources
    | where type =~ 'microsoft.web/certificates'
    | project id, name, resourceGroup, subscriptionId, subject = tostring(properties.subjectName), issuer = tostring(properties.issuer),
        expires = tostring(properties.expirationDate), thumb = toupper(tostring(properties.thumbprint)), kv = tostring(properties.keyVaultId)`,
    { toolId: TOOL_ID }
  );
  return appServiceRows(rows, sites, warn);
}

function appServiceRows(rows, sites, warn, now = Date.now()) {
  return rows.map((r) => {
    const bound = sites.filter((t) => t.thumb && t.thumb === r.thumb);
    const hosts = [...new Set(bound.map((t) => t.host))];
    const apps = [...new Set(bound.map((t) => t.source))];
    const days = r.expires ? daysUntil(r.expires, now) : null;
    const issuer = (/(?:^|,\s*)O=([^,]+)/.exec(r.issuer || "") || /CN=([^,]+)/.exec(r.issuer || "") || [])[1] || r.issuer || null;
    return {
      id: r.id,
      name: r.name,
      type: "appservice",
      usedBy: hosts.length ? `${hosts.join(", ")} (web app${apps.length > 1 ? "s" : ""} ${apps.join(", ")})` : "Not bound to a running web app",
      source: r.kv ? "Key Vault" : "App Service",
      subject: r.subject || null,
      issuer,
      expires: r.expires ? isoDay(r.expires) : null,
      days,
      thumbprint: r.thumb || null,
      status: !bound.length ? "unused" : days === null ? "unread" : expiryState(days, warn),
      resourceGroup: r.resourceGroup || null,
      subscriptionId: r.subscriptionId || null,
    };
  });
}

// --- Application gateways ---

const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const lower = (x) => String(x || "").toLowerCase();

// One DER element at pos: its tag, where its body starts and where it ends.
function derAt(buf, pos) {
  if (pos + 2 > buf.length) throw new Error("short DER");
  let len = buf[pos + 1];
  let body = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw new Error("bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[body++];
  }
  if (body + len > buf.length) throw new Error("short DER");
  return { tag: buf[pos], start: pos, body, end: body + len };
}

function derChildren(buf, node) {
  const out = [];
  for (let p = node.body; p < node.end; p = out[out.length - 1].end) out.push(derAt(buf, p));
  return out;
}

// The certificates in a PKCS#7 bundle: ContentInfo { oid, [0] SignedData { ..., [0] certificates } }.
function pkcs7Certs(der) {
  const [, wrapped] = derChildren(der, derAt(der, 0));
  const signedData = derChildren(der, wrapped)[0];
  const set = derChildren(der, signedData).find((n) => n.tag === 0xa0);
  return set ? derChildren(der, set).filter((n) => n.tag === 0x30).map((n) => der.subarray(n.start, n.end)) : [];
}

// Certificates in base64 data, either one DER certificate or a PKCS#7 bundle
// (what ARM returns as publicCertData). Unreadable data gives none.
function certsFromBase64(text) {
  const der = Buffer.from(String(text || "").replace(/-----[^-]+-----|\s/g, ""), "base64");
  if (!der.length) return [];
  try {
    return [new crypto.X509Certificate(der)];
  } catch {
    try {
      return pkcs7Certs(der).map((c) => new crypto.X509Certificate(c));
    } catch {
      return [];
    }
  }
}

// The server certificate of a chain: the one that issued none of the others.
function leafOf(certs) {
  return certs.find((c) => !certs.some((o) => o !== c && o.checkIssued(c))) || certs[0] || null;
}

const x509Subject = (c) => (/(?:^|\n)CN=([^\n]+)/.exec(c.subject || "") || [])[1] || (c.subjectAltName || "").replace(/DNS:/g, "").split(",")[0] || "?";
const x509Issuer = (c) => (/(?:^|\n)O=([^\n]+)/.exec(c.issuer || "") || /(?:^|\n)CN=([^\n]+)/.exec(c.issuer || "") || [])[1] || "unknown issuer";
const DAY = 86400000;

// A Key Vault secret id with a version after the name: the gateway never picks up a renewal.
const PINNED_SECRET = /\/secrets\/[^/]+\/[^/]+\/?$/i;

async function gatewayRows() {
  return resourceGraphQuery(
    `resources
    | where type =~ 'microsoft.network/applicationgateways' and tostring(properties.operationalState) !~ 'Stopped'
    | project id, name, resourceGroup, subscriptionId, sku = tostring(properties.sku.tier),
        certs = properties.sslCertificates, roots = properties.trustedRootCertificates,
        listeners = properties.httpListeners, backendSettings = properties.backendHttpSettingsCollection,
        frontends = properties.frontendIPConfigurations, ports = properties.frontendPorts`,
    { toolId: TOOL_ID }
  );
}

// The gateways' public IPs: id -> { ip, fqdn } (fqdn is the Azure DNS name, when one is set).
async function gatewayPublicIps() {
  const rows = await resourceGraphQuery(
    `resources
    | where type =~ 'microsoft.network/publicipaddresses' and isnotempty(properties.ipAddress)
    | where tostring(properties.ipConfiguration.id) contains '/applicationGateways/'
    | project id, ip = tostring(properties.ipAddress), fqdn = tolower(tostring(properties.dnsSettings.fqdn))`,
    { toolId: TOOL_ID }
  );
  return new Map(rows.map((r) => [lower(r.id), { ip: r.ip, fqdn: r.fqdn || null }]));
}

// Expiry of the certificates a gateway uses, from its settings: listener
// certificates and trusted root certificates for HTTPS backends. Certificates no
// listener or backend setting uses get no finding. Also returns the ids of the
// listener certificates whose expiry could be read, and a list row for every
// certificate on the gateway (unused ones too).
function judgeGateway(gw, warn, now = Date.now()) {
  const base = { resourceGroup: gw.resourceGroup || null, subscriptionId: gw.subscriptionId || null };
  const https = arr(gw.listeners).filter((l) => lower(l.properties && l.properties.protocol) === "https");
  const listenersOf = (id) => https.filter((l) => lower(l.properties.sslCertificate && l.properties.sslCertificate.id) === lower(id)).map((l) => l.name);
  const rootUsers = (id) => arr(gw.backendSettings).filter((s) => arr(s.properties && s.properties.trustedRootCertificates).some((r) => lower(r.id) === lower(id))).map((s) => s.name);
  const out = [];
  const read = new Set();
  const rows = [];
  const row = (id, name, type, usedBy, source, cert, used, extra) => {
    const days = cert ? daysUntil(cert.validTo, now) : null;
    rows.push({
      ...base,
      id,
      name,
      type,
      usedBy,
      source,
      subject: cert ? x509Subject(cert) : null,
      issuer: cert ? x509Issuer(cert) : null,
      expires: cert ? isoDay(cert.validTo) : null,
      days,
      thumbprint: cert ? thumbOf(cert.fingerprint) : null,
      status: !used ? "unused" : !cert ? "unread" : expiryState(days, warn),
      ...extra,
    });
  };

  const expiry = (id, name, cert, where, after) => {
    const expires = new Date(cert.validTo).toISOString().slice(0, 10);
    const days = daysUntil(cert.validTo, now);
    const about = `${x509Subject(cert)}, issued by ${x509Issuer(cert)}, valid until ${expires}`;
    if (days < 0) out.push({ ...base, id, name, kind: "cert-expired", expires, detail: `${where} Expired ${-days} day(s) ago (${about}).${after}` });
    else if (days <= warn) out.push({ ...base, id, name, kind: "cert-expiring", expires, detail: `${where} Expires in ${days} day(s) (${about}).${after}` });
  };

  for (const c of arr(gw.certs)) {
    const users = listenersOf(c.id);
    const p = c.properties || {};
    const id = `${gw.id}/sslCertificates/${c.name}`;
    const name = `${gw.name}/${c.name}`;
    const kv = p.keyVaultSecretId || "";
    const pinned = PINNED_SECRET.test(kv);
    const leaf = leafOf(certsFromBase64(p.publicCertData));
    const usedBy = users.length ? `Gateway ${gw.name}: listener${users.length > 1 ? "s" : ""} ${users.join(", ")}` : `Gateway ${gw.name}: no listener uses it`;
    // ref: the listener certificate's id as listeners point at it, to match live answers to this row.
    row(id, name, "gateway", usedBy, pinned ? "Key Vault (one version)" : kv ? "Key Vault" : "Uploaded", leaf, users.length > 0, {
      ref: lower(c.id || id),
      // For the live check's renewal grace (not saved): a Key Vault secret without a version, and when the
      // certificate the settings give became valid.
      kvLatest: Boolean(kv && !pinned),
      validFrom: leaf ? new Date(leaf.validFrom).toISOString() : null,
      ...(!leaf && users.length && { note: "Expiry not readable from the gateway settings" }),
    });
    if (!users.length) continue;
    const where = `Listener certificate ${c.name} on application gateway ${gw.name} (listener${users.length > 1 ? "s" : ""} ${users.join(", ")}).`;
    if (pinned) {
      out.push({ ...base, id: `${id}#kv-pinned`, name, kind: "agw-cert-kv-pinned", detail: `${where} It points at one version of the Key Vault secret (${kv.replace(/^https:\/\//i, "")}), so a renewed certificate in the vault is never picked up. Use the secret id without the version.` });
    }
    if (!leaf) continue;
    read.add(lower(c.id));
    let after = " It was uploaded to the gateway: upload the renewed one, or move it to Key Vault so renewals are picked up.";
    if (pinned) after = "";
    else if (kv) after = " It comes from Key Vault: renew it there and the gateway picks it up within 4 hours.";
    expiry(id, name, leaf, where, after);
  }

  for (const r of arr(gw.roots)) {
    const users = rootUsers(r.id);
    const cert = leafOf(certsFromBase64(r.properties && r.properties.data));
    const usedBy = users.length ? `Gateway ${gw.name}: trusts HTTPS backends (${users.join(", ")})` : `Gateway ${gw.name}: no backend setting uses it`;
    row(`${gw.id}/trustedRootCertificates/${r.name}`, `${gw.name}/${r.name}`, "root", usedBy, "Trusted root", cert, users.length > 0);
    if (!users.length || !cert) continue;
    const where = `Trusted root certificate ${r.name} on application gateway ${gw.name}, used to trust HTTPS backends (${users.join(", ")}).`;
    expiry(`${gw.id}/trustedRootCertificates/${r.name}`, `${gw.name}/${r.name}`, cert, where, " Backends whose certificate chains to it stop working when it expires.");
  }
  return { findings: out, read, rows };
}

const lastPart = (id) => String(id || "").split("/").pop() || null;
const pipOf = (ips, id) => {
  const v = ips.get(lower(id));
  return typeof v === "string" ? { ip: v, fqdn: null } : v || null;
};

// A gateway's frontends with their addresses: a public IP (and its Azure DNS
// name) or a private IP. A public IP without an address gets ip null.
function gatewayFrontends(gw, ips) {
  const out = [];
  for (const f of arr(gw.frontends)) {
    const p = f.properties || {};
    const name = f.name || lastPart(f.id);
    if (p.publicIPAddress && p.publicIPAddress.id) {
      const pip = pipOf(ips, p.publicIPAddress.id);
      out.push({ ref: lower(f.id), name, kind: "public", ip: (pip && pip.ip) || null, fqdn: (pip && pip.fqdn) || null });
    } else if (p.privateIPAddress) {
      out.push({ ref: lower(f.id), name, kind: "private", ip: p.privateIPAddress, fqdn: null });
    }
  }
  return out;
}

// A listener's host names as written (wildcards too); none means a basic listener.
const hostNamesOf = (p) => [...new Set([...arr(p.hostName), ...arr(p.hostNames)].map(lower))].filter(Boolean);
const isWildcard = (h) => /[*?]/.test(h);

// A made-up name the wildcard matches, sent as SNI so the gateway picks that
// listener ("*.contoso.com" -> "cirrus-watch-probe.contoso.com"). Without SNI a
// multi-site gateway answers with whatever its default is.
const WILDCARD_LABEL = "cirrus-watch-probe";
const wildcardProbeName = (h) => h.replace(/\*/g, WILDCARD_LABEL).replace(/\?/g, "x");

// Every listener of a gateway with its addresses: protocol, port, host names
// (wildcards and none = basic), the frontend and its address, and the
// certificate it names. Checks are filled in after the live connections.
function gatewayAddresses(gw, ips) {
  const fronts = gatewayFrontends(gw, ips);
  const portOf = new Map(arr(gw.ports).map((p) => [lower(p.id), Number(p.properties && p.properties.port) || null]));
  const listeners = arr(gw.listeners).map((l) => {
    const p = l.properties || {};
    const f = fronts.find((x) => x.ref === lower(p.frontendIPConfiguration && p.frontendIPConfiguration.id)) || null;
    const protocol = lower(p.protocol) === "https" ? "HTTPS" : lower(p.protocol) === "http" ? "HTTP" : p.protocol || null;
    const certRef = protocol === "HTTPS" ? lower(p.sslCertificate && p.sslCertificate.id) || null : null;
    return {
      name: l.name,
      protocol,
      port: portOf.get(lower(p.frontendPort && p.frontendPort.id)) || (protocol === "HTTP" ? 80 : 443),
      hostNames: hostNamesOf(p),
      frontend: f ? f.name : lastPart(p.frontendIPConfiguration && p.frontendIPConfiguration.id),
      frontendKind: f ? f.kind : null,
      ip: f ? f.ip : null,
      fqdn: f ? f.fqdn : null,
      certificate: certRef ? lastPart(certRef) : null,
      certRef,
      checks: [],
    };
  });
  return {
    id: gw.id,
    name: gw.name,
    sku: gw.sku || null,
    resourceGroup: gw.resourceGroup || null,
    subscriptionId: gw.subscriptionId || null,
    frontends: fronts.map(({ ref, ...f }) => f),
    listeners,
  };
}

// Live targets for every HTTPS listener, on each address its frontend has (the
// public IP, or the private IP, which answers when the dashboard runs inside a
// network that reaches it; CERT_PROBE_PRIVATE off skips private IPs). The host name goes as SNI, so DNS need not point
// there yet. A wildcard listener is reached with a made-up name the wildcard
// matches, a basic listener (no host name) with no SNI at all; no name is
// judged on a basic listener. certs: the gateway's list rows from judgeGateway,
// whose thumbprints say which certificate each listener should serve. No answer
// is never a finding: many gateways let in only Front Door or known addresses.
const probePrivate = () => !/^(off|no|false|0)$/i.test(String(settings.get("CERT_PROBE_PRIVATE") || "").trim());
function gatewayTargets(gw, ips, certs = []) {
  const listing = gatewayAddresses(gw, ips);
  const byRef = new Map(certs.filter((c) => c.ref).map((c) => [c.ref, c]));
  const out = [];
  // Public addresses first: their answer is the one browsers see.
  const order = (l) => (l.frontendKind === "public" ? 0 : 1);
  for (const l of [...listing.listeners].sort((a, b) => order(a) - order(b))) {
    if (l.protocol !== "HTTPS" || !l.ip) continue;
    if (l.frontendKind === "private" && !probePrivate()) continue;
    const cert = byRef.get(l.certRef) || null;
    const ways = l.hostNames.length
      ? l.hostNames.map((h) => (isWildcard(h) ? { shown: h, sni: wildcardProbeName(h), name: wildcardProbeName(h), wildcard: true } : { shown: h, sni: h, name: h }))
      : [{ shown: null, sni: undefined, name: l.ip, basic: true }];
    for (const w of ways) {
      const address = `${l.ip}:${l.port}`;
      const shown = w.shown || address;
      out.push({
        host: l.ip,
        port: l.port,
        sni: w.sni,
        name: w.name,
        // What the name check is said to be against: the wildcard as written.
        nameShown: w.shown,
        key: `${address}:${w.sni || ""}`,
        label: w.shown ? (l.port === 443 ? w.shown : `${w.shown}:${l.port}`) : address,
        // One id per listener and host name (a listener has one frontend, so one
        // address); the same as before 0.70, so accepted findings keep their key.
        id: `${gw.id}/listeners/${l.name}/${w.shown || "basic"}`,
        resourceGroup: gw.resourceGroup,
        subscriptionId: gw.subscriptionId,
        where: `Listener ${l.name} on application gateway ${gw.name}, checked on ${l.frontendKind} address ${address}${w.basic ? " with no host name" : w.wildcard ? ` as ${w.sni} (matches ${shown})` : ""}. `,
        type: "gatewaylive",
        usedBy: `Gateway ${gw.name}: listener ${l.name}`,
        // Listed from the settings (judgeGateway's row), filled in from here when unread.
        inventory: false,
        // Expiry comes from the settings, or once per certificate from the live answers.
        skipExpiry: true,
        skipUnreachable: true,
        // The certificate the settings say this listener serves, when they gave it.
        expectThumb: (cert && cert.thumbprint) || null,
        // A Key Vault secret without a version follows renewals: see check()'s grace.
        expectKvLatest: Boolean(cert && cert.kvLatest),
        expectFrom: (cert && cert.validFrom) || null,
        gateway: lower(gw.id),
        listener: l.name,
        certRef: l.certRef,
        address,
        frontendKind: l.frontendKind,
        sniShown: w.basic ? null : w.shown,
      });
    }
  }
  return out;
}

// After the live connections: each listener gets its checks (address, what was
// sent as SNI, the answer), and a listener certificate the settings could not
// read (a Key Vault reference without its public part) takes its expiry from the
// worst live answer, with one expiry finding per certificate. Returns those findings.
function finishGateways(listings, targets, certs, warn) {
  const findings = [];
  const byListener = new Map();
  for (const t of targets) {
    const k = `${t.gateway}|${lower(t.listener)}`;
    if (!byListener.has(k)) byListener.set(k, []);
    byListener.get(k).push(t);
  }
  for (const g of listings) {
    for (const l of g.listeners) {
      l.checks = (byListener.get(`${lower(g.id)}|${lower(l.name)}`) || []).map((t) => ({
        address: t.address,
        frontendKind: t.frontendKind,
        sni: t.sniShown,
        ...(t.live || { status: "unchecked" }),
      }));
    }
  }
  for (const c of certs) {
    if (c.type !== "gateway" || c.status !== "unread") continue;
    const answers = targets.filter((t) => t.certRef === c.ref && t.live && t.live.expires && t.live.days !== null);
    if (!answers.length) {
      c.note = "Not readable: the gateway settings do not give its expiry and no listener answered the dashboard";
      continue;
    }
    const worst = answers.reduce((a, b) => (b.live.days < a.live.days ? b : a));
    const v = worst.live;
    Object.assign(c, {
      subject: v.subject,
      issuer: v.issuer,
      expires: v.expires,
      days: v.days,
      thumbprint: v.thumbprint,
      status: expiryState(v.days, warn),
      source: `${c.source}, read live`,
      note: `Expiry not readable from the gateway settings; checked live on ${worst.address}${worst.sniShown ? ` (${worst.sniShown})` : ""}`,
    });
    const about = `${v.subject}, issued by ${v.issuer}, valid until ${v.expires}`;
    const where = `Listener certificate ${lastPart(c.id)} on application gateway ${String(c.name).split("/")[0]} (${String(c.usedBy).replace(/^Gateway [^:]+: /, "")}). The gateway settings do not give its expiry, so it was read from a live connection to ${worst.address}.`;
    const base = { id: c.id, name: c.name, resourceGroup: c.resourceGroup, subscriptionId: c.subscriptionId, expires: v.expires };
    if (v.days < 0) findings.push({ ...base, kind: "cert-expired", detail: `${where} Expired ${-v.days} day(s) ago (${about}).` });
    else if (v.days <= warn) findings.push({ ...base, kind: "cert-expiring", detail: `${where} Expires in ${v.days} day(s) (${about}).` });
  }
  // The certificate state each listener shows: from its list row.
  const byRef = new Map(certs.filter((c) => c.ref).map((c) => [c.ref, c]));
  for (const g of listings) {
    for (const l of g.listeners) {
      const c = l.certRef && byRef.get(l.certRef);
      if (c) Object.assign(l, { certSource: c.source, certStatus: c.status, certExpires: c.expires, certDays: c.days, certSubject: c.subject, certNote: c.note || null });
      delete l.certRef;
    }
  }
  return findings;
}

async function gateways(warn, ctx) {
  const [rows, ips] = await Promise.all([gatewayRows(), gatewayPublicIps()]);
  const targets = [];
  for (const gw of rows) {
    const { findings, rows: certs } = judgeGateway(gw, warn);
    ctx.findings.push(...findings);
    ctx.certs.push(...certs);
    ctx.listings.push(gatewayAddresses(gw, ips));
    targets.push(...gatewayTargets(gw, ips, certs));
  }
  ctx.targets = targets;
  ctx.on = true;
  return targets;
}

// Opens a TLS connection and hands back the certificate and whether Node's
// trust store accepts the chain. Nothing is sent after the handshake. sni sets
// the name sent when connecting to an IP address.
function probe({ host, port, sni }) {
  return new Promise((resolve, reject) => {
    const servername = sni || (net.isIP(host) ? undefined : host);
    const socket = tls.connect({ host, port, servername, rejectUnauthorized: false, timeout: TIMEOUT_MS });
    // Read what is needed first: a closed socket has no certificate any more.
    const done = (fn) => (arg) => {
      const value = fn(arg);
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      return value;
    };
    socket.once("secureConnect", done(() => {
      resolve({ cert: socket.getPeerCertificate(), authorized: socket.authorized, authError: socket.authorizationError });
    }));
    socket.once("timeout", done(() => reject(new Error(`no answer within ${TIMEOUT_MS / 1000} s`))));
    socket.once("error", done((err) => reject(new Error(err.code ? `${err.code}: ${err.message}` : err.message))));
  });
}

const subjectOf = (cert) => (cert.subject && cert.subject.CN) || (cert.subjectaltname || "").replace(/DNS:/g, "").split(",")[0] || "?";
const issuerOf = (cert) => (cert.issuer && (cert.issuer.O || cert.issuer.CN)) || "unknown issuer";

// The findings for one address, its row for the list (null when not listed) and
// what it answered (live), which gateway listeners show as their checks. open:
// the TLS connection (tests hand in a fake one); now: the clock (tests).
async function check(target, warn, open = probe, now = Date.now()) {
  const name = target.name || target.host;
  const label = target.label || (target.port === 443 ? target.host : `${target.host}:${target.port}`);
  const base = {
    id: target.id || (target.resourceId ? `${target.resourceId}/certificates/${label}` : `${TOOL_ID}/hosts/${label}`),
    name: label,
    resourceGroup: target.resourceGroup || null,
    subscriptionId: target.subscriptionId || null,
  };
  const where = target.where || (target.resourceId ? `Custom domain of ${target.source}. ` : "");
  const row = (extra) => (target.inventory === false ? null : {
    ...base,
    type: target.type || "listed",
    usedBy: target.usedBy || "Listed in Settings",
    source: "Live connection",
    subject: null,
    issuer: null,
    expires: null,
    days: null,
    thumbprint: null,
    ...extra,
  });
  let res;
  try {
    res = await open(target);
  } catch (err) {
    const live = { status: "unreachable", note: err.message };
    if (target.skipUnreachable) return { findings: [], row: null, live };
    return { findings: [{ ...base, kind: "cert-unreachable", detail: `${where}Could not open a TLS connection: ${err.message}` }], row: row(live), live };
  }
  const { cert, authorized, authError } = res;
  if (!cert || !cert.valid_to) {
    const live = { status: "unreachable", note: "no certificate sent" };
    return { findings: [{ ...base, kind: "cert-unreachable", detail: `${where}The server sent no certificate` }], row: row(live), live };
  }

  const expires = new Date(cert.valid_to).toISOString().slice(0, 10);
  const days = daysUntil(cert.valid_to);
  const about = `${subjectOf(cert)}, issued by ${issuerOf(cert)}, valid until ${expires}`;
  const out = [];
  // skipExpiry: the expiry is reported elsewhere (gateway settings, or once per gateway certificate).
  const expiryHere = !target.skipExpiry;
  if (expiryHere && days < 0) out.push({ ...base, kind: "cert-expired", expires, detail: `${where}Expired ${-days} day(s) ago (${about})` });
  else if (expiryHere && days <= warn) out.push({ ...base, kind: "cert-expiring", expires, detail: `${where}Expires in ${days} day(s) (${about})` });

  // An address with no name (a basic gateway listener reached by IP) has no name to judge.
  const nameError = net.isIP(name) ? null : tls.checkServerIdentity(name, cert);
  const nameShown = target.nameShown && target.nameShown !== name ? `${target.nameShown} (tried as ${name})` : name;
  if (nameError) out.push({ ...base, kind: "cert-name-mismatch", expires, detail: `${where}The certificate is not for ${nameShown}: ${cert.subjectaltname || subjectOf(cert)}` });

  // An expired or wrong-name certificate already has its own finding.
  const chainOnly = authError && !["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(authError);
  const untrusted = !authorized && chainOnly;
  if (untrusted) out.push({ ...base, kind: "cert-untrusted", expires, detail: `${where}Browsers will not trust it: ${authError} (${about})` });

  // A gateway listener whose settings name a certificate: is that the one it serves?
  const thumbprint = thumbOf(cert.fingerprint);
  let differs = Boolean(target.expectThumb && thumbprint && target.expectThumb !== thumbprint);
  // Renewal grace for a Key Vault secret without a version: the gateway already serves a newer certificate than
  // the settings show, or the one in the settings became valid less than 24 hours ago (Microsoft: the gateway
  // picks a renewal up within 4 hours). Said in the note, not reported.
  let grace = null;
  if (differs && target.expectKvLatest) {
    const servedFrom = Date.parse(cert.valid_from);
    const setFrom = Date.parse(target.expectFrom);
    if (servedFrom > setFrom) grace = "serves a newer certificate than the settings show (a Key Vault renewal)";
    else if (now - setFrom < DAY) grace = "the certificate in the settings is less than a day old; the gateway picks up a Key Vault renewal within 4 hours";
    if (grace) differs = false;
  }
  if (differs) {
    const named = target.certRef ? ` (${lastPart(target.certRef)})` : "";
    out.push({ ...base, kind: "agw-cert-served-differs", expires, detail: `${where}It answered with another certificate than the one its settings name${named}: ${about}, thumbprint ${thumbprint}; the settings have ${target.expectThumb}. A renewal in Key Vault can take up to 4 hours to reach the gateway; if this stays, check which listener answers on this address and port.` });
  }
  const status = days < 0 ? "expired" : nameError ? "name" : untrusted ? "untrusted" : differs ? "differs" : expiryState(days, warn);
  const note = untrusted ? authError : differs ? "not the certificate the settings name" : grace || undefined;
  const live = { status, subject: subjectOf(cert), issuer: issuerOf(cert), expires, days, thumbprint, nameChecked: !net.isIP(name), ...(note && { note }) };
  return {
    findings: out,
    row: row({ subject: live.subject, issuer: live.issuer, expires, days, thumbprint, status, ...(note && { note }) }),
    live,
  };
}

async function run() {
  const warn = numberSetting("CERT_WARN_DAYS", 30, { min: 0, max: 365 });
  const azureOn = String(settings.get("CERT_AZURE_SITES") || "on").toLowerCase() !== "off";
  const gatewaysOn = String(settings.get("CERT_AZURE_GATEWAYS") || "on").toLowerCase() !== "off";
  const listed = listedTargets();
  const checks = {};
  const inv = [];
  // Filled by the gateway check: its findings, list rows, listener listings and live targets.
  const gw = { findings: [], certs: [], listings: [], targets: [], on: false };
  let sites = null; // the web apps' bindings, once read
  if (azureOn) checks["Azure web apps"] = async () => (sites = await azureTargets());
  if (gatewaysOn) checks["Application gateways"] = () => gateways(warn, gw);
  if (listed.length) checks["Listed addresses"] = async () => listed;
  if (!Object.keys(checks).length) {
    await saveInventory([], []);
    return [];
  }

  // runChecks collects the targets; a failed Azure query still leaves the listed addresses.
  const gathered = await runChecks(TOOL_ID, checks);
  const errors = gathered.filter((g) => g.kind === "scan-error");
  const seen = new Set();
  const targets = gathered
    .filter((g) => g.kind !== "scan-error")
    .filter((t) => {
      const k = t.key || `${t.host}:${t.port}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_HOSTS);

  const findings = [...errors, ...gw.findings];
  // A gateway listener problem is reported once per finding id and kind (a guard: a listener has one frontend).
  const reported = new Set();
  const failures = await mapLimit(targets, 8, async (t) => {
    const { findings: found, row, live } = await check(t, warn);
    if (t.type === "gatewaylive") {
      t.live = live;
      for (const f of found) {
        const k = `${f.id}|${f.kind}`;
        if (!reported.has(k)) findings.push(f);
        reported.add(k);
      }
    } else findings.push(...found);
    if (row) inv.push(row);
  });
  findings.push(...itemErrors(TOOL_ID, "hosts", "hosts", failures, targets.length));
  if (gw.on) findings.push(...finishGateways(gw.listings, gw.targets, gw.certs, warn));
  inv.push(...gw.certs.map(({ ref, kvLatest, validFrom, ...c }) => c));

  // After the web apps were read: their bindings say which App Service certificates are used.
  // Skipped when the web apps could not be read: every certificate would look unbound.
  if (sites) {
    try {
      inv.push(...(await appServiceCerts(warn, sites)));
    } catch (err) {
      findings.push(scanError(TOOL_ID, "app-service-certificates", "App Service certificates not listed", err.message));
    }
  }
  await saveInventory(inv, gw.listings);
  return findings;
}

// gateways: every application gateway with its frontends and listeners (Application gateways on the page).
const saveInventory = (certs, gateways) => store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), certs, gateways });

/* ---------- read routes ---------- */

// Each tenant's certificate list from its last scan.
async function inventory(keys) {
  const out = { updatedAt: null, certs: [], gateways: [], failures: [] };
  for (const k of keys) {
    let doc;
    try {
      doc = await store.getDoc(INVENTORY_KEY, k);
    } catch (err) {
      out.failures.push({ tenant: k, error: `could not read the certificate list: ${err.message}` });
      continue;
    }
    if (!doc) continue;
    if (doc.updatedAt && (!out.updatedAt || doc.updatedAt > out.updatedAt)) out.updatedAt = doc.updatedAt;
    const tag = (x) => ({ ...x, ...(k !== tenants.HOME && { tenant: k }) });
    out.certs.push(...(doc.certs || []).map(tag));
    out.gateways.push(...(doc.gateways || []).map(tag));
  }
  return out;
}

function registerRoutes(app, { readKeys, decorate }) {
  app.get("/api/certificates", async (req, res) => {
    try {
      const inv = await inventory(readKeys(req));
      await decorate(TOOL_ID, inv.certs);
      await decorate(TOOL_ID, inv.gateways);
      res.json(inv);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Certificates",
  schedule: "20 6 * * *", // daily at 06:20
  run,
  registerRoutes,
  parseTarget,
  _test: { certsFromBase64, leafOf, judgeGateway, gatewayFrontends, gatewayAddresses, gatewayTargets, finishGateways, wildcardProbeName, appServiceRows, check, PINNED_SECRET },
};
