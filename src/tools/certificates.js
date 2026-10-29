// TLS certificates of websites: the custom domains of App Service apps and
// slots (found in Azure) plus any address listed in Settings. Each host is
// opened over TLS and its certificate checked for expiry, a trusted chain and
// a name that matches the host. Reader is enough; the listed addresses need
// no Azure at all.
const tls = require("tls");
const net = require("net");
const settings = require("../settings");
const { resourceGraphQuery } = require("../armClient");
const { numberSetting, mapLimit, runChecks, itemErrors, daysUntil } = require("./util");

const TOOL_ID = "certificates";
const TIMEOUT_MS = 10000;
const MAX_HOSTS = 500;

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
    | project id, name, resourceGroup, subscriptionId, host = tolower(tostring(ssl.name))`,
    { toolId: TOOL_ID }
  );
  return rows
    .filter((r) => r.host && !MICROSOFT_HOST.test(r.host))
    .map((r) => ({ host: r.host, port: 443, source: r.name, resourceId: r.id, resourceGroup: r.resourceGroup, subscriptionId: r.subscriptionId }));
}

// Opens a TLS connection and hands back the certificate and whether Node's
// trust store accepts the chain. Nothing is sent after the handshake.
function probe({ host, port }) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, timeout: TIMEOUT_MS });
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

async function check(target, warn) {
  const label = target.port === 443 ? target.host : `${target.host}:${target.port}`;
  const base = {
    id: target.resourceId ? `${target.resourceId}/certificates/${label}` : `${TOOL_ID}/hosts/${label}`,
    name: label,
    resourceGroup: target.resourceGroup || null,
    subscriptionId: target.subscriptionId || null,
  };
  const where = target.resourceId ? `Custom domain of ${target.source}. ` : "";
  let res;
  try {
    res = await probe(target);
  } catch (err) {
    return [{ ...base, kind: "cert-unreachable", detail: `${where}Could not open a TLS connection: ${err.message}` }];
  }
  const { cert, authorized, authError } = res;
  if (!cert || !cert.valid_to) return [{ ...base, kind: "cert-unreachable", detail: `${where}The server sent no certificate` }];

  const expires = new Date(cert.valid_to).toISOString().slice(0, 10);
  const days = daysUntil(cert.valid_to);
  const about = `${subjectOf(cert)}, issued by ${issuerOf(cert)}, valid until ${expires}`;
  const out = [];
  if (days < 0) out.push({ ...base, kind: "cert-expired", expires, detail: `${where}Expired ${-days} day(s) ago (${about})` });
  else if (days <= warn) out.push({ ...base, kind: "cert-expiring", expires, detail: `${where}Expires in ${days} day(s) (${about})` });

  const nameError = net.isIP(target.host) ? null : tls.checkServerIdentity(target.host, cert);
  if (nameError) out.push({ ...base, kind: "cert-name-mismatch", expires, detail: `${where}The certificate is not for ${target.host}: ${cert.subjectaltname || subjectOf(cert)}` });

  // An expired or wrong-name certificate already has its own finding.
  const chainOnly = authError && !["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"].includes(authError);
  if (!authorized && chainOnly) out.push({ ...base, kind: "cert-untrusted", expires, detail: `${where}Browsers will not trust it: ${authError} (${about})` });
  return out;
}

async function run() {
  const warn = numberSetting("CERT_WARN_DAYS", 30, { min: 0, max: 365 });
  const azureOn = String(settings.get("CERT_AZURE_SITES") || "on").toLowerCase() !== "off";
  const listed = listedTargets();
  const checks = {};
  if (azureOn) checks["Azure web apps"] = azureTargets;
  if (listed.length) checks["Listed addresses"] = async () => listed;
  if (!Object.keys(checks).length) return [];

  // runChecks collects the targets; a failed Azure query still leaves the listed addresses.
  const gathered = await runChecks(TOOL_ID, checks);
  const errors = gathered.filter((g) => g.kind === "scan-error");
  const seen = new Set();
  const targets = gathered
    .filter((g) => g.kind !== "scan-error")
    .filter((t) => {
      const k = `${t.host}:${t.port}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, MAX_HOSTS);

  const findings = [...errors];
  const failures = await mapLimit(targets, 8, async (t) => findings.push(...(await check(t, warn))));
  findings.push(...itemErrors(TOOL_ID, "hosts", "hosts", failures, targets.length));
  return findings;
}

module.exports = {
  id: TOOL_ID,
  label: "Certificates",
  schedule: "20 6 * * *", // daily at 06:20
  run,
  parseTarget,
};
