// Notifications: once a day (NOTIFY_TIME, server time, after the nightly
// scans) each tenant gets one message in its own channel listing what the
// scans found since the last message: new findings and failed scans. Accepted
// and snoozed findings and the change log are left out; a day with nothing new
// sends nothing.
//
// Each tenant has one link: a Teams channel's Workflows webhook ("Post to a
// channel when a webhook request is received"), a Slack incoming webhook, or
// any other https endpoint (Power Automate, Logic Apps, n8n), which gets the
// Teams body plus `text` and a plain `summary`. Or, where webhooks are
// blocked, email addresses (a Teams channel's email address works too): the
// mail goes out through Microsoft Graph from NOTIFY_MAIL_FROM, a mailbox in the
// home tenant, with the dashboard's own identity (Mail.Send). The link carries its own
// signature, so it is kept like a secret: in the key vault when
// SECRET_VAULT_URL is set (secretStore kind "notify"), else DATA_DIR/notify.json.
// Only tenants with a link collect anything.
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cron = require("node-cron");
const { graphPost } = require("./graphClient");

const { DATA_DIR } = require("./paths");
const { writeAtomic } = require("./jsonFile");
const secretStore = require("./secretStore");
const settings = require("./settings");
const tenants = require("./tenants");
const suppressions = require("./suppressions");
const log = require("./log");
const tenantContext = require("./tenantContext");

const LINKS_PATH = path.join(DATA_DIR, "notify.json");
const QUEUE_PATH = path.join(DATA_DIR, "notify-queue.json");
const KIND = "notify";
const TOOL = "notifications";
const MAX_ITEMS = 25; // listed in one message; the rest are counted
const MAX_QUEUED = 2000; // per tenant, so a broken link cannot grow the file without end
const RETRY_MS = 60 * 60 * 1000; // a failed send is tried again hourly
const TIMEOUT_MS = 20 * 1000;
const DEFAULT_TIME = "08:30";
const MAX_RECIPIENTS = 20;
// The domain parts exclude the dot, so the match cannot backtrack on a long string.
const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>".]+(?:\.[^\s@,;<>".]+)+$/;

// "a@x.no, b@x.no" (commas or semicolons) -> the addresses; null when it is not a list of addresses.
function emailsOf(value) {
  const text = String(value || "");
  if (text.length > 5000) return null;
  const list = text.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return list.length && list.every((s) => EMAIL.test(s)) ? list : null;
}

function readJson(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// --- links ---

function linkOf(key) {
  return (secretStore.enabled() && secretStore.get(KIND, key)) || String(readJson(LINKS_PATH)[key] || "").trim();
}

function checkLink(url) {
  const mails = emailsOf(url);
  if (mails) {
    if (mails.length > MAX_RECIPIENTS) throw new Error(`at most ${MAX_RECIPIENTS} email addresses`);
    return;
  }
  if (!/^https?:/i.test(url) && url.includes("@")) throw new Error("not a valid list of email addresses (separate them with commas)");
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error("the link is not a valid URL");
  }
  if (u.protocol !== "https:") throw new Error("the link must start with https:// (or be email addresses)");
  if (url.length > 2000) throw new Error("the link is longer than 2000 characters");
}

// body: { url } saves a new link; { clear: true } removes it (and what was waiting).
async function setLink(key, body) {
  if (!tenants.byKey(key)) throw new Error("no such tenant");
  const url = typeof body.url === "string" ? body.url.trim() : "";
  if (url) {
    checkLink(url);
    if (secretStore.enabled()) {
      await secretStore.set(KIND, key, url);
      dropFromFile(key);
    } else {
      writeAtomic(LINKS_PATH, { ...readJson(LINKS_PATH), [key]: url });
    }
  } else if (body.clear) {
    await drop(key);
  }
  return describe(key);
}

function dropFromFile(key) {
  const links = readJson(LINKS_PATH);
  if (links[key] === undefined) return;
  delete links[key];
  writeAtomic(LINKS_PATH, links);
}

