// Last-run results per scan tool, so the dashboard has something to show
// without re-running the scan on every page load.
const fs = require("fs");
const path = require("path");

const { DATA_DIR } = require("./paths");

const DIR = path.join(DATA_DIR, "findings");

function ensureDir() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
}

function write(toolId, findings) {
  ensureDir();
  const payload = { ranAt: new Date().toISOString(), findings };
  fs.writeFileSync(path.join(DIR, `${toolId}.json`), JSON.stringify(payload, null, 2));
}

function read(toolId) {
  ensureDir();
  const file = path.join(DIR, `${toolId}.json`);
  if (!fs.existsSync(file)) return { ranAt: null, findings: [] };
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { ranAt: null, findings: [] };
  }
}

module.exports = { write, read };
