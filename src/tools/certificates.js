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

// A Key Vault secret id with a version after the name: the gateway never picks up a renewal.
const PINNED_SECRET = /\/secrets\/[^/]+\/[^/]+\/?$/i;

async function gatewayRows() {
  return resourceGraphQuery(
    `resources
    | where type =~ 'microsoft.network/applicationgateways' and tostring(properties.operationalState) !~ 'Stopped'
    | project id, name, resourceGroup, subscriptionId,
        certs = properties.sslCertificates, roots = properties.trustedRootCertificates,
        listeners = properties.httpListeners, backendSettings = properties.backendHttpSettingsCollection,
        frontends = properties.frontendIPConfigurations, ports = properties.frontendPorts`,
    { toolId: TOOL_ID }
  );
}

async function gatewayPublicIps() {
  const rows = await resourceGraphQuery(
    `resources
    | where type =~ 'microsoft.network/publicipaddresses' and isnotempty(properties.ipAddress)
    | where tostring(properties.ipConfiguration.id) contains '/applicationGateways/'
    | project id, ip = tostring(properties.ipAddress)`,
    { toolId: TOOL_ID }
  );
  return new Map(rows.map((r) => [lower(r.id), r.ip]));
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
  const row = (id, name, type, usedBy, source, cert, used) => {
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
    row(id, name, "gateway", usedBy, pinned ? "Key Vault (one version)" : kv ? "Key Vault" : "Uploaded", leaf, users.length > 0);
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

// Live targets for the HTTPS listeners on a public frontend: connect to the
// public IP with the listener's host name, so DNS need not point there yet.
// Listeners with only a wildcard or no host name are left to the settings check.
function gatewayTargets(gw, ips, read) {
  const frontIp = new Map(arr(gw.frontends).map((f) => [lower(f.id), ips.get(lower(f.properties && f.properties.publicIPAddress && f.properties.publicIPAddress.id))]));
  const portOf = new Map(arr(gw.ports).map((p) => [lower(p.id), Number(p.properties && p.properties.port) || 443]));
  const out = [];
  for (const l of arr(gw.listeners)) {
    const p = l.properties || {};
    if (lower(p.protocol) !== "https") continue;
    const ip = frontIp.get(lower(p.frontendIPConfiguration && p.frontendIPConfiguration.id));
    if (!ip) continue;
    const port = portOf.get(lower(p.frontendPort && p.frontendPort.id)) || 443;
    const hosts = [...new Set([...arr(p.hostName), ...arr(p.hostNames)].map(lower))].filter((h) => h && !h.includes("*"));
    const certKnown = read.has(lower(p.sslCertificate && p.sslCertificate.id));
    for (const h of hosts) {
      out.push({
        host: ip,
        port,
        sni: h,
        name: h,
        key: `${ip}:${port}:${h}`,
        label: port === 443 ? h : `${h}:${port}`,
        id: `${gw.id}/listeners/${l.name}/${h}`,
        resourceGroup: gw.resourceGroup,
        subscriptionId: gw.subscriptionId,
        where: `Listener ${l.name} on application gateway ${gw.name}. `,
        type: "gatewaylive",
        usedBy: `Gateway ${gw.name}: listener ${l.name}`,
        // Listed from the settings when they gave the certificate.
        inventory: !certKnown,
        // The settings check already reports expiry. Many gateways let in only
        // Front Door or known addresses, so no answer is not a finding.
        skipExpiry: certKnown,
        skipUnreachable: true,
      });
    }
  }
  return out;
}

async function gateways(warn, gwFindings, inv) {
  const [rows, ips] = await Promise.all([gatewayRows(), gatewayPublicIps()]);
  const targets = [];
  for (const gw of rows) {
    const { findings, read, rows: certs } = judgeGateway(gw, warn);
    gwFindings.push(...findings);
    inv.push(...certs);
    targets.push(...gatewayTargets(gw, ips, read));
  }
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

// The findings for one address, and its row for the list (null when not listed).
async function check(target, warn) {
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
    res = await probe(target);
  } catch (err) {
    if (target.skipUnreachable) return { findings: [], row: null };
    return { findings: [{ ...base, kind: "cert-unreachable", detail: `${where}Could not open a TLS connection: ${err.message}` }], row: row({ status: "unreachable", note: err.message }) };
  }
  const { cert, authorized, authError } = res;
  if (!cert || !cert.valid_to) {
    return { findings: [{ ...base, kind: "cert-unreachable", detail: `${where}The server sent no certificate` }], row: row({ status: "unreachable", note: "no certificate sent" }) };
  }

  const expires = new Date(cert.valid_to).toISOString().slice(0, 10);
  const days = daysUntil(cert.valid_to);
  const about = `${subjectOf(cert)}, issued by ${issuerOf(cert)}, valid until ${expires}`;
  const out = [];
  // skipExpiry: the gateway's settings already gave the expiry.
  const expiryHere = !target.skipExpiry;
  if (expiryHere && days < 0) out.push({ ...base, kind: "cert-expired", expires, detail: `${where}Expired ${-days} day(s) ago (${about})` });
  else if (expiryHere && days <= warn) out.push({ ...base, kind: "cert-expiring", expires, detail: `${where}Expires in ${days} day(s) (${about})` });

  const nameError = net.isIP(name) ? null : tls.checkServerIdentity(name, cert);
  if (nameError) out.push({ ...base, kind: "cert-name-mismatch", expires, detail: `${where}The certificate is not for ${name}: ${cert.subjectaltname || subjectOf(cert)}` });

  // An expired or wrong-name certificate already has its own finding.
  const chainOnly = authError && !["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(authError);
  const untrusted = !authorized && chainOnly;
  if (untrusted) out.push({ ...base, kind: "cert-untrusted", expires, detail: `${where}Browsers will not trust it: ${authError} (${about})` });
  const status = days < 0 ? "expired" : nameError ? "name" : untrusted ? "untrusted" : expiryState(days, warn);
  return {
    findings: out,
    row: row({ subject: subjectOf(cert), issuer: issuerOf(cert), expires, days, thumbprint: thumbOf(cert.fingerprint), status, ...(untrusted && { note: authError }) }),
  };
}

async function run() {
  const warn = numberSetting("CERT_WARN_DAYS", 30, { min: 0, max: 365 });
  const azureOn = String(settings.get("CERT_AZURE_SITES") || "on").toLowerCase() !== "off";
  const gatewaysOn = String(settings.get("CERT_AZURE_GATEWAYS") || "on").toLowerCase() !== "off";
  const listed = listedTargets();
  const checks = {};
  const gwFindings = [];
  const inv = [];
  let sites = null; // the web apps' bindings, once read
  if (azureOn) checks["Azure web apps"] = async () => (sites = await azureTargets());
  if (gatewaysOn) checks["Application gateways"] = () => gateways(warn, gwFindings, inv);
  if (listed.length) checks["Listed addresses"] = async () => listed;
  if (!Object.keys(checks).length) {
    await saveInventory([]);
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

  const findings = [...errors, ...gwFindings];
  const failures = await mapLimit(targets, 8, async (t) => {
    const { findings: found, row } = await check(t, warn);
    findings.push(...found);
    if (row) inv.push(row);
  });
  findings.push(...itemErrors(TOOL_ID, "hosts", "hosts", failures, targets.length));

  // After the web apps were read: their bindings say which App Service certificates are used.
  // Skipped when the web apps could not be read: every certificate would look unbound.
  if (sites) {
    try {
      inv.push(...(await appServiceCerts(warn, sites)));
    } catch (err) {
      findings.push(scanError(TOOL_ID, "app-service-certificates", "App Service certificates not listed", err.message));
    }
  }
  await saveInventory(inv);
  return findings;
}

const saveInventory = (certs) => store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), certs });

/* ---------- read routes ---------- */

// Each tenant's certificate list from its last scan.
async function inventory(keys) {
  const out = { updatedAt: null, certs: [], failures: [] };
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
    out.certs.push(...(doc.certs || []).map((c) => ({ ...c, ...(k !== tenants.HOME && { tenant: k }) })));
  }
  return out;
}

function registerRoutes(app, { readKeys, decorate }) {
  app.get("/api/certificates", async (req, res) => {
    try {
      const inv = await inventory(readKeys(req));
      await decorate(TOOL_ID, inv.certs);
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
  _test: { certsFromBase64, leafOf, judgeGateway, gatewayTargets, appServiceRows, check, PINNED_SECRET },
};
