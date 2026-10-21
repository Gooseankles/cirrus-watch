// Monthly report: for each scan, the results as they stood when the month
// began and when it ended (or now, for the current month), what was found and
// fixed in between, and the runs in that month. Accepted and snoozed findings
// are left out of the open counts, by today's acceptance state.
const findingsStore = require("./findingsStore");
const suppressions = require("./suppressions");

const LIST_MAX = 300;

function bounds(month) {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

const justBefore = (iso) => new Date(Date.parse(iso) - 1).toISOString();

function slim(f) {
  const out = { kind: f.kind || null, name: f.name || f.id || null, detail: f.detail || null };
  for (const k of ["subscriptionId", "subscriptionName", "resourceGroup", "tenant", "tenantName", "probe", "firstSeen"]) {
    if (f[k]) out[k] = f[k];
  }
  return out;
}

function byKind(list) {
  const out = {};
  for (const f of list) out[f.kind || "other"] = (out[f.kind || "other"] || 0) + 1;
  return out;
}

// tools: [{ id, label }]; keys: the tenants to cover; decorate(toolId, list)
// adds subscription and tenant names.
async function build(tools, month, keys, decorate) {
  const { start, end } = bounds(month);
  const now = new Date().toISOString();
  const until = end < now ? end : now;
  const out = [];
  for (const tool of tools) {
    const [before, after, history] = await Promise.all([
      findingsStore.stateAt(tool.id, justBefore(start), keys),
      findingsStore.stateAt(tool.id, justBefore(until), keys),
      findingsStore.history(tool.id, keys),
    ]);
    await suppressions.mark(tool.id, [...before.findings, ...after.findings]);
    const openEnd = after.findings.filter((f) => !f.accepted);
    const openStart = before.findings.filter((f) => !f.accepted);
    const { added, resolved } = findingsStore.diff(before.findings, after.findings);
    const shown = [...openEnd.slice(0, LIST_MAX), ...added.slice(0, LIST_MAX), ...resolved.slice(0, LIST_MAX)];
    await decorate(tool.id, shown);
    const runs = history.filter((r) => r.ranAt >= start && r.ranAt < end);
    out.push({
      id: tool.id,
      label: tool.label,
      ranAt: after.ranAt,
      startRanAt: before.ranAt,
      runs: runs.length,
      trend: runs.map((r) => ({ ranAt: r.ranAt, count: r.count })),
      open: openEnd.length,
      openStart: openStart.length,
      openByKind: byKind(openEnd),
      startByKind: byKind(openStart),
      accepted: after.findings.length - openEnd.length,
      openList: openEnd.slice(0, LIST_MAX).map(slim),
      added: { total: added.length, open: added.filter((f) => !f.accepted).length, list: added.slice(0, LIST_MAX).map(slim) },
      resolved: { total: resolved.length, list: resolved.slice(0, LIST_MAX).map(slim) },
    });
  }
  return { month, start, end, until, generatedAt: now, tools: out };
}

module.exports = { build, bounds };
