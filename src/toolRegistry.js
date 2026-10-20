const cron = require("node-cron");
const log = require("./log");
const findingsStore = require("./findingsStore");
const auth = require("./auth");
const { subscriptionNames } = require("./armClient");

// Findings carry subscription IDs; add the names so people can read them.
// A failed lookup only costs the names, never the scan.
async function addSubscriptionNames(toolId, findings) {
  if (!findings.some((f) => f.subscriptionId && !f.subscriptionName)) return;
  try {
    const names = await subscriptionNames(toolId);
    for (const f of findings) {
      if (f.subscriptionId && !f.subscriptionName) f.subscriptionName = names.get(f.subscriptionId) || null;
    }
  } catch (err) {
    log.record({ tool: toolId, level: "error", message: `could not look up subscription names: ${err.message}` });
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
      findingsStore.write(tool.id, findings);
      log.record({ tool: tool.id, level: "success", message: `scan complete: ${findings.length} finding(s)` });
    } catch (err) {
      log.record({ tool: tool.id, level: "error", message: err.message });
    }
  }

  app.post(`/api/tools/${tool.id}/run`, auth.requireRole("Admin"), (req, res) => {
    res.status(202).json({ status: "started" });
    execute();
  });

  app.get(`/api/tools/${tool.id}/findings`, (req, res) => {
    res.json(findingsStore.read(tool.id));
  });

  if (tool.schedule) {
    cron.schedule(tool.schedule, execute);
    console.log(`[${tool.id}] scheduled: ${tool.schedule}`);
  }

  return { id: tool.id, label: tool.label, kind: "scan" };
}

// Action tools (ones triggered on demand with input, like a lookup or a
// decommission request) register their own routes directly.
function registerActionTool(app, tool) {
  tool.registerRoutes(app);
  return { id: tool.id, label: tool.label, kind: "action" };
}

module.exports = { registerScanTool, registerActionTool };
