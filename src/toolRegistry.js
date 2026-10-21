const cron = require("node-cron");
const log = require("./log");
const findingsStore = require("./findingsStore");
const auth = require("./auth");
const { subscriptionNames } = require("./armClient");

// Findings carry subscription IDs; add the names so people can read them.
// A failed lookup only costs the names, never the scan.
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

// Mounts the two generic routes a "scan" tool needs, and wires its optional
// nightly cron schedule. A scan tool exports { id, label, schedule?, run() }
// where run() returns an array of plain-object findings.
function registerScanTool(app, tool) {
  async function execute() {
    try {
      const findings = await tool.run();
      await addSubscriptionNames(tool.id, findings);
      const saved = await findingsStore.write(tool.id, findings);
      log.record({
        tool: tool.id,
        level: "success",
        message: `scan complete: ${findings.length} finding(s), ${saved.added} new, ${saved.resolved} resolved`,
      });
    } catch (err) {
      log.record({ tool: tool.id, level: "error", message: err.message });
    }
  }

  app.post(`/api/tools/${tool.id}/run`, auth.requireRole("Admin"), (req, res) => {
    res.status(202).json({ status: "started" });
    execute();
  });

  // Names are added again on read, so results saved before a name existed
  // (or by an older version) still show it.
  app.get(`/api/tools/${tool.id}/findings`, async (req, res) => {
    try {
      const data = await findingsStore.read(tool.id);
      await addSubscriptionNames(tool.id, data.findings || [], { quiet: true });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-run counts for the trend chart, oldest first.
  app.get(`/api/tools/${tool.id}/history`, async (req, res) => {
    try {
      res.json(await findingsStore.history(tool.id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // One past run: its findings plus what was new and what was resolved.
  app.get(`/api/tools/${tool.id}/history/:ranAt`, async (req, res) => {
    try {
      const run = await findingsStore.readRun(tool.id, req.params.ranAt);
      if (!run) return res.status(404).json({ error: "no such run" });
      await addSubscriptionNames(tool.id, [...run.findings, ...run.added, ...run.resolved], { quiet: true });
      res.json(run);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  if (tool.schedule) {
    cron.schedule(tool.schedule, execute);
    console.log(`[${tool.id}] scheduled: ${tool.schedule}`);
  }

  return { id: tool.id, label: tool.label, kind: "scan" };
}

// Action tools (ones triggered on demand with input, like a lookup) register their own routes directly.
function registerActionTool(app, tool) {
  tool.registerRoutes(app);
  return { id: tool.id, label: tool.label, kind: "action" };
}

module.exports = { registerScanTool, registerActionTool };
