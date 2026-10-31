// Successful sign-ins in the last 7 days with legacy (basic authentication)
// clients: IMAP, POP, SMTP AUTH, Exchange ActiveSync, older Outlook protocols
// and "Other clients". Legacy authentication cannot do MFA, so a password
// alone is enough. One finding per user and client, with the count and the
// last time. Each client is read with its own filter and a page cap, so a busy
// tenant does not pull its whole sign-in log.
// Graph: AuditLog.Read.All. Reading sign-ins through Graph needs Microsoft
// Entra ID P1 or P2; without it the run notes that and reports nothing.
// Graph v1.0 lists the interactive user sign-ins (and successful federated
// ones); legacy sign-ins that Entra files as non-interactive are not seen, so
// the counts are a floor. clientAppUsed only supports an eq filter (no ne, no
// in), so each client value is its own query. The sign-in report endpoint is
// throttled at 5 requests per 10 seconds per tenant and sends no Retry-After
// (graphClient backs off with jitter), hence the low concurrency and page cap.
const log = require("../log");
const { graphGet } = require("../graphClient");
const { mapLimit, itemErrors, graphHint } = require("./util");

const TOOL_ID = "legacy-sign-ins";
const DAYS = 7;
const MAX_PAGES = 3; // per client value, 1000 rows a page
const CONCURRENCY = 2;
// clientAppUsed values counted as legacy. Microsoft Learn lists the short names
// (IMAP, POP, SMTP, MAPI); the portal's Client app filter and real logs show the
// long ones (IMAP4, POP3, Authenticated SMTP, MAPI Over HTTP). Both are asked
// for; an unused value costs one empty page.
const LEGACY_CLIENTS = [
  "Exchange ActiveSync", "IMAP4", "IMAP", "POP3", "POP", "Authenticated SMTP", "SMTP", "MAPI Over HTTP", "MAPI",
  "Other clients", "AutoDiscover", "Exchange Web Services", "Exchange Online PowerShell", "Offline Address Book",
  "Outlook Anywhere (RPC over HTTP)", "Reporting Web Services", "Universal Outlook",
];
const LEGACY_SET = new Set(LEGACY_CLIENTS.map((c) => c.toLowerCase()));

const noPremium = (err) => /RequestFromNonPremiumTenant|NonPremium|premium license|AadPremiumLicenseRequired/i.test(String(err && err.message));
const odataString = (s) => s.replace(/'/g, "''");

// rows: sign-in records. Keeps successful ones with a legacy client, grouped
// per user and client. Pure, for the tests.
function groupLegacy(rows) {
  const seen = new Set();
  const groups = new Map();
  for (const r of rows || []) {
    if (r.id && seen.has(r.id)) continue;
    if (r.id) seen.add(r.id);
    const client = String(r.clientAppUsed || "");
    if (!LEGACY_SET.has(client.toLowerCase())) continue;
    if (r.status && Number(r.status.errorCode) !== 0) continue;
    const user = r.userId || r.userPrincipalName || "unknown";
    const key = `${user}|${client.toLowerCase()}`;
    const g = groups.get(key) || { userId: r.userId || null, upn: r.userPrincipalName || "", displayName: r.userDisplayName || "", client, count: 0, last: null, apps: new Set() };
    g.count++;
    if (!g.last || String(r.createdDateTime) > g.last) g.last = r.createdDateTime || g.last;
    if (r.appDisplayName) g.apps.add(r.appDisplayName);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    kind: "legacy-signin-used",
    id: `${TOOL_ID}/${g.userId || g.upn}/${g.client.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    name: g.upn || g.displayName || g.userId || "Unknown user",
    detail: `${g.count} successful interactive sign-in(s) with ${g.client} in the last ${DAYS} days, last at ${g.last}${g.apps.size ? ` (${[...g.apps].slice(0, 3).join(", ")})` : ""}. Legacy clients cannot do MFA; move this user or mailbox to modern authentication and block legacy authentication with Conditional Access`,
    resourceGroup: null,
    subscriptionId: null,
    ...(g.userId && { principalId: g.userId }),
  }));
}

// One client value, at most MAX_PAGES pages. -> { rows, capped }
async function readClient(client, since) {
  const filter = `createdDateTime ge ${since} and clientAppUsed eq '${odataString(client)}' and status/errorCode eq 0`;
  let next = `/auditLogs/signIns?$filter=${encodeURIComponent(filter)}&$top=1000`;
  const rows = [];
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const data = await graphGet(next, TOOL_ID);
    rows.push(...(data.value || []));
    next = data["@odata.nextLink"] || null;
  }
  return { rows, capped: Boolean(next) };
}

async function run() {
  const since = new Date(Date.now() - DAYS * 86400000).toISOString();
  // The first client alone tells whether the tenant can read sign-ins at all.
  let first;
  try {
    first = await readClient(LEGACY_CLIENTS[0], since);
  } catch (err) {
    if (noPremium(err)) {
      log.record({ tool: TOOL_ID, level: "info", message: "Legacy sign-ins not checked: reading sign-in logs through Graph needs Microsoft Entra ID P1 or P2 in this tenant" });
      return [];
    }
    throw new Error(graphHint(err, "AuditLog.Read.All"));
  }
  const rows = [...first.rows];
  const capped = first.capped ? [LEGACY_CLIENTS[0]] : [];
  const failures = await mapLimit(LEGACY_CLIENTS.slice(1), CONCURRENCY, async (client) => {
    const r = await readClient(client, since);
    rows.push(...r.rows);
    if (r.capped) capped.push(client);
  });
  if (capped.length) {
    log.record({ tool: TOOL_ID, level: "info", message: `Legacy sign-ins: only the newest ${MAX_PAGES * 1000} sign-ins were read for ${capped.join(", ")}; counts for those clients are lower than the real ones` });
  }
  return [...groupLegacy(rows), ...itemErrors(TOOL_ID, "clients", "legacy client types", failures.map((f) => ({ ...f, message: graphHint({ message: f.message }, "AuditLog.Read.All") })), LEGACY_CLIENTS.length)];
}

module.exports = {
  id: TOOL_ID,
  label: "Legacy sign-ins",
  schedule: "55 5 * * *", // daily at 05:55
  run,
  _test: { groupLegacy, LEGACY_CLIENTS },
};
