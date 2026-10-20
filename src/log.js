const fs = require("fs");
const path = require("path");

const { LOG_DIR } = require("./paths");
const LOG_FILE = path.join(LOG_DIR, "runs.jsonl");

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Appends one JSON-lines record per automation run/step so the dashboard
// can show a history without a database. `tool` identifies which tool the
// entry belongs to (e.g. "subscription-create", "orphaned-resources").
function record(entry) {
  ensureLogDir();
  const line = JSON.stringify({ time: new Date().toISOString(), tool: "general", ...entry }) + "\n";
  fs.appendFileSync(LOG_FILE, line);
}

function readAll({ limit = 200, tool } = {}) {
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
  return entries.slice(-limit).reverse();
}

module.exports = { record, readAll };
