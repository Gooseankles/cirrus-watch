// Renders the diagrams in docs/diagrams to PNG next to their source. Two kinds of
// source: *.mmd (Mermaid text: sequences and step flows) and *.py (the Python
// "diagrams" library drawing with the official Azure architecture icons: the
// architecture pictures). The docs show the PNG, so the pictures appear everywhere
// (GitHub's phone app, VS Code, Obsidian), not only where Mermaid is drawn.
//   npm run diagrams            render every diagram
//   npm run diagrams -- hld-*   render the ones whose name matches
// Needs Docker. The Mermaid renderer is a pinned public image. The Python one is built
// from docs/diagrams/Dockerfile the first time (tagged with that file's fingerprint, so
// a change there builds again) and then comes from the local cache. Each render stores
// the source's fingerprint in rendered.json; docs:check fails when a source has no PNG
// or changed after its render.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { diagramHash, listDiagrams, sourceHash } from "./diagram-hash.mjs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const MERMAID = "minlag/mermaid-cli:12.0.0";
const dir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "docs", "diagrams");
const patterns = process.argv.slice(2).map((p) => new RegExp("^" + p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$"));
const diagrams = listDiagrams(dir).filter((d) => !patterns.length || patterns.some((re) => re.test(d.name)));
if (!diagrams.length) {
  console.error("No diagrams match.");
  process.exit(1);
}
const user = typeof process.getuid === "function" ? ["-u", `${process.getuid()}:${process.getgid()}`] : [];
const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
const docker = (args, options = {}) => execFileSync("docker", args, { stdio: ["ignore", "ignore", "inherit"], env, ...options });

let pythonImage;
function python() {
  if (pythonImage) return pythonImage;
  const dockerfile = readFileSync(resolve(dir, "Dockerfile"), "utf8");
  pythonImage = `azure-ops-dashboard-diagrams:${diagramHash(dockerfile)}`;
  try {
    docker(["image", "inspect", pythonImage], { stdio: "ignore" });
  } catch {
    console.log(`Building ${pythonImage} from docs/diagrams/Dockerfile (only when that file changed)`);
    docker(["build", "-t", pythonImage, "-"], { input: dockerfile, stdio: ["pipe", "ignore", "inherit"] });
  }
  return pythonImage;
}

const render = {
  mmd: (n) => docker(["run", "--rm", ...user, "-v", `${dir}:/data`, MERMAID,
    "-i", `/data/${n}.mmd`, "-o", `/data/${n}.png`, "-c", "/data/mermaid.json", "-b", "white", "-s", "2"]),
  // -B: no __pycache__ next to the sources.
  py: (n) => docker(["run", "--rm", ...user, "-v", `${dir}:/data`, "-w", "/data", python(), "-B", `/data/${n}.py`]),
};

const hashFile = resolve(dir, "rendered.json");
const hashes = existsSync(hashFile) ? JSON.parse(readFileSync(hashFile, "utf8")) : {};
const failed = [];
for (const d of diagrams) {
  try {
    render[d.kind](d.name);
    hashes[d.name] = sourceHash(dir, d);
    console.log(`docs/diagrams/${d.name}.png`);
  } catch {
    failed.push(d.name);
  }
}
const names = new Set(listDiagrams(dir).map((d) => d.name));
const sorted = Object.fromEntries(Object.keys(hashes).filter((k) => names.has(k)).sort().map((k) => [k, hashes[k]]));
writeFileSync(hashFile, JSON.stringify(sorted, null, 2) + "\n");
if (failed.length) {
  console.error(`Not rendered (see the error above each): ${failed.join(", ")}`);
  process.exit(1);
}