// A tenant's link and queue go (link removed, or the tenant itself). With
// purge (a tenant removed for good) the vault's copy is also purged from its
// bin; returns secretStore.purge()'s outcome then, else nothing.
async function drop(key, { purge = false } = {}) {
  let outcome;
  if (secretStore.enabled()) outcome = purge ? await secretStore.purge(KIND, key) : await secretStore.remove(KIND, key);
  dropFromFile(key);
  const q = readJson(QUEUE_PATH);
  if (q[key]) {
    delete q[key];
    writeAtomic(QUEUE_PATH, q);
  }
  return outcome;
}

// Links still in notify.json move into the key vault once it is loaded.
async function moveSecretsToVault() {
  if (!secretStore.enabled() || !secretStore.ready()) return 0;
  let moved = 0;
  for (const [key, url] of Object.entries(readJson(LINKS_PATH))) {
    if (!url) continue;
    if (!secretStore.has(KIND, key)) await secretStore.set(KIND, key, String(url).trim());
    dropFromFile(key);
    moved++;
  }
  return moved;
}

// For Settings: never the link itself, which works as a password.
function describe(key) {
  const url = linkOf(key);
  const q = readJson(QUEUE_PATH)[key] || {};
  return {
    tenant: key,
    tenantName: tenants.nameOf(key),
    isSet: Boolean(url),
    where: !url ? null : secretStore.enabled() && secretStore.has(KIND, key) ? "key vault" : "file",
    kind: url ? linkKind(url) : null,
    // Email addresses are not a secret, a webhook link is.
    to: (url && emailsOf(url)) || null,
    mailFrom: mailFrom() || null,
    pending: (q.items || []).length + (q.errors || []).length,
    lastSent: q.lastSent || null,
    lastError: q.lastError || null,
    lastErrorAt: q.lastErrorAt || null,
    time: sendTime(),
  };
}

// --- queue ---

// After a scan has saved its results: the new findings per tenant ({ key:
// [finding] }) and the tenants whose scan failed ({ key: message }).
async function queue(tool, newByTenant, errors) {
  if (tool.info) return;
  const keys = [...new Set([...Object.keys(newByTenant || {}), ...Object.keys(errors || {})])].filter((k) => linkOf(k));
  if (!keys.length) return;
  const found = keys.flatMap((k) => newByTenant[k] || []);
  await suppressions.mark(tool.id, found).catch(() => {});
  const q = readJson(QUEUE_PATH);
  const at = new Date().toISOString();
  for (const k of keys) {
    const e = q[k] || { items: [], errors: [] };
    e.items = e.items || [];
    e.errors = e.errors || [];
    for (const f of (newByTenant[k] || []).filter((x) => !x.accepted)) {
      e.items.push({
        tool: tool.id,
        label: tool.label,
        kind: f.kind || null,
        name: String(f.name || f.id || "").slice(0, 200),
        detail: String(f.detail || "").slice(0, 300),
        ...(f.subscriptionName && { subscription: f.subscriptionName }),
        at,
      });
    }
    if (errors && errors[k]) {
      e.errors = e.errors.filter((x) => x.tool !== tool.id);
      e.errors.push({ tool: tool.id, label: tool.label, message: String(errors[k]).slice(0, 300), at });
    }
    if (e.items.length > MAX_QUEUED) e.items = e.items.slice(-MAX_QUEUED);
    q[k] = e;
  }
  writeAtomic(QUEUE_PATH, q);
}

// --- messages ---

function linkKind(url) {
  if (emailsOf(url)) return "email";
  const host = (() => {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch {
      return "";
    }
  })();
  if (host === "hooks.slack.com") return "slack";
  if (/(^|\.)(logic\.azure\.com|powerplatform\.com|powerautomate\.com|webhook\.office\.com)$/.test(host)) return "teams";
  return "webhook";
}

