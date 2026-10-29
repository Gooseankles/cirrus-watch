// Writes the parts of the docs that follow from the code, so they cannot drift:
// the README tools table (from the registered tools and docs/tools.md), the
// Node.js version in the README (from the Dockerfile), the tool count in
// docs/architecture.md and the tool id list in .env.example (from TOOL_SPNS).
// It also checks that every registered tool is wired up everywhere it must be.
//
//   npm run docs          rewrite the files
//   npm run docs:check    change nothing; exit 1 if a file is out of date (CI)
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, existsSync } from "node:fs";
import { listDiagrams, sourceHash } from "./diagram-hash.mjs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
// Windows checkouts have CRLF line ends; compare and write with LF (git converts).
const read = (f) => readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n");
const problems = [];

// Loading the tools reads settings; keep it away from a real data folder.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "gen-docs-"));
const require = createRequire(path.join(ROOT, "server.js"));

// --- What the code says -----------------------------------------------------
const server = read("server.js");
const tools = [...server.matchAll(/register(Scan|Action)Tool\(app, require\("(\.\/src\/tools\/\w+)"\)\)/g)].map(([, kind, file]) => {
  const m = require(file);
  return { id: m.id, label: m.label, schedule: m.schedule, action: kind === "Action" };
});
if (tools.length < 10) throw new Error(`found only ${tools.length} registered tools in server.js; did the register lines change?`);

