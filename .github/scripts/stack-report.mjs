// Weekly stack report: every part the dashboard is built on (npm packages, the Node base image, GitHub Actions,
// the Trivy scanner), the version in use, the newest one, and the release notes in between. Writes Markdown to
// stack-report.md (and the job summary); the workflow puts it in one GitHub issue.
// Run by hand: GITHUB_TOKEN=$(gh auth token) node .github/scripts/stack-report.mjs
import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const TOKEN = process.env.GITHUB_TOKEN || "";
const NOTE_CHARS = 1800; // per release, so the issue stays under GitHub's 65,536 limit
const MAX_RELEASES = 6; // newest first, per part

/* --- helpers --- */
async function get(url, { json = true, gh = false } = {}) {
  const headers = { "User-Agent": "azure-ops-dashboard-stack-report" };
  if (gh) {
    headers.Accept = "application/vnd.github+json";
    if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  }
  const r = await fetch(url, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return json ? r.json() : r.text();
}
const ghApi = (path) => get(`https://api.github.com${path}`, { gh: true });
const parse = (v) => {
  const m = String(v || "").match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[\w.]+)?$/);
  return m ? { major: +m[1], minor: +(m[2] || 0), patch: +(m[3] || 0), pre: !!m[4], text: `${m[1]}.${m[2] || 0}.${m[3] || 0}` } : null;
};
const cmp = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;
const day = (s) => (s ? String(s).slice(0, 10) : "");
const repoOf = (url) => {
  const m = String(url || "").match(/github\.com[/:]([^/]+)\/([^/#.]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
};
// The lines that matter most go first: anything that says breaking, removed or deprecated.
function notes(body) {
  const text = String(body || "").replace(/<!--[\s\S]*?-->/g, "").replace(/\r/g, "").trim();
  if (!text) return "_No release notes._";
  // Node's commit lines start with "[`abc123`](link)] - "; test changes are not worth a flag.
  const clean = (l) => l.replace(/^[\s*#>-]+/, "").replace(/^\\?\[\[`\w+`\]\([^)]*\)\\?\]\s*-\s*/, "").trim();
  const flagged = [...new Set(text.split("\n").filter((l) => /breaking|deprecat|removed|drop(ped|s)? support/i.test(l)).map(clean))].filter((l) => !/^\*\*test\*\*/i.test(l)).slice(0, 6);
  const security = /security|vulnerab|cve-\d/i.test(text);
  let out = text.length > NOTE_CHARS ? text.slice(0, NOTE_CHARS).replace(/\n[^\n]*$/, "") + "\n\n_(cut short; full notes behind the link)_" : text;
  // Headings inside the notes would break the issue's own layout.
  out = out.replace(/^#{1,6}\s+(.*?)\s*#*$/gm, "**$1**");
  const head = (security ? "> 🔒 Has security fixes\n" : "") + (flagged.length ? `> ⚠️ ${flagged.join("\n> ⚠️ ")}\n` : "");
  return (head ? head + "\n" : "") + out;
}
// Sections of a CHANGELOG.md for versions newer than `from` and up to `to` (for packages without GitHub releases).
async function changelogBetween(repo, dir, from, to) {
  if (!repo) return [];
  const text = await get(`https://raw.githubusercontent.com/${repo}/HEAD/${dir ? dir + "/" : ""}CHANGELOG.md`, { json: false }).catch(() => null);
  if (!text) return [];
  const out = [];
  const parts = text.split(/^(?=#{1,3}\s.*\d+\.\d+)/m);
  for (const part of parts) {
    const head = part.split("\n")[0];
    const v = parse((head.match(/\d+\.\d+(?:\.\d+)?(?:-[\w.]+)?/) || [])[0]);
    if (!v || v.pre || /unreleased/i.test(head) || out.some((x) => x.version === v.text) || cmp(v, from) <= 0 || cmp(v, to) > 0) continue;
    out.push({ version: v.text, date: (head.match(/\d{4}-\d{2}-\d{2}/) || [""])[0], url: `https://github.com/${repo}/blob/HEAD/${dir ? dir + "/" : ""}CHANGELOG.md`, body: part.split("\n").slice(1).join("\n") });
    if (out.length >= MAX_RELEASES) break;
  }
  return out;
}
function details(title, body) {
  return `<details><summary>${title}</summary>\n\n${body}\n\n</details>\n`;
}
// Releases of a GitHub repo newer than `from` and up to `to`, read from the tag names.
async function releasesBetween(repo, from, to, tagPrefix = "") {
  if (!repo) return [];
  const list = (await ghApi(`/repos/${repo}/releases?per_page=100`).catch(() => null)) || [];
  return list
    .filter((r) => !r.draft && !r.prerelease && (!tagPrefix || r.tag_name.startsWith(tagPrefix)))
    .map((r) => ({ r, v: parse(tagPrefix ? r.tag_name.slice(tagPrefix.length) : r.tag_name) }))
    .filter(({ v }) => v && !v.pre && cmp(v, from) > 0 && (!to || cmp(v, to) <= 0))
    .sort((a, b) => cmp(b.v, a.v))
    .slice(0, MAX_RELEASES)
    .map(({ r, v }) => ({ version: v.text, date: day(r.published_at), url: r.html_url, body: r.body }));
}
const releaseBlock = (rels) => rels.map((x) => details(`${x.version}${x.date ? ` (${x.date})` : ""}`, `[Notes](${x.url})\n\n${notes(x.body)}`)).join("\n");

/* --- npm packages (direct dependencies) --- */
async function npmPart() {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  const rows = [], blocks = [];
  for (const name of Object.keys(pkg.dependencies || {}).sort()) {
    const installed = ((lock.packages || {})[`node_modules/${name}`] || {}).version;
    const meta = await get(`https://registry.npmjs.org/${name.replace("/", "%2f")}`);
    const latest = meta["dist-tags"].latest;
    const cur = parse(installed), lat = parse(latest);
    const behind = Object.keys(meta.versions || {}).map(parse).filter((v) => v && !v.pre && cmp(v, cur) > 0 && cmp(v, lat) <= 0).length;
    const kind = !behind ? "up to date" : lat.major > cur.major ? "**new major**" : lat.minor > cur.minor ? "minor" : "patch";
    rows.push(`| \`${name}\` | ${installed} | ${latest} (${day(meta.time[latest])}) | ${behind ? `${behind} behind, ${kind}` : "✅"} |`);
    if (!behind) continue;
    const repo = repoOf((meta.repository || {}).url);
    const dir = (meta.repository || {}).directory;
    // Monorepos (the Azure SDK) tag as "<package>_<version>".
    let rels = await releasesBetween(repo, cur, lat, dir ? `${name}_` : "");
    if (!rels.length) rels = await changelogBetween(repo, dir, cur, lat);
    const changelog = repo ? `https://github.com/${repo}/blob/HEAD/${dir ? dir + "/" : ""}CHANGELOG.md` : `https://www.npmjs.com/package/${name}?activeTab=versions`;
    blocks.push(`#### \`${name}\` ${installed} → ${latest}\n[Changelog](${changelog}) · [npm](https://www.npmjs.com/package/${name})\n\n${rels.length ? releaseBlock(rels) : "_No GitHub releases with notes; see the changelog._\n"}`);
  }
  // Problems in the whole tree, including packages pulled in by these.
  let audit = "";
  try {
    const out = execSync("npm audit --json --omit=dev", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    audit = summariseAudit(out);
  } catch (e) {
    audit = e.stdout ? summariseAudit(e.stdout) : "npm audit could not run.";
  }
  return {
    outdated: blocks.length,
    md: `### npm packages\n\n| Package | In use | Newest | |\n|---|---|---|---|\n${rows.join("\n")}\n\n${audit}\n\n${blocks.join("\n")}`,
  };
}
function summariseAudit(out) {
  try {
    const v = JSON.parse(out).metadata.vulnerabilities;
    const n = v.critical + v.high + v.moderate + v.low;
    return n ? `⚠️ npm audit: ${v.critical} critical, ${v.high} high, ${v.moderate} moderate, ${v.low} low (run \`npm audit\` for the list).` : "npm audit: no known problems in the whole package tree.";
  } catch {
    return "npm audit gave no readable answer.";
  }
}

/* --- Node base image --- */
async function nodePart() {
  const from = readFileSync("Dockerfile", "utf8").match(/^FROM\s+node:(\d+)([^\s@]*)/m);
  if (!from) return { outdated: 0, md: "### Node base image\n\nNo `FROM node:` line found in the Dockerfile." };
  const major = +from[1];
  const dist = await get("https://nodejs.org/dist/index.json");
  const inMajor = dist.filter((d) => parse(d.version).major === major);
  const newest = inMajor[0];
  const ltsMajors = [...new Set(dist.filter((d) => d.lts).map((d) => parse(d.version).major))].sort((a, b) => b - a);
  const newestLts = ltsMajors[0];
  const ltsSince = newestLts > major ? day(dist.filter((d) => parse(d.version).major === newestLts && d.lts).slice(-1)[0].date) : "";
  // node:<major>-alpine follows the newest <major>.x by itself: these came out in the last five weeks.
  const recent = inMajor.filter((d) => Date.now() - Date.parse(d.date) < 35 * 864e5);
  const rels = [];
  for (const d of recent.slice(0, MAX_RELEASES)) {
    const r = await ghApi(`/repos/nodejs/node/releases/tags/${d.version}`).catch(() => null);
    rels.push({ version: d.version.slice(1), date: d.date, url: r ? r.html_url : `https://nodejs.org/en/blog/release/${d.version}`, body: r ? r.body : d.security ? "Security release." : "" });
  }
  const advice = newestLts > major
    ? `**Node ${newestLts} is LTS (since ${ltsSince}).** The image is on Node ${major}: change both \`FROM node:${major}${from[2]}\` lines in the Dockerfile by hand (Dependabot is told to leave majors alone).`
    : `Node ${major} is the newest LTS. ✅`;
  return {
    outdated: newestLts > major ? 1 : 0,
    md: `### Node base image\n\n\`node:${major}${from[2]}\` → newest ${major}.x is **${newest.version}** (${newest.date}${newest.security ? ", security release" : ""}); every image build takes it by itself. ${advice}\n\n[Node ${major} changelog](https://github.com/nodejs/node/blob/main/doc/changelogs/CHANGELOG_V${major}.md)\n\n${rels.length ? `Releases in the last five weeks:\n\n${releaseBlock(rels)}` : "No Node release in the last five weeks."}`,
  };
}

/* --- GitHub Actions --- */
async function actionsPart() {
  const dir = ".github/workflows";
  const files = execSync(`git ls-files ${dir}`, { encoding: "utf8" }).split("\n").filter((f) => /\.ya?ml$/.test(f));
  const used = new Map();
  for (const f of files) {
    for (const m of readFileSync(f, "utf8").matchAll(/uses:\s*([\w.-]+\/[\w.-]+)(?:\/[\w./-]+)?@([\w.-]+)/g)) {
      const k = `${m[1]}@${m[2]}`;
      if (!used.has(k)) used.set(k, { repo: m[1], ref: m[2], files: new Set() });
      used.get(k).files.add(f.split("/").pop());
    }
  }
  const rows = [], blocks = [];
  for (const u of [...used.values()].sort((a, b) => a.repo.localeCompare(b.repo))) {
    const tags = (await ghApi(`/repos/${u.repo}/tags?per_page=100`)) || [];
    const newest = tags.map((t) => ({ t: t.name, v: parse(t.name) })).filter((x) => /^v?\d+(\.\d+){0,2}$/.test(x.t) && x.v).sort((a, b) => cmp(b.v, a.v))[0];
    const cur = parse(u.ref);
    if (!newest || !cur) {
      rows.push(`| \`${u.repo}\` | ${u.ref} | ? | pinned by sha or no version tags |`);
      continue;
    }
    // A major tag (v4) follows its newest 4.x by itself; only a newer major needs a change.
    const old = newest.v.major > cur.major;
    rows.push(`| \`${u.repo}\` | ${u.ref} | ${newest.t} | ${old ? "**new major**" : "✅"} |`);
    if (!old) continue;
    const rels = await releasesBetween(u.repo, { major: cur.major, minor: 999, patch: 999 }, null);
    blocks.push(`#### \`${u.repo}\` ${u.ref} → ${newest.t} (in ${[...u.files].join(", ")})\n\n${rels.length ? releaseBlock(rels) : `[Releases](https://github.com/${u.repo}/releases)\n`}`);
  }
  return { outdated: blocks.length, md: `### GitHub Actions\n\n| Action | In use | Newest | |\n|---|---|---|---|\n${rows.join("\n")}\n\n${blocks.join("\n")}` };
}

/* --- Trivy (pinned by digest in docker.yml, so Dependabot cannot see it) --- */
async function trivyPart() {
  const f = ".github/workflows/docker.yml";
  const text = existsSync(f) ? readFileSync(f, "utf8") : "";
  const pinned = (text.match(/pinned by digest \(([\d.]+)\)/) || [])[1];
  if (!pinned) return { outdated: 0, md: "### Trivy scanner\n\nNo pinned Trivy version found in docker.yml." };
  const latest = await ghApi("/repos/aquasecurity/trivy/releases/latest");
  const lat = parse(latest.tag_name), cur = parse(pinned);
  if (cmp(lat, cur) <= 0) return { outdated: 0, md: `### Trivy scanner\n\nPinned ${pinned} is the newest. ✅` };
  const tag = await get(`https://hub.docker.com/v2/repositories/aquasec/trivy/tags/${lat.text}`).catch(() => null);
  const digest = tag && tag.digest;
  const rels = await releasesBetween("aquasecurity/trivy", cur, lat);
  return {
    outdated: 1,
    md: `### Trivy scanner\n\nPinned **${pinned}**, newest **${lat.text}** (${day(latest.published_at)}). Update by hand in docker.yml: the \`TRIVY\` digest${digest ? ` → \`aquasec/trivy@${digest}\`` : ""} and the version in its comment. Check the release came from Aqua (signed, announced) before moving the pin.\n\n${releaseBlock(rels)}`,
  };
}

/* --- compliance frameworks (the mapping in public/compliance.js) --- */
// Each framework's live version is compared with the one the mapping was reviewed against (.github/frameworks.json).
async function eurLexVersions(celex) {
  // Consolidated versions share the CELEX number with a leading 0 and a date: 02022L2555-20221227.
  const q = `PREFIX cdm: <http://publications.europa.eu/ontology/cdm#> SELECT DISTINCT ?celex WHERE { ?w cdm:resource_legal_id_celex ?celex . FILTER(STRSTARTS(STR(?celex), "0${celex.slice(1)}")) }`;
  const r = await fetch(`https://publications.europa.eu/webapi/rdf/sparql?query=${encodeURIComponent(q)}`, { headers: { Accept: "application/sparql-results+json" } });
  if (!r.ok) throw new Error(`EUR-Lex: ${r.status}`);
  return (await r.json()).results.bindings.map((b) => b.celex.value).sort();
}
const consolidated = (list) => `${list.length} version${list.length > 1 ? "s" : ""}, newest ${list[list.length - 1].replace(/^.*-(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3")}`;
async function frameworksPart() {
  const f = ".github/frameworks.json";
  if (!existsSync(f)) return { outdated: 0, md: "### Compliance frameworks\n\nNo .github/frameworks.json." };
  const rows = [], changed = [];
  for (const w of JSON.parse(readFileSync(f, "utf8")).watch) {
    const shown = (v) => (Array.isArray(v) ? consolidated(v) : v);
    let now;
    try {
      if (w.celex) {
        now = await eurLexVersions(w.celex);
        if (!now.length) throw new Error("no versions listed");
      } else {
        const page = await get(w.url, { json: false });
        if (!page) throw new Error("page not found");
        const found = [...page.matchAll(new RegExp(w.pattern, "gi"))].map((m) => m[1]);
        // The pattern stopped matching: the page changed, so the watch itself needs a look.
        if (!found.length) throw new Error(`the page no longer names the version (pattern ${w.pattern})`);
        now = found.sort((a, b) => cmp(parse(b), parse(a)))[0];
      }
    } catch (e) {
      rows.push(`| [${w.name}](${w.link}) | ${shown(w.reviewed)} | ⚠️ could not check: ${e.message} | |`);
      changed.push(w);
      continue;
    }
    const same = Array.isArray(now) ? now.join() === [...w.reviewed].sort().join() : now === w.reviewed;
    rows.push(`| [${w.name}](${w.link}) | ${shown(w.reviewed)} | ${shown(now)} | ${same ? "✅" : "**changed: review the mapping**"} |`);
    if (!same) changed.push(w);
  }
  const advice = changed.length
    ? `**Look at: ${changed.map((w) => w.name).join(", ")}.** Check \`public/compliance.js\` (the controls, the groups each kind of finding maps to, the \`FRAMEWORKS\` labels) against the new text, then set \`FRAMEWORK_INFO\` there and \`reviewed\` in \`.github/frameworks.json\` to what you checked. If a check could not run, fix its entry in that file.`
    : "The mapping follows the current text of every framework. ✅";
  return {
    outdated: changed.length,
    md: `### Compliance frameworks\n\nWhat the Compliance page maps findings to, compared with the text the mapping was last reviewed against (\`.github/frameworks.json\`).\n\n| Framework | Reviewed against | Now | |\n|---|---|---|---|\n${rows.join("\n")}\n\n${advice}`,
  };
}

/* --- the report --- */
const parts = [];
for (const [name, fn] of [["npm", npmPart], ["node", nodePart], ["actions", actionsPart], ["trivy", trivyPart], ["frameworks", frameworksPart]]) {
  try {
    parts.push(await fn());
  } catch (e) {
    parts.push({ outdated: 0, md: `### ${name}\n\n⚠️ Could not check: ${e.message}` });
  }
}
const outdated = parts.reduce((n, p) => n + p.outdated, 0);
let md = `## Stack report ${new Date().toISOString().slice(0, 10)}\n\n${outdated ? `**${outdated} part${outdated > 1 ? "s" : ""} can be updated.** Patch and minor npm updates, Docker and Actions also come as Dependabot pull requests; new majors of Node and Trivy, and framework mappings, are changed by hand.` : "Everything is up to date. ✅"}\n\n${parts.map((p) => p.md).join("\n\n---\n\n")}\n`;
if (md.length > 64000) md = md.slice(0, 63800) + "\n\n_(Report cut short: GitHub issues hold 65,536 characters. Run the workflow log or the script for the rest.)_\n";
writeFileSync("stack-report.md", md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `outdated=${outdated}\n`);
console.log(`stack report: ${outdated} part(s) can be updated`);
