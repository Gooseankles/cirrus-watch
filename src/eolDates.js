// End-of-support dates from endoflife.date (a free, community-kept API), so a
// new Node, Python or Ubuntu version is known without a code change. Fetched
// at most once a day and kept in DATA_DIR/eol-dates.json; when the API cannot
// be reached the last copy is used, and without one the built-in tables in
// tools/endOfSupport.js. EOS_LIVE_DATES = off uses only the built-in tables.
const fs = require("fs");
const path = require("path");
const settings = require("./settings");
const { DATA_DIR } = require("./paths");
const { writeAtomic } = require("./jsonFile");

const API = "https://endoflife.date/api/v1/products/";
const FILE = path.join(DATA_DIR, "eol-dates.json");
const TTL_MS = 24 * 3600 * 1000;
// Our name -> endoflife.date product. Their eolFrom is the date we flag:
// end of extended support for Windows Server, end of standard support for
// Ubuntu and the language runtimes, end of maintenance for RHEL.
const PRODUCTS = {
  node: "nodejs",
  python: "python",
  dotnet: "dotnet",
  php: "php",
  windows: "windows-server",
  ubuntu: "ubuntu",
  debian: "debian",
  rhel: "rhel",
  sles: "sles",
  centos: "centos",
};

const enabled = () => !/^(off|no|false|0)$/i.test(String(settings.get("EOS_LIVE_DATES") || "").trim());

// { name: eolFrom } for one product's releases that have an end date.
function datesOf(product) {
  const out = {};
  for (const r of (product && product.releases) || []) {
    if (r && r.name && /^\d{4}-\d{2}-\d{2}$/.test(String(r.eolFrom || ""))) out[String(r.name).toLowerCase()] = r.eolFrom;
  }
  return out;
}

async function fetchAll() {
  const tables = {};
  const failed = [];
  await Promise.all(
    Object.entries(PRODUCTS).map(async ([key, product]) => {
      try {
        const res = await fetch(API + product, { signal: AbortSignal.timeout(10000), headers: { Accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const dates = datesOf((await res.json()).result);
        if (Object.keys(dates).length) tables[key] = dates;
        else failed.push(product);
      } catch (err) {
        failed.push(`${product} (${err.message})`);
      }
    })
  );
  return { tables, failed };
}

function readKept() {
  try {
    const kept = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return kept && kept.tables ? kept : null;
  } catch {
    return null;
  }
}

let pending = null;

// { tables: { node: { "24": "2028-04-30", ... }, ... }, source, fetchedAt, note }
// source: "endoflife.date", "kept copy" or "built-in" (tables empty).
async function load() {
  if (!enabled()) return { tables: {}, source: "built-in", fetchedAt: null, note: "live dates turned off (EOS_LIVE_DATES)" };
  const kept = readKept();
  if (kept && Date.now() - Date.parse(kept.fetchedAt) < TTL_MS) return { ...kept, source: "endoflife.date" };
  if (!pending) {
    pending = fetchAll().finally(() => {
      pending = null;
    });
  }
  const { tables, failed } = await pending;
  if (Object.keys(tables).length) {
    // A product that failed this time keeps its last known dates.
    const merged = { ...((kept && kept.tables) || {}), ...tables };
    const result = { tables: merged, fetchedAt: new Date().toISOString() };
    try {
      writeAtomic(FILE, result);
    } catch {
      // still usable for this run
    }
    return { ...result, source: "endoflife.date", note: failed.length ? `not fetched: ${failed.join(", ")}` : "" };
  }
  if (kept) return { ...kept, source: "kept copy", note: `endoflife.date unreachable; using dates fetched ${kept.fetchedAt.slice(0, 10)}` };
  return { tables: {}, source: "built-in", fetchedAt: null, note: `endoflife.date unreachable (${failed[0] || "no data"}); using built-in dates` };
}

module.exports = { load, PRODUCTS, _test: { datesOf } };
