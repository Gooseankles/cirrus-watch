// Microsoft 365 roadmap: what is in development, rolling out, or launched in
// the last 60 days, from the public Microsoft 365 roadmap feed
// (src/releaseFeeds.js). The same list for every tenant: nothing is read from
// the tenant. For information: no findings.
const feeds = require("../releaseFeeds");

const TOOL_ID = "m365-roadmap";

async function run() {
  const feed = await feeds.load("m365");
  if (!feed.items.length && feed.source === "none" && !/turned off/.test(feed.note)) throw new Error(feed.note || "no roadmap items");
  return [];
}

function registerRoutes(app, { readKeys }) {
  app.get("/api/m365-roadmap", (req, res) => {
    try {
      if (!readKeys(req).length) return res.status(403).json({ error: "needs a role that can see this scan" });
      const feed = feeds.kept("m365");
      // ?count=1: only how many items the list has, for the menu and the overview card.
      if (req.query.count) return res.json({ count: feed.items.length });
      res.json({ fetchedAt: feed.fetchedAt, note: feed.note, days: feeds.M365_LAUNCHED_DAYS, items: feed.items });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Microsoft 365 roadmap",
  schedule: "15 5 * * *", // daily at 05:15
  info: true,
  run,
  registerRoutes,
};
