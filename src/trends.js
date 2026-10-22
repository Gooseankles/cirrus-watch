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
  for (const k of keys) {
    const index = await findingsStore.history(toolId, [k]);
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

async function build(tools, keys, count = 12) {
  const weeks = weeksBack(count);
  const out = [];
  for (const t of tools) {
    const w = await toolWeeks(t.id, keys, weeks);
    if (w) out.push({ id: t.id, label: t.label, ...w });
  }
  return { generatedAt: new Date().toISOString(), weeks, tools: out };
}

module.exports = { build, isoWeek, weekStart, weeksBack };
