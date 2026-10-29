// Renders the diagrams in docs/diagrams/*.mmd (Mermaid source) to PNG next to
// them. The docs show the PNG, so the pictures appear everywhere (GitHub's
// phone app, VS Code, Obsidian), not only where Mermaid is drawn.
//   npm run diagrams            render every diagram
//   npm run diagrams -- hld-*   render the ones whose name matches
// Needs Docker. The renderer is pinned. Each render stores the .mmd's fingerprint in
// rendered.json; docs:check fails when a .mmd has no PNG or changed after its render.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { diagramHash } from "./diagram-hash.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE = "minlag/mermaid-cli:12.0.0";
const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "diagrams");
const patterns = process.argv.slice(2).map((p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
const names = readdirSync(dir)
  .filter((f) => f.endsWith(".mmd"))
  .map((f) => f.slice(0, -4))
  .filter((n) => !patterns.length || patterns.some((re) => re.test(n)));
if (!names.length) {
  console.error("No diagrams match.");
  process.exit(1);
}
const user = typeof process.getuid === "function" ? ["-u", `${process.getuid()}:${process.getgid()}`] : [];
const hashFile = resolve(dir, "rendered.json");
const hashes = existsSync(hashFile) ? JSON.parse(readFileSync(hashFile, "utf8")) : {};
const config = readFileSync(resolve(dir, "mermaid.json"), "utf8");
const failed = [];
for (const n of names) {
  try {
    execFileSync("docker", ["run", "--rm", ...user, "-v", `${dir}:/data`, IMAGE,
      "-i", `/data/${n}.mmd`, "-o", `/data/${n}.png`, "-c", "/data/mermaid.json", "-b", "white", "-s", "2"],
    { stdio: ["ignore", "ignore", "inherit"], env: { ...process.env, MSYS_NO_PATHCONV: "1" } });
    hashes[n] = diagramHash(readFileSync(resolve(dir, `${n}.mmd`), "utf8"), config);
    console.log(`docs/diagrams/${n}.png`);
  } catch {
    failed.push(n);
  }
}
const sorted = Object.fromEntries(Object.keys(hashes).filter((k) => existsSync(resolve(dir, `${k}.mmd`))).sort().map((k) => [k, hashes[k]]));
writeFileSync(hashFile, JSON.stringify(sorted, null, 2) + "\n");
if (failed.length) {
  console.error(`Not rendered (see the error above each): ${failed.join(", ")}`);
  process.exit(1);
}