function dashboardUrl() {
  try {
    const u = new URL(process.env.DASHBOARD_REDIRECT_URI || "");
    return u.origin;
  } catch {
    return null;
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// { title, lines: [{ heading, bullets }], more } -> the three body shapes.
function compose(key, entry) {
  const name = tenants.nameOf(key);
  const items = entry.items || [];
  const errors = entry.errors || [];
  const parts = [];
  if (items.length) parts.push(plural(items.length, "new finding"));
  if (errors.length) parts.push(plural(errors.length, "failed scan"));
  const title = `${name}: ${parts.join(", ")}`;

  const byTool = new Map();
  for (const it of items) {
    if (!byTool.has(it.tool)) byTool.set(it.tool, { label: it.label, list: [] });
    byTool.get(it.tool).list.push(it);
  }
  const sections = [];
  let shown = 0;
  for (const [id, g] of byTool) {
    const room = Math.max(MAX_ITEMS - shown, 0);
    const list = g.list.slice(0, room);
    shown += list.length;
    sections.push({
      id,
      heading: `${g.label} (${g.list.length} new)`,
      bullets: list.map((it) => `${it.name}${it.subscription ? ` [${it.subscription}]` : ""}${it.detail ? `: ${it.detail}` : ""}`),
      hidden: g.list.length - list.length,
    });
  }
  if (errors.length) {
    sections.push({ id: null, heading: "Scans that failed", bullets: errors.map((e) => `${e.label}: ${e.message}`), hidden: 0 });
  }
  return { title, sections, tenant: key, tenantName: name, newFindings: items.length, failedScans: errors.length };
}

function bodies(msg, url) {
  const site = dashboardUrl();
  const textLines = [msg.title];
  for (const s of msg.sections) {
    textLines.push("", s.heading);
    for (const b of s.bullets) textLines.push(`- ${b}`);
    if (s.hidden) textLines.push(`- and ${s.hidden} more`);
  }
  if (site) textLines.push("", site);
  const text = textLines.join("\n");
  if (linkKind(url) === "slack") return { text };

  const card = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    msteams: { width: "Full" },
    body: [
      { type: "TextBlock", text: msg.title, weight: "Bolder", size: "Medium", wrap: true },
      ...msg.sections.flatMap((s) => [
        { type: "TextBlock", text: s.heading, weight: "Bolder", spacing: "Medium", wrap: true },
        {
          type: "TextBlock",
          text: [...s.bullets.map((b) => `- ${b.replace(/\n/g, " ")}`), ...(s.hidden ? [`- and ${s.hidden} more`] : [])].join("\n"),
          wrap: true,
          spacing: "Small",
        },
      ]),
    ],
    ...(site && { actions: [{ type: "Action.OpenUrl", title: "Open Cirrus Watch", url: site }] }),
  };
  return {
    type: "message",
    attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", contentUrl: null, content: card }],
    text,
    summary: {
      source: "azure-ops-dashboard",
      tenant: msg.tenant,
      tenantName: msg.tenantName,
      newFindings: msg.newFindings,
      failedScans: msg.failedScans,
      sections: msg.sections,
      url: site,
    },
  };
}

function mailFrom() {
  return String(settings.get("NOTIFY_MAIL_FROM") || "").trim();
}

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// The message as a plain HTML mail body. Pure, for the tests.
function mailHtml(msg) {
  const site = dashboardUrl();
  const font = "font-family:Segoe UI,Arial,sans-serif";
  const parts = [`<h2 style="${font};font-size:18px;margin:0 0 12px">${escHtml(msg.title)}</h2>`];
  for (const s of msg.sections) {
    parts.push(`<h3 style="${font};font-size:15px;margin:16px 0 6px">${escHtml(s.heading)}</h3>`);
    const items = [...s.bullets.map(escHtml), ...(s.hidden ? [`and ${s.hidden} more`] : [])];
    parts.push(`<ul style="${font};font-size:14px;margin:0;padding-left:20px">${items.map((b) => `<li style="margin:2px 0">${b}</li>`).join("")}</ul>`);
  }
  if (site) parts.push(`<p style="${font};font-size:14px;margin-top:18px"><a href="${escHtml(site)}">Open Cirrus Watch</a></p>`);
  return parts.join("\n");
}

// Sent as the home tenant's identity from the NOTIFY_MAIL_FROM mailbox, whichever tenant the message is about.
async function sendMail(to, msg) {
  const from = mailFrom();
  if (!from) throw new Error("set Send email from (Settings, Home tab, Notifications) to send email");
  try {
    await tenantContext.runIn(null, () =>
      graphPost(
        `/users/${encodeURIComponent(from)}/sendMail`,
        {
          message: { subject: msg.title, body: { contentType: "HTML", content: mailHtml(msg) }, toRecipients: to.map((address) => ({ emailAddress: { address } })) },
          saveToSentItems: false,
        },
        TOOL
      )
    );
  } catch (err) {
    const m = String(err.message || err);
    if (/\(403\)/.test(m)) throw new Error(`the dashboard may not send mail as ${from}: give the dashboard's identity the Exchange role Application Mail.Send in a scope that includes this mailbox (RBAC for Applications, see docs/guides/notifications.md; a new role takes up to two hours)`);
    if (/\(404\)/.test(m)) throw new Error(`no mailbox ${from} in the home tenant`);
    throw new Error(m.slice(0, 300));
  }
}

// Webhook or email, by what the link is.
function deliver(url, msg) {
  const to = emailsOf(url);
  return to ? sendMail(to, msg) : post(url, bodies(msg, url));
}

async function post(url, body) {
  const resp = await axios.post(url, body, { timeout: TIMEOUT_MS, validateStatus: () => true, maxRedirects: 0, headers: { "Content-Type": "application/json" } });
  if (resp.status < 200 || resp.status >= 300) {
    const said = typeof resp.data === "string" ? resp.data : JSON.stringify(resp.data || "");
    throw new Error(`the link answered ${resp.status}${said ? `: ${said.slice(0, 200)}` : ""}`);
  }
}

// --- sending ---

const sending = new Set();

async function sendTenant(key) {
  if (sending.has(key)) return;
  const url = linkOf(key);
  if (!url) return;
  const q = readJson(QUEUE_PATH);
  const entry = q[key];
  if (!entry || !((entry.items || []).length || (entry.errors || []).length)) return;
  sending.add(key);
  // What is sent now; anything queued while it is on its way stays for next time.
  const sentItems = (entry.items || []).length;
  const sentErrors = (entry.errors || []).length;
  try {
    const msg = compose(key, entry);
    await deliver(url, msg);
    const now = readJson(QUEUE_PATH);
    const e = now[key] || {};
    now[key] = { items: (e.items || []).slice(sentItems), errors: (e.errors || []).slice(sentErrors), lastSent: new Date().toISOString(), lastError: null, lastErrorAt: null };
    writeAtomic(QUEUE_PATH, now);
    log.record({ tool: TOOL, ...(key !== tenants.HOME && { tenant: key }), level: "success", message: `sent to ${tenants.nameOf(key)}: ${msg.title}` });
  } catch (err) {
    const now = readJson(QUEUE_PATH);
    now[key] = { ...(now[key] || {}), lastError: err.message, lastErrorAt: new Date().toISOString() };
    writeAtomic(QUEUE_PATH, now);
    log.record({ tool: TOOL, ...(key !== tenants.HOME && { tenant: key }), level: "error", message: `could not send to ${tenants.nameOf(key)}, trying again in an hour: ${err.message}` });
  } finally {
    sending.delete(key);
  }
}

async function sendTest(key) {
  const url = linkOf(key);
  if (!url) return { ok: false, error: "no link saved for this tenant" };
  const msg = {
    title: `${tenants.nameOf(key)}: test message`,
    sections: [{ id: null, heading: "Notifications work", bullets: [`New findings and failed scans will come here once a day at ${sendTime()} (server time).`], hidden: 0 }],
    tenant: key,
    tenantName: tenants.nameOf(key),
    newFindings: 0,
    failedScans: 0,
  };
  try {
    await deliver(url, msg);
    return { ok: true, kind: linkKind(url) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function sendTime() {
  const v = String(settings.get("NOTIFY_TIME") || "").trim();
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : DEFAULT_TIME;
}

// Every minute: at the send time, every tenant with something waiting; in
// between, a tenant whose last send failed, once an hour has passed.
function tick(now = new Date()) {
  const hhmm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const due = hhmm === sendTime();
  const q = readJson(QUEUE_PATH);
  for (const t of tenants.all()) {
    const e = q[t.key];
    if (!e) continue;
    const retry = e.lastErrorAt && now.getTime() - Date.parse(e.lastErrorAt) >= RETRY_MS;
    if (due || retry) sendTenant(t.key);
  }
}

function start() {
  cron.schedule("* * * * *", () => tick());
}

module.exports = { start, queue, setLink, drop, describe, sendTest, moveSecretsToVault, TOOL, _test: { compose, bodies, linkKind, tick, emailsOf, checkLink, mailHtml } };
