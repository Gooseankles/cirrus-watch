// Weekly trends across the scan tools: for each ISO week (Monday to Sunday,
// UTC), the findings open at the end of the week and how many were found and
// fixed during it. Built from each tenant's run index, so it costs no scans.
// A tenant's first run of a tool counts as the starting point, not as new
// findings. A week without a run keeps the last known count.
const findingsStore = require("./findingsStore");

const DAY = 86400000;

// Monday 00:00 UTC of the week holding this time.
function weekStart(ms) {
  const d = new Date(ms);
  const day = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day);
}

// ISO week label, e.g. 2026-W43.
function isoWeek(ms) {
  const monday = weekStart(ms);
  const year = new Date(monday + 3 * DAY).getUTCFullYear(); // the Thursday decides the year
  const first = weekStart(Date.UTC(year, 0, 4));
  return `${year}-W${String(Math.round((monday - first) / (7 * DAY)) + 1).padStart(2, "0")}`;
}

function weeksBack(count, now = Date.now()) {
  const last = weekStart(now);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const start = last - i * 7 * DAY;
    out.push({ week: isoWeek(start), start: new Date(start).toISOString(), end: new Date(start + 7 * DAY).toISOString() });
  }
  return out;
}

// One tool over these tenants: per week open count, byKind at the end, added and resolved.
async function toolWeeks(toolId, keys, weeks) {
  const open = weeks.map(() => 0);
  const added = weeks.map(() => 0);
  const resolved = weeks.map(() => 0);
  const byKind = weeks.map(() => ({}));
  const known = weeks.map(() => false); // some tenant had run this tool by the end of the week
  let seen = false;
  const indexes = await Promise.all(keys.map((k) => findingsStore.history(toolId, [k])));
  for (const index of indexes) {
    if (!index.length) continue;
    seen = true;
    weeks.forEach((w, i) => {
      let last = null;
      index.forEach((e, n) => {
        if (e.ranAt >= w.end) return;
        last = e;
        if (e.ranAt >= w.start && n > 0) {
          added[i] += e.added || 0;
          resolved[i] += e.resolved || 0;
        }
      });
      if (!last) return;
      known[i] = true;
      open[i] += last.count || 0;
      for (const [kind, c] of Object.entries(last.byKind || {})) byKind[i][kind] = (byKind[i][kind] || 0) + c;
    });
  }
  return seen ? { open, added, resolved, byKind, known } : null;
}

// Run indexes only change when a scan finishes, so a result is kept a few minutes.
const CACHE_MS = 5 * 60000;
const cache = new Map();

async function build(tools, keys, count = 12) {
  const id = `${count}|${keys.join(",")}|${tools.map((t) => t.id).join(",")}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const weeks = weeksBack(count);
  // A few tools at a time (each reads one index per tenant), not one after another.
  const found = new Array(tools.length);
  let next = 0;
  const worker = async () => {
    while (next < tools.length) {
      const i = next++;
      found[i] = await toolWeeks(tools[i].id, keys, weeks);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, tools.length) }, worker));
  const out = tools.map((t, i) => found[i] && { id: t.id, label: t.label, ...found[i] }).filter(Boolean);
  const result = { generatedAt: new Date().toISOString(), weeks, tools: out };
  if (cache.size > 50) cache.clear();
  cache.set(id, { at: Date.now(), result });
  return result;
}

module.exports = { build, isoWeek, weekStart, weeksBack };
