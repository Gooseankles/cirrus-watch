// Small helpers shared by the scan tools.
const settings = require("../settings");

// A numeric setting, falling back to `def` when blank, not a number or out of range.
function numberSetting(key, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = settings.get(key);
  if (raw === undefined || raw === null || String(raw).trim() === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min && n <= max ? n : def;
}

// Runs fn over items with at most `limit` in flight; per-item errors are
// collected, not thrown: [{ item, message }].
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const failures = [];
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        try {
          await fn(item);
        } catch (err) {
          failures.push({ item, message: String((err && err.message) || err).slice(0, 300) });
        }
      }
    })
  );
  return failures;
}

// Runs named checks side by side. One failing check must not hide the rest:
// it becomes a scan-error finding; if every check failed, the run fails.
async function runChecks(toolId, checks) {
  const names = Object.keys(checks);
  const results = await Promise.allSettled(names.map((n) => checks[n]()));
  const findings = [];
  const failed = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") findings.push(...(r.value || []));
    else failed.push({ name: names[i], message: String((r.reason && r.reason.message) || r.reason).slice(0, 300) });
  });
  if (failed.length === names.length) throw new Error(failed.map((f) => `${f.name}: ${f.message}`).join("; "));
  for (const f of failed) findings.push(scanError(toolId, f.name, `${f.name} check failed`, f.message));
  return findings;
}

function scanError(toolId, key, name, detail, subscriptionId) {
  return { kind: "scan-error", id: `${toolId}/scan-errors/${key}`, name, detail, ...(subscriptionId && { subscriptionId }) };
}

// "x of y items not checked" finding for per-item ARM calls that failed.
function itemErrors(toolId, key, what, failures, total) {
  if (!failures.length) return [];
  const first = failures[0];
  return [scanError(toolId, key, `${failures.length} of ${total} ${what} not checked`, first.message, first.item && first.item.subscriptionId)];
}

const nameOf = (id) => String(id || "").split("/").pop();

const daysUntil = (date, now = Date.now()) => Math.floor((Date.parse(date) - now) / 86400000);

module.exports = { numberSetting, mapLimit, runChecks, scanError, itemErrors, nameOf, daysUntil };
