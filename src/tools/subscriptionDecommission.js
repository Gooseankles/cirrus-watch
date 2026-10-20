const { armPost, subscriptionLabel } = require("../armClient");
const { addWorkNote } = require("../servicenow");
const log = require("../log");

const REQUIRED_CHECKLIST = ["backupsConfirmed", "dnsRemoved", "budgetAlertsCleared"];

async function cancelSubscription(subscriptionId) {
  const url = `https://management.azure.com/subscriptions/${subscriptionId}/providers/Microsoft.Subscription/cancel?api-version=2021-10-01`;
  return armPost(url, {}, "subscription-decommission");
}

function registerRoutes(app) {
  // Mirrors /webhook/create-subscription's shape, but refuses to call Azure
  // until the checklist ServiceNow sends back confirms it's actually safe —
  // cancelling a subscription is destructive for anything still live in it.
  app.post("/webhook/decommission-subscription", (req, res, next) => {
    const expected = process.env.WEBHOOK_SHARED_SECRET;
    if (!expected || expected === "change-me") {
      return res.status(500).json({ error: "WEBHOOK_SHARED_SECRET not configured on server" });
    }
    if (req.get("X-Webhook-Secret") !== expected) {
      return res.status(401).json({ error: "bad or missing X-Webhook-Secret" });
    }
    next();
  }, async (req, res) => {
    const { ticketNumber, table, sysId, subscriptionId, checklist } = req.body || {};
    if (!ticketNumber || !subscriptionId) {
      return res.status(400).json({ error: "ticketNumber and subscriptionId are required" });
    }

    const missing = REQUIRED_CHECKLIST.filter((k) => !(checklist && checklist[k] === true));
    if (missing.length) {
      log.record({
        tool: "subscription-decommission",
        level: "error",
        ticketNumber,
        message: `refused: checklist incomplete (missing: ${missing.join(", ")})`,
      });
      return res.status(400).json({ error: `checklist incomplete, missing: ${missing.join(", ")}` });
    }

    res.status(202).json({ status: "accepted", ticketNumber });
    const label = await subscriptionLabel(subscriptionId, "subscription-decommission");
    log.record({ tool: "subscription-decommission", level: "info", ticketNumber, message: `decommissioning ${label}` });

    try {
      await cancelSubscription(subscriptionId);
      log.record({ tool: "subscription-decommission", level: "success", ticketNumber, message: `cancelled ${label}` });
      if (table && sysId) {
        await addWorkNote(table, sysId, `Azure subscription ${label} has been cancelled.`);
      }
    } catch (err) {
      log.record({ tool: "subscription-decommission", level: "error", ticketNumber, message: err.message });
      if (table && sysId) {
        try {
          await addWorkNote(table, sysId, `Azure subscription cancellation failed: ${err.message}`);
        } catch {
          // ServiceNow itself unreachable; already logged the real error above.
        }
      }
    }
  });
}

module.exports = { id: "subscription-decommission", label: "Subscription decommission", registerRoutes };
