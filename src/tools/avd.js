// Azure Virtual Desktop: session hosts that are down (Unavailable, Needs
// assistance, with the failed health checks), not ready, shut down although
// they take new sessions and nothing starts them, whose agent update failed or
// that were left in drain mode with no heartbeat for a week; host pools with
// no session hosts, pooled pools with no scaling plan (they run all day),
// personal pools with unassigned desktops or without Start VM on Connect;
// application groups no workspace shows (users never see them) and empty
// workspaces. Tenants with no host pool are skipped after one Resource Graph
// query: no findings, and the page says "no Azure Virtual Desktop" there.
// Host pools, application groups, workspaces and scaling plans come from
// Resource Graph; the session hosts from ARM, one list per host pool (capped,
// a few at a time). Reader is enough; nothing is changed.
const store = require("../findingsStore");
const tenants = require("../tenants");
const { resourceGraphQuery, armGet } = require("../armClient");
const { mapLimit, runChecks, itemErrors, scanError, nameOf } = require("./util");

const TOOL_ID = "avd";
const INVENTORY_KEY = "avd/inventory.json";
const API = "2024-04-03";
const CONCURRENCY = 4;
const MAX_HOST_POOLS = 200;
const MAX_PAGES = 20; // session host pages per host pool
const DRAIN_DAYS = 7;
const DAY = 86400000;

const low = (s) => String(s || "").toLowerCase();
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const when = (iso) => String(iso || "").slice(0, 16).replace("T", " ") + " UTC";
// "hp1/vm1.contoso.com" -> "vm1.contoso.com"
const hostName = (name) => String(name || "").split("/").pop();

// Statuses that mean the host is down and needs someone; the rest of the
// not-Available ones mean it cannot take sessions yet. Upgrading is short and left out.
const DOWN = ["unavailable", "needsassistance"];
const PASSING = ["", "available", "upgrading", "shutdown", "upgradefailed"];

/* ---------- shaping ---------- */

// Resource Graph row -> host pool.
function poolOf(r) {
  const p = r.properties || {};
  return {
    id: r.id,
    name: r.name,
    resourceGroup: r.resourceGroup,
    subscriptionId: r.subscriptionId,
    location: r.location || null,
    type: p.hostPoolType || "Pooled",
    assignment: p.personalDesktopAssignmentType || null,
    startOnConnect: p.startVMOnConnect === true,
    loadBalancer: p.loadBalancerType || null,
    maxSessions: p.maxSessionLimit ?? null,
  };
}

// ARM session host -> the fields the checks use.
function hostOf(h, pool) {
  const p = h.properties || {};
  return {
    id: h.id || `${pool.id}/sessionHosts/${hostName(h.name)}`,
    name: hostName(h.name),
    pool: pool.name,
    poolId: pool.id,
    resourceGroup: pool.resourceGroup,
    subscriptionId: pool.subscriptionId,
    status: p.status || "Unknown",
    updateState: p.updateState || null,
    updateError: p.updateErrorMessage || null,
    allowNewSession: p.allowNewSession !== false,
    lastHeartBeat: p.lastHeartBeat || null,
    assignedUser: p.assignedUser || null,
    sessions: Number(p.sessions) || 0,
    osVersion: p.osVersion || null,
    agentVersion: p.agentVersion || null,
    vmId: p.resourceId || null,
    failedChecks: arr(p.sessionHostHealthCheckResults)
      .filter((c) => low(c.healthCheckResult) === "healthcheckfailed")
      .map((c) => {
        const d = c.additionalFailureDetails || {};
        return d.message ? `${c.healthCheckName}: ${String(d.message).slice(0, 160)}` : String(c.healthCheckName || "health check");
      }),
  };
}

// Which host pools have a scaling plan, and whether it is switched on: Map(pool id -> { plan, enabled }).
function scalingByPool(plans) {
  const out = new Map();
  for (const s of plans) {
    for (const ref of arr((s.properties || {}).hostPoolReferences)) {
      if (!ref || !ref.hostPoolArmPath) continue;
      const k = low(ref.hostPoolArmPath);
      const enabled = ref.scalingPlanEnabled !== false;
      const had = out.get(k);
      if (!had || (!had.enabled && enabled)) out.set(k, { plan: s.name, enabled });
    }
  }
  return out;
}

/* ---------- checks (pure, for the tests) ---------- */

