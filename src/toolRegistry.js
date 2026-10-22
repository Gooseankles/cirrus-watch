const cron = require("node-cron");
const log = require("./log");
const findingsStore = require("./findingsStore");
const tenants = require("./tenants");
const tenantContext = require("./tenantContext");
const access = require("./access");
const suppressions = require("./suppressions");
const { subscriptionNames } = require("./armClient");

// Findings carry subscription IDs; add the names so people can read them.
// A failed lookup only costs the names, never the scan. Runs inside the
// finding's tenant, so the names come from that tenant's identity.
async function addSubscriptionNames(toolId, findings, { quiet = false } = {}) {
  if (!findings.some((f) => f.subscriptionId && !f.subscriptionName)) return;
  try {
    const names = await subscriptionNames(toolId);
    for (const f of findings) {
      if (f.subscriptionId && !f.subscriptionName) f.subscriptionName = names.get(f.subscriptionId) || null;
    }
  } catch (err) {
    if (!quiet) log.record({ tool: toolId, level: "error", message: `could not look up subscription names: ${err.message}` });
  }
}

// On read: names for each tenant's findings, and the tenant's current name.
async function decorate(toolId, findings) {
  const groups = new Map();
  for (const f of findings) {
    const k = findingsStore.tenantOf(f);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(f);
  }
  const multi = tenants.isMultiTenant();
  for (const [k, list] of groups) {
    const t = tenants.byKey(k);
    if (t) await tenantContext.runIn(t, () => addSubscriptionNames(toolId, list, { quiet: true }));
    if (multi) for (const f of list) f.tenantName = t ? t.name : k;
  }
}

// The tenants whose stored results a request reads: those the person may see
// (narrowed by ?tenant=) that still exist. A removed tenant's data stays in
// its container but is no longer shown.
function readKeys(req) {
  const scope = access.readScope(req);
  const known = tenants.all().map((t) => t.key);
  return scope === null ? known : scope.filter((k) => known.includes(k));
}

// Accept or snooze one finding (body: key, tenant, reason, until) or take
// that back. Needs Run now rights in the finding's tenant.
const MAX_SNOOZE_DAYS = 3 * 365;
function acceptTarget(req, res) {
  const b = req.body || {};
  const tenantKey = String(b.tenant || tenants.HOME).toLowerCase();
  const key = typeof b.key === "string" ? b.key : "";
  const refuse = (status, error) => {
    res.status(status).json({ error });
    return null;
  };
  if (!key || key.length > 2000) return refuse(400, "finding key missing");
  if (!tenants.byKey(tenantKey)) return refuse(400, "no such tenant");
  if (!access.inScope(access.runScope(req), tenantKey)) return refuse(403, "you cannot change findings in that tenant");
  return { tenantKey, key };
}
function whoIs(req) {
  const u = (req.session && req.session.user) || {};
  return u.upn || u.name || "unknown";
}