// Cost history is not a tool module but has its own page and schedule.
const costCron = (server.match(/schedule\("([^"]+)", \(\) => costHistory\.collectAll/) || [])[1];
const rows = [...tools.filter((t) => !t.action), { id: "cost-history", label: "Cost history", schedule: costCron }, ...tools.filter((t) => t.action)];

function runs(cron) {
  if (!cron) return "On demand";
  const [min, hour, , , dow] = cron.split(/\s+/);
  if (hour === "*") return min === "*" ? "Every minute" : "Hourly";
  return dow === "*" ? "Daily" : "Weekly";
}

// --- Wiring checks ------------------------------------------------------------
const { TOOL_SPNS } = require("./src/settings");
const { TOOL_AREAS } = require("./src/access");
const { NEEDS } = require("./src/toolPermissions");
const appJs = read("public/app.js");
const toolsBlock = appJs.slice(appJs.indexOf("const TOOLS = ["), appJs.indexOf("];", appJs.indexOf("const TOOLS = [")));
const frontIds = new Set([...toolsBlock.matchAll(/\{ id: "([\w-]+)"/g)].map((m) => m[1]));
const spnIds = new Set(TOOL_SPNS.map((t) => t.id));
for (const t of tools) {
  if (!spnIds.has(t.id)) problems.push(`${t.id}: not in TOOL_SPNS (src/settings.js)`);
  if (!TOOL_AREAS[t.id]) problems.push(`${t.id}: not in TOOL_AREAS (src/access.js)`);
  if (!NEEDS[t.id]) problems.push(`${t.id}: not in src/toolPermissions.js`);
  if (!t.action && !frontIds.has(t.id)) problems.push(`${t.id}: not in TOOLS (public/app.js)`);
}

// --- docs/tools.md: one section per tool, its first paragraph is the summary ---
const toolsDoc = read("docs/tools.md");
const sections = new Map();
for (const part of toolsDoc.split(/^## /m).slice(1)) {
  const [heading, ...rest] = part.split("\n");
  const summary = rest.join("\n").trim().split(/\n\s*\n/)[0].replace(/\s*\n\s*/g, " ");
  sections.set(heading.trim(), summary);
}
for (const r of rows) if (!sections.has(r.label)) problems.push(`docs/tools.md: no "## ${r.label}" section`);
for (const label of sections.keys()) if (!rows.some((r) => r.label === label)) problems.push(`docs/tools.md: "## ${label}" is not a registered tool`);

// GitHub's heading anchors: lower case, spaces to hyphens, most punctuation dropped.
const anchor = (s) => s.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-");

// --- Rewrites -----------------------------------------------------------------
function between(text, start, end, body, file) {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a < 0 || b < a) {
    problems.push(`${file}: markers ${start} ... ${end} missing`);
    return text;
  }
  return text.slice(0, a + start.length) + "\n" + body + "\n" + text.slice(b);
}

function replaceOnce(text, re, to, file) {
  if (!re.test(text)) {
    problems.push(`${file}: nothing matches ${re}`);
    return text;
  }
  return text.replace(re, to);
}

const out = {};

const table = [
  "| Tool | Runs | What it finds or does |",
  "| --- | --- | --- |",
  ...rows.map((r) => `| [${r.label}](docs/tools.md#${anchor(r.label)}) | ${runs(r.schedule)} | ${(sections.get(r.label) || "").replace(/[\\|]/g, "\\$&")} |`),
].join("\n");
const nodeMajor = (read("Dockerfile").match(/^FROM node:(\d+)/m) || [])[1];
if (!nodeMajor) problems.push("Dockerfile: no FROM node:<major> line");
let readme = between(read("README.md"), "<!-- tools:start -->", "<!-- tools:end -->", table, "README.md");
readme = replaceOnce(readme, /Uses Node\.js \d+/, `Uses Node.js ${nodeMajor}`, "README.md");
out["README.md"] = readme;

const insideApp = "docs/diagrams/arch-inside-app.mmd";
out[insideApp] = replaceOnce(read(insideApp), /tools\/\*\.js<br\/>\d+ tools/, `tools/*.js<br/>${tools.length} tools`, insideApp);

const ids = TOOL_SPNS.map((t) => t.id);
const lines = [];
for (const id of ids) {
  const last = lines[lines.length - 1];
  if (last && `${last} ${id},`.length <= 78) lines[lines.length - 1] = `${last} ${id},`;
  else lines.push(`# ${id},`);
}
lines[lines.length - 1] = lines[lines.length - 1].replace(/,$/, ".");
out[".env.example"] = between(read(".env.example"), "# tool-ids:start", "# tool-ids:end", lines.join("\n"), ".env.example");

// --- Write or compare -----------------------------------------------------------
const stale = Object.keys(out).filter((f) => out[f] !== read(f));
if (check) {
  for (const f of stale) problems.push(`${f} is out of date: run npm run docs and commit the result`);
} else {
  for (const f of stale) writeFileSync(path.join(ROOT, f), out[f]);
  if (stale.length) console.log(`Updated ${stale.join(", ")}`);
}

// --- Diagrams: every source (.mmd or .py) has a PNG rendered from its current text, every picture the docs show exists ---
const diagramDir = path.join(ROOT, "docs", "diagrams");
const rendered = existsSync(path.join(diagramDir, "rendered.json")) ? JSON.parse(read("docs/diagrams/rendered.json")) : {};
const diagrams = listDiagrams(diagramDir);
for (const d of diagrams) {
  const text = out[`docs/diagrams/${d.file}`] ?? read(`docs/diagrams/${d.file}`);
  if (!existsSync(path.join(diagramDir, `${d.name}.png`))) problems.push(`docs/diagrams/${d.name}.png is missing: run npm run diagrams -- ${d.name}`);
  else if (rendered[d.name] !== sourceHash(diagramDir, d, text)) problems.push(`docs/diagrams/${d.name}.png is older than its .${d.kind}: run npm run diagrams -- ${d.name}`);
}
for (const f of readdirSync(diagramDir).filter((f) => f.endsWith(".png"))) {
  if (!diagrams.some((d) => d.name === f.slice(0, -4))) problems.push(`docs/diagrams/${f} has no .mmd or .py source`);
}
for (const md of ["README.md", "CONTRIBUTING.md", ...readdirSync(path.join(ROOT, "docs"), { recursive: true }).filter((f) => f.endsWith(".md")).map((f) => `docs/${f.replace(/\\/g, "/")}`)]) {
  for (const m of read(md).matchAll(/\]\(((?:\.\.\/)*(?:docs\/)?diagrams\/[\w-]+\.(?:png|mmd|py))\)/g)) {
    if (!existsSync(path.join(ROOT, path.dirname(md), m[1]))) problems.push(`${md}: ${m[1]} does not exist`);
  }
}
if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join("\n"));
  process.exit(1);
}
console.log(`Docs match the code (${tools.length} tools).`);