// hosts: hostOf() rows; pools: Map(pool id lower -> pool with .scaling).
function hostFindings(hosts, pools, now = Date.now()) {
  const out = [];
  for (const h of hosts) {
    const pool = pools.get(low(h.poolId)) || {};
    const f = (kind, suffix, detail) => out.push({ kind, id: `${h.id}#avd${suffix}`, name: h.name, resourceGroup: h.resourceGroup, subscriptionId: h.subscriptionId, hostPool: h.pool, detail });
    const status = low(h.status);
    const checks = h.failedChecks.length ? `. Failed health checks: ${h.failedChecks.slice(0, 3).join("; ")}${h.failedChecks.length > 3 ? `; and ${h.failedChecks.length - 3} more` : ""}` : "";
    const beat = h.lastHeartBeat ? `; last heartbeat ${when(h.lastHeartBeat)}` : "";
    if (h.allowNewSession) {
      if (DOWN.includes(status)) {
        f("avd-host-unavailable", "", `Session host in ${h.pool} is ${h.status} while it takes new sessions: users sent to it cannot connect${beat}${checks}`);
      } else if (status === "shutdown") {
        const scaled = pool.scaling && pool.scaling.enabled;
        if (!scaled && !pool.startOnConnect) f("avd-host-shutdown", "", `Session host in ${h.pool} is shut down but takes new sessions, and neither a scaling plan nor Start VM on Connect starts it: users cannot reach it until someone starts the VM`);
      } else if (!PASSING.includes(status)) {
        f("avd-host-not-ready", "", `Session host in ${h.pool} reports ${h.status} and cannot take sessions${beat}${checks}`);
      }
    } else {
      const last = Date.parse(h.lastHeartBeat);
      const age = Number.isFinite(last) ? (now - last) / DAY : Infinity;
      if (age > DRAIN_DAYS) {
        f("avd-host-drain-forgotten", "/drain", `Session host in ${h.pool} is in drain mode (no new sessions) and has sent no heartbeat ${h.lastHeartBeat ? `since ${when(h.lastHeartBeat)}` : "at all"}: forgotten in drain mode? Remove it from the host pool or bring it back`);
      }
    }
    if (low(h.updateState) === "failed" || status === "upgradefailed") {
      f("avd-agent-update-failed", "/agent", `The Azure Virtual Desktop agent update failed${h.agentVersion ? ` (agent ${h.agentVersion})` : ""}${h.updateError ? `: ${String(h.updateError).slice(0, 200)}` : ""}. Reinstall the agent or redeploy the host`);
    }
  }
  return out;
}

// pools: pool rows with .scaling, .hosts (hostOf rows) and .checked (session hosts were read).
function poolFindings(pools) {
  const out = [];
  for (const p of pools) {
    const base = { id: `${p.id}#avd`, name: p.name, resourceGroup: p.resourceGroup, subscriptionId: p.subscriptionId, hostPool: p.name };
    const personal = low(p.type) === "personal";
    if (p.checked && !p.hosts.length) {
      out.push({ ...base, kind: "avd-pool-empty", detail: `${p.type} host pool with no session hosts: users assigned to it see nothing to connect to. Add hosts or delete the pool` });
      continue;
    }
    if (!personal && low(p.type) === "pooled") {
      if (!p.scaling) out.push({ ...base, id: `${p.id}#avd/scaling`, kind: "avd-pool-no-scaling", detail: "Pooled host pool with no scaling plan: its session hosts run (and cost) around the clock. Assign a scaling plan to start and stop them by schedule" });
      else if (!p.scaling.enabled) out.push({ ...base, id: `${p.id}#avd/scaling`, kind: "avd-pool-no-scaling", detail: `Scaling plan ${p.scaling.plan} is assigned but switched off for this pool: its session hosts run around the clock` });
    }
    if (personal && p.checked) {
      const free = p.hosts.filter((h) => !h.assignedUser).length;
      if (free) out.push({ ...base, id: `${p.id}#avd/unassigned`, kind: "avd-personal-unassigned", detail: `${plural(free, "personal desktop")} of ${p.hosts.length} assigned to nobody${low(p.assignment) === "automatic" ? " (automatic assignment hands them out at first sign-in)" : ""}; each one costs while it runs` });
    }
    if (personal && !p.startOnConnect) {
      out.push({ ...base, id: `${p.id}#avd/start-on-connect`, kind: "avd-no-start-on-connect", detail: "Personal host pool with Start VM on Connect off: a desktop that was shut down stays unreachable until someone starts it, so they tend to be left running" });
    }
  }
  return out;
}

// groups and workspaces: Resource Graph rows with properties.
function linkFindings(groups, workspaces) {
  const shown = new Set();
  for (const w of workspaces) for (const ref of arr((w.properties || {}).applicationGroupReferences)) shown.add(low(ref));
  const out = [];
  for (const g of groups) {
    const p = g.properties || {};
    if (shown.has(low(g.id)) || p.workspaceArmPath) continue;
    out.push({ kind: "avd-appgroup-no-workspace", id: `${g.id}#avd`, name: g.name, resourceGroup: g.resourceGroup, subscriptionId: g.subscriptionId, hostPool: nameOf(p.hostPoolArmPath) || null, detail: `${p.applicationGroupType || "Application"} application group is in no workspace: the users it is assigned to never see it in their client. Register it in a workspace or delete it` });
  }
  for (const w of workspaces) {
    if (arr((w.properties || {}).applicationGroupReferences).length) continue;
    out.push({ kind: "avd-workspace-empty", id: `${w.id}#avd`, name: w.name, resourceGroup: w.resourceGroup, subscriptionId: w.subscriptionId, detail: "Workspace with no application groups: users who subscribe to it see nothing" });
  }
  return out;
}

/* ---------- reading Azure ---------- */

