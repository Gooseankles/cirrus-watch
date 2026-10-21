const fs = require("fs");
const path = require("path");

const { LOG_DIR } = require("./paths");
const tenantContext = require("./tenantContext");
const LOG_FILE = path.join(LOG_DIR, "runs.jsonl");

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Appends one JSON-lines record per automation run/step so the dashboard
// can show a history without a database. `tool` identifies which tool the
// entry belongs to (e.g. "orphaned-resources", "access-lookup").
function record(entry) {
  ensureLogDir();
  const line = JSON.stringify({ time: new Date().toISOString(), tool: "general", ...entry }) + "\n";
  fs.appendFileSync(LOG_FILE, line);
}

// tenants: only entries for these tenant keys (null = everything).
function readAll({ limit = 200, tool, tenants } = {}) {
  ensureLogDir();
  if (!fs.existsSync(LOG_FILE)) return [];
  const lines = fs.readFileSync(LOG_FILE, "utf8").trim().split("\n").filter(Boolean);
  let entries = lines.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { time: null, tool: "general", level: "error", message: "unparseable log line", raw: l };
    }
  });
  if (tool) entries = entries.filter((e) => e.tool === tool);
  if (tenants) entries = entries.filter((e) => e.tenant && tenants.includes(e.tenant));
  return entries.slice(-limit).reverse();
}

module.exports = { record, readAll };