// Mounts the generic routes a "scan" tool needs, and wires its optional
// nightly cron schedule. A scan tool exports { id, label, schedule?, run() }
// where run() returns an array of plain-object findings. The scan runs once
// per tenant (home plus each customer tenant); customer findings get `tenant`.
function registerScanTool(app, tool) {
  // only: tenant keys to scan (null = every enabled tenant). A tenant already
  // being scanned (Run now during the nightly run, or a double click) is
  // skipped, so two runs never race over the same results.
  const busy = new Set();
  async function execute(only = null) {
    const wanted = tenants.scanTargets().filter((t) => !only || only.includes(t.key));
    const targets = wanted.filter((t) => !busy.has(t.key));
    if (targets.length < wanted.length) {
      log.record({ tool: tool.id, level: "info", message: `already running for ${wanted.filter((t) => busy.has(t.key)).map((t) => tenants.nameOf(t.key)).join(", ")}; not started again there` });
    }
    if (!targets.length) return;
    targets.forEach((t) => busy.add(t.key));
    try {
      await scan(targets);
    } finally {
      targets.forEach((t) => busy.delete(t.key));
    }
  }

  async function scan(targets) {
    const multi = tenants.isMultiTenant();
    const findings = [];
    const done = [];
    const errors = {};
    for (const t of targets) {
      try {
        const found = await tenantContext.runIn(t, async () => {
          const list = await tool.run();
          await addSubscriptionNames(tool.id, list);
          return list;
        });
        for (const f of found) {
          delete f.tenantName;
          if (!t.home) f.tenant = t.key;
        }
        findings.push(...found);
        done.push(t.key);
      } catch (err) {
        errors[t.key] = String(err.message || err).slice(0, 500);
        // final: false = other tenants still run, so Run now keeps waiting.
        log.record({ tool: tool.id, tenant: t.key, level: "error", final: targets.length === 1, message: multi ? `${t.name}: ${err.message}` : err.message });
      }
    }
    if (!done.length) {
      // Nothing new; the last results stay, with the error noted on them so
      // the scan page shows why after a reload too.
      const at = new Date().toISOString();
      for (const [k, message] of Object.entries(errors)) {
        await findingsStore.writeTenantError(tool.id, k, at, message).catch((err) => log.record({ tool: tool.id, level: "error", message: `could not save the error: ${err.message}` }));
      }
      if (targets.length > 1) log.record({ tool: tool.id, level: "error", final: true, message: "scan failed in every tenant" });
      return;
    }
    try {
      const saved = await findingsStore.write(tool.id, findings, { tenants: done, errors });
      const failed = Object.keys(errors).length;
      log.record({
        tool: tool.id,
        ...(done.length === 1 && { tenant: done[0] }),
        level: "success",
        message:
          `scan complete${multi ? ` (${done.map(tenants.nameOf).join(", ")})` : ""}: ${findings.length} finding(s), ` +
          `${saved.added} new, ${saved.resolved} resolved${failed ? `; ${failed} tenant(s) failed, their last results kept` : ""}`,
      });
    } catch (err) {
      log.record({ tool: tool.id, level: "error", message: err.message });
    }
  }

  // Global Admin runs every tenant; Admin-<key> only theirs (?tenant= narrows).
  app.post(`/api/tools/${tool.id}/run`, access.requireRunner, (req, res) => {
    const keys = access.runScope(req);
    if (keys && !keys.length) return res.status(403).json({ error: "you cannot run scans in that tenant" });
    res.status(202).json({ status: "started" });
    execute(keys);
  });

  app.post(`/api/tools/${tool.id}/accept`, access.requireRunner, async (req, res) => {
    const target = acceptTarget(req, res);
    if (!target) return;
    const b = req.body || {};
    const reason = typeof b.reason === "string" ? b.reason.trim() : "";
    if (!reason || reason.length > 500) return res.status(400).json({ error: "give a reason (at most 500 characters)" });
    let until = null;
    if (b.until) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.until)) || !Date.parse(b.until)) return res.status(400).json({ error: "until must be a date (YYYY-MM-DD)" });
      const t = Date.parse(`${b.until}T00:00:00Z`);
      if (t <= Date.now()) return res.status(400).json({ error: "until must be in the future" });
      if (t > Date.now() + MAX_SNOOZE_DAYS * 86400000) return res.status(400).json({ error: "until is more than three years away; accept it without a date instead" });
      until = new Date(t).toISOString();
    }
    try {
      // Only a finding the tenant's latest results hold can be accepted.
      const latest = await findingsStore.read(tool.id, [target.tenantKey]);
      const f = latest.findings.find((x) => findingsStore.findingKey(x) === target.key);
      if (!f) return res.status(404).json({ error: "that finding is not in the latest results" });
      const entry = { reason, until, by: whoIs(req), at: new Date().toISOString(), kind: f.kind || null, name: f.name || f.id || null };
      await suppressions.set(tool.id, target.tenantKey, target.key, entry);
      log.record({ tool: tool.id, tenant: target.tenantKey, level: "info", message: `${entry.by} ${until ? `snoozed until ${until.slice(0, 10)}` : "accepted"}: ${entry.name || target.key} (${reason})` });
      res.json({ ok: true, accepted: entry });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post(`/api/tools/${tool.id}/unaccept`, access.requireRunner, async (req, res) => {
    const target = acceptTarget(req, res);
    if (!target) return;
    try {
      const had = await suppressions.remove(tool.id, target.tenantKey, target.key);
      if (had) log.record({ tool: tool.id, tenant: target.tenantKey, level: "info", message: `${whoIs(req)} reopened ${had.name || target.key}` });
      res.json({ ok: true, removed: Boolean(had) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Names are added again on read, so results saved before a name existed
  // (or by an older version) still show it. Accepted ones carry `accepted`.
  app.get(`/api/tools/${tool.id}/findings`, async (req, res) => {
    try {
      const data = await findingsStore.read(tool.id, readKeys(req));
      await decorate(tool.id, data.findings);
      await suppressions.mark(tool.id, data.findings);
      for (const [k, e] of Object.entries(data.tenantErrors)) e.tenantName = tenants.nameOf(k);
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-run counts for the trend chart, oldest first.
  app.get(`/api/tools/${tool.id}/history`, async (req, res) => {
    try {
      res.json(await findingsStore.history(tool.id, readKeys(req)));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // One past run: its findings plus what was new and what was resolved.
  app.get(`/api/tools/${tool.id}/history/:ranAt`, async (req, res) => {
    try {
      const run = await findingsStore.readRun(tool.id, req.params.ranAt, readKeys(req));
      if (!run) return res.status(404).json({ error: "no such run" });
      await decorate(tool.id, [...run.findings, ...run.added, ...run.resolved]);
      res.json(run);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // A scan with its own pages (like the IPAM inventory) adds read routes here.
  if (tool.registerRoutes) tool.registerRoutes(app, { readKeys, decorate });

  if (tool.schedule) {
    cron.schedule(tool.schedule, () => execute());
    console.log(`[${tool.id}] scheduled: ${tool.schedule}`);
  }

  return { id: tool.id, label: tool.label, kind: "scan", ...(tool.info && { info: true }) };
}

// Action tools (ones triggered on demand with input, like a lookup) register their own routes directly.
function registerActionTool(app, tool) {
  tool.registerRoutes(app);
  return { id: tool.id, label: tool.label, kind: "action" };
}

module.exports = { registerScanTool, registerActionTool, readKeys, decorate };