const q = (query) => resourceGraphQuery(query, { toolId: TOOL_ID });
const byType = (type) => q(`Resources
  | where type =~ '${type}'
  | project id, name, resourceGroup, subscriptionId, location, properties`);

// Every session host of one pool, following nextLink (capped).
async function readHosts(pool) {
  const list = [];
  let url = `https://management.azure.com${pool.id}/sessionHosts?api-version=${API}`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    const data = await armGet(url, TOOL_ID);
    list.push(...arr(data.value));
    url = data.nextLink || null;
  }
  return list.map((h) => hostOf(h, pool));
}

function inventoryOf(pools, groups, workspaces) {
  return pools.map((p) => ({
    id: p.id,
    name: p.name,
    resourceGroup: p.resourceGroup,
    subscriptionId: p.subscriptionId,
    location: p.location,
    type: p.type,
    startOnConnect: p.startOnConnect,
    scalingPlan: p.scaling ? `${p.scaling.plan}${p.scaling.enabled ? "" : " (off)"}` : null,
    checked: p.checked,
    hosts: p.hosts.length,
    available: p.hosts.filter((h) => low(h.status) === "available").length,
    draining: p.hosts.filter((h) => !h.allowNewSession).length,
    sessions: p.hosts.reduce((n, h) => n + h.sessions, 0),
    appGroups: groups.filter((g) => low((g.properties || {}).hostPoolArmPath) === low(p.id)).map((g) => g.name),
    workspaces: [...new Set(workspaces.filter((w) => arr((w.properties || {}).applicationGroupReferences).some((ref) => groups.some((g) => low(g.id) === low(ref) && low((g.properties || {}).hostPoolArmPath) === low(p.id)))).map((w) => w.name))],
  }));
}

async function run() {
  const poolRows = await byType("microsoft.desktopvirtualization/hostpools");
  if (!poolRows.length) {
    await store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), none: true, pools: [] });
    return [];
  }
  const [groups, workspaces, plans] = await Promise.all([
    byType("microsoft.desktopvirtualization/applicationgroups"),
    byType("microsoft.desktopvirtualization/workspaces"),
    byType("microsoft.desktopvirtualization/scalingplans"),
  ]);
  const scaling = scalingByPool(plans);
  const pools = poolRows.map(poolOf).sort((a, b) => a.name.localeCompare(b.name));
  for (const p of pools) {
    p.scaling = scaling.get(low(p.id)) || null;
    p.hosts = [];
    p.checked = false;
  }
  const poolMap = new Map(pools.map((p) => [low(p.id), p]));

  const checks = {
    "Session hosts": async () => {
      const list = pools.slice(0, MAX_HOST_POOLS);
      const failures = await mapLimit(list, CONCURRENCY, async (p) => {
        p.hosts = await readHosts(p);
        p.checked = true;
      });
      const capped = pools.length > MAX_HOST_POOLS
        ? [scanError(TOOL_ID, "host-pool-cap", `${pools.length - MAX_HOST_POOLS} of ${pools.length} host pools not checked`, `Only the first ${MAX_HOST_POOLS} host pools (by name) have their session hosts read in one run`)]
        : [];
      return [
        ...hostFindings(pools.flatMap((p) => p.hosts), poolMap),
        ...poolFindings(pools),
        ...itemErrors(TOOL_ID, "session-hosts", "host pools (session host list)", failures, list.length),
        ...capped,
      ];
    },
    "Application groups and workspaces": async () => linkFindings(groups, workspaces),
  };
  const findings = await runChecks(TOOL_ID, checks);
  await store.putDoc(INVENTORY_KEY, { updatedAt: new Date().toISOString(), none: false, pools: inventoryOf(pools, groups, workspaces) });
  return findings;
}

/* ---------- read routes ---------- */

// Each tenant's host pools from its last scan, and the tenants with no AVD at all.
async function inventory(keys) {
  const out = { updatedAt: null, pools: [], none: [], failures: [] };
  for (const k of keys) {
    let doc;
    try {
      doc = await store.getDoc(INVENTORY_KEY, k);
    } catch (err) {
      out.failures.push({ tenant: k, error: `could not read the host pool list: ${err.message}` });
      continue;
    }
    if (!doc) continue;
    if (doc.updatedAt && (!out.updatedAt || doc.updatedAt > out.updatedAt)) out.updatedAt = doc.updatedAt;
    if (doc.none) {
      out.none.push({ key: k, name: tenants.nameOf(k) });
      continue;
    }
    out.pools.push(...(doc.pools || []).map((p) => ({ ...p, ...(k !== tenants.HOME && { tenant: k }) })));
  }
  return out;
}

function registerRoutes(app, { readKeys, decorate }) {
  app.get("/api/avd", async (req, res) => {
    try {
      const inv = await inventory(readKeys(req));
      await decorate(TOOL_ID, inv.pools);
      res.json(inv);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = {
  id: TOOL_ID,
  label: "Azure Virtual Desktop",
  schedule: "35 6 * * *", // daily at 06:35
  run,
  registerRoutes,
  _test: { poolOf, hostOf, scalingByPool, hostFindings, poolFindings, linkFindings, inventoryOf },
};
