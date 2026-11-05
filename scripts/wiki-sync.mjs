// Mirrors docs/ to the repository's GitHub wiki: one wiki page per Markdown file
// in docs/, docs/guides and docs/adr, Home from docs/README.md, a sidebar from
// its sections and a footer saying where the text comes from. Links between the
// pages become wiki links, links to other repository files become GitHub URLs
// and pictures are served from the repository. The wiki is only written, never
// read: hand edits there are lost at the next run. wiki.yml runs this after
// every change to docs/ on main.
//
//   node scripts/wiki-sync.mjs <wiki checkout>                  write the pages, remove stale ones
//   node scripts/wiki-sync.mjs <folder> --repo owner/name       for another repository name
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = path.join(ROOT, "docs");
// The docs sub-folders that become pages. Research notes and diagram sources stay in the repository.
const FOLDERS = ["", "guides", "adr"];
const IMAGE = /\.(png|jpe?g|gif|svg|webp)$/i;
export const DEFAULT_REPO = "Gooseankles/cirrus-watch";

// Windows checkouts have CRLF line ends; work with LF (git converts).
const read = (f) => readFileSync(f, "utf8").replace(/\r\n/g, "\n");
const h1 = (md) => (md.match(/^# (.+)$/m) || [, ""])[1].trim();

// A wiki file name: letters, digits, dots (as in "3.0") and dashes (the wiki shows dashes as spaces).
export const slug = (text) =>
  text
    .replace(/[^\p{L}\p{N}. -]/gu, "")
    .replace(/^[. ]+|[. ]+$/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");

// docs/README.md is Home; a decision record "0003. Title" is ADR-0003-Title; every other page is named by its title.
export function pageName(rel, title) {
  if (rel === "README.md") return "Home";
  const adr = rel.startsWith("adr/") && title.match(/^(\d{4})\.\s+(.+)$/);
  if (adr) return `ADR-${adr[1]}-${slug(adr[2])}`;
  return slug(title);
}

// Every Markdown page under the docs folders, keyed by its path relative to docs/ (posix).
export function collectPages(docsDir = DOCS) {
  const pages = new Map();
  for (const folder of FOLDERS) {
    const dir = folder ? path.join(docsDir, folder) : docsDir;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      const rel = folder ? `${folder}/${file}` : file;
      const md = read(path.join(dir, file));
      const title = h1(md);
      if (!title) throw new Error(`docs/${rel} has no "# " title to name its wiki page by`);
      pages.set(rel, { rel, name: pageName(rel, title), title, md });
    }
  }
  const byName = new Map();
  for (const p of pages.values()) {
    if (byName.has(p.name)) throw new Error(`docs/${byName.get(p.name)} and docs/${p.rel} would both become the wiki page ${p.name}`);
    byName.set(p.name, p.rel);
  }
  return pages;
}

// Where a link found in the page `fromRel` points in the wiki. Same-page anchors and
// absolute addresses stay; a docs page becomes its wiki page; any other repository
// file becomes its GitHub address (pictures from raw.githubusercontent.com so they show).
export function rewriteTarget(target, fromRel, pages, repo = DEFAULT_REPO, warn = () => {}) {
  if (!target || /^(#|[a-z][a-z0-9+.-]*:)/i.test(target)) return target;
  const [file, frag = ""] = target.split(/(?=#)/);
  const rel = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), file));
  if (pages.has(rel)) return pages.get(rel).name + frag;
  const up = rel.match(/^(\.\.\/)+/);
  if (up && up[0].length > 3) {
    warn(`docs/${fromRel}: ${target} points outside the repository`);
    return target;
  }
  const repoPath = up ? rel.slice(3) : `docs/${rel}`;
  if (!existsSync(path.join(ROOT, repoPath))) warn(`docs/${fromRel}: ${target} is not in the repository`);
  const base = IMAGE.test(repoPath) ? `https://raw.githubusercontent.com/${repo}/main` : `https://github.com/${repo}/blob/main`;
  return `${base}/${repoPath}${frag}`;
}

// Rewrites every link and picture outside fenced code blocks.
export function rewriteLinks(md, fromRel, pages, repo, warn) {
  const out = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    out.push(
      fence
        ? line
        : line.replace(/\]\(([^)\s]+)(\s+"[^"]*")?\)/g, (m, target, title = "") => `](${rewriteTarget(target, fromRel, pages, repo, warn)}${title})`),
    );
  }
  return out.join("\n");
}

// A page's wiki text: the wiki shows the page name as its title, so the H1 line goes.
export function pageBody(page, pages, repo, warn) {
  const md = page.md.startsWith("# ") ? page.md.replace(/^# .*\n+/, "") : page.md;
  return `${rewriteLinks(md, page.rel, pages, repo, warn).trimEnd()}\n`;
}

// The sidebar follows docs/README.md: its "## " sections and the first link of each bullet, text only.
export function sidebar(homeMd, pages, repo) {
  const parts = ["**[Home](Home)**"];
  for (const line of homeMd.split("\n")) {
    const section = line.match(/^## (.+)/);
    if (section) parts.push(`\n**${section[1].trim()}**\n`);
    const link = line.match(/^- \[([^\]]+)\]\(([^)\s]+)\)/);
    if (link) parts.push(`- [${link[1]}](${rewriteTarget(link[2], "README.md", pages, repo)})`);
  }
  return `${parts.join("\n")}\n`;
}

export function footer(repo) {
  return `*A copy of the repository's [docs folder](https://github.com/${repo}/tree/main/docs), written by \`scripts/wiki-sync.mjs\` after every change on main. Changes belong there; edits made here are overwritten by the next run.*\n`;
}

// Writes the whole wiki into outDir and removes pages the docs no longer have.
export function generate(outDir, { docsDir = DOCS, repo = DEFAULT_REPO } = {}) {
  const pages = collectPages(docsDir);
  const warnings = [];
  const warn = (w) => warnings.push(w);
  mkdirSync(outDir, { recursive: true });
  const written = new Set();
  const put = (name, text) => {
    writeFileSync(path.join(outDir, `${name}.md`), text);
    written.add(`${name}.md`);
  };
  for (const p of pages.values()) put(p.name, pageBody(p, pages, repo, warn));
  put("_Sidebar", sidebar(pages.get("README.md").md, pages, repo));
  put("_Footer", footer(repo));
  const removed = readdirSync(outDir).filter((f) => f.endsWith(".md") && !written.has(f));
  for (const f of removed) unlinkSync(path.join(outDir, f));
  return { pages: written.size, removed, warnings };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  const args = process.argv.slice(2);
  const outDir = args.find((a) => !a.startsWith("--"));
  const repoAt = args.indexOf("--repo");
  const repo = repoAt >= 0 ? args[repoAt + 1] : process.env.GITHUB_REPOSITORY || DEFAULT_REPO;
  if (!outDir) {
    console.error("usage: node scripts/wiki-sync.mjs <wiki folder> [--repo owner/name]");
    process.exit(2);
  }
  const r = generate(path.resolve(outDir), { repo });
  for (const w of r.warnings) console.warn(`warning: ${w}`);
  console.log(`${r.pages} wiki pages written to ${outDir}${r.removed.length ? `; removed ${r.removed.join(", ")}` : ""}`);
}
