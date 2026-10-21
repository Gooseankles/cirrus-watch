// Findings someone has accepted (a known, wanted state) or snoozed until a
// date. They stay in the scan results but no longer count as open. Kept per
// tenant, in that tenant's own store, as suppressions/<tool>.json:
//   { "<finding key>": { reason, until, by, at, kind, name } }
// until null = accepted until someone takes it back; a date = snoozed, and the
// finding counts as open again from that day.
const findingsStore = require("./findingsStore");

const HOME = findingsStore.HOME;
const docKey = (toolId) => `suppressions/${toolId}.json`;
const isActive = (s, now = Date.now()) => Boolean(s) && (!s.until || Date.parse(s.until) > now);

async function load(toolId, tenantKey) {
  const doc = await findingsStore.getDoc(docKey(toolId), tenantKey || HOME).catch(() => null);
  return doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
}

// Adds `key` to every finding and `accepted` to those with an active entry.
// Returns how many were marked.
async function mark(toolId, findings) {
  const byTenant = new Map();
  for (const f of findings) {
    f.key = findingsStore.findingKey(f);
    const k = findingsStore.tenantOf(f);
    if (!byTenant.has(k)) byTenant.set(k, []);
    byTenant.get(k).push(f);
  }
  const now = Date.now();
  let n = 0;
  await Promise.all(
    [...byTenant].map(async ([k, list]) => {
      const doc = await load(toolId, k);
      for (const f of list) {
        const s = doc[f.key];
        if (!isActive(s, now)) continue;
        f.accepted = { reason: s.reason, until: s.until || null, by: s.by || null, at: s.at || null };
        n++;
      }
    })
  );
  return n;
}

// One change at a time per tool and tenant.
const locks = new Map();
function withLock(id, fn) {
  const next = (locks.get(id) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(id, next);
  return next;
}

// Expired snoozes are dropped whenever the file is written.
function prune(doc) {
  const now = Date.now();
  for (const [k, s] of Object.entries(doc)) if (!isActive(s, now)) delete doc[k];
  return doc;
}

async function set(toolId, tenantKey, key, entry) {
  const k = tenantKey || HOME;
  return withLock(`${toolId}|${k}`, async () => {
    const doc = prune(await load(toolId, k));
    doc[key] = entry;
    await findingsStore.putDoc(docKey(toolId), doc, k);
  });
}

async function remove(toolId, tenantKey, key) {
  const k = tenantKey || HOME;
  return withLock(`${toolId}|${k}`, async () => {
    const doc = prune(await load(toolId, k));
    const had = doc[key] || null;
    delete doc[key];
    await findingsStore.putDoc(docKey(toolId), doc, k);
    return had;
  });
}

module.exports = { mark, set, remove, load, isActive };
