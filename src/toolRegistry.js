const cron = require("node-cron");
const log = require("./log");
const findingsStore = require("./findingsStore");
const tenants = require("./tenants");
const tenantContext = require("./tenantContext");
const access = require("./access");
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

// Mounts the generic routes a "scan" tool needs, and wires its optional
// nightly cron schedule. A scan tool exports { id, label, schedule?, run() }
// where run() returns an array of plain-object findings. The scan runs once
// per tenant (home plus each customer tenant); customer findings get `tenant`.
function registerScanTool(app, tool) {
  // only: tenant keys to scan (null = every enabled tenant).
  async function execute(only = null) {
    const targets = tenants.scanTargets().filter((t) => !only || only.includes(t.key));
    if (!targets.length) return;
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
      // Nothing new; the last results stay as they are.
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

  // Names are added again on read, so results saved before a name existed
  // (or by an older version) still show it.
  app.get(`/api/tools/${tool.id}/findings`, async (req, res) => {
    try {
      const data = await findingsStore.read(tool.id, readKeys(req));
      await decorate(tool.id, data.findings);
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

  if (tool.schedule) {
    cron.schedule(tool.schedule, () => execute());
    console.log(`[${tool.id}] scheduled: ${tool.schedule}`);
  }

  return { id: tool.id, label: tool.label, kind: "scan" };
}

// Action tools (ones triggered on demand with input, like a lookup) register their own routes directly.
function registerActionTool(app, tool) {
  tool.registerRoutes(app);
  return { id: tool.id, label: tool.label, kind: "action" };
}

module.exports = { registerScanTool, registerActionTool, readKeys };
