// Watches the dashboard's own load: CPU and memory of the instance it runs on
// (the App Service plan's machine), the Node process itself (memory, heap,
// event-loop delay) and which scans were running at the time. Samples every
// 15 seconds, keeps one point a minute (the worst of its samples) for 48 hours
// and the peaks of the last scan runs, saved under DATA_DIR so a restart keeps
// them. Crossing a limit raises an alarm: an error line in the run log (the
// Activity panel) and a red mark on the Server load page; it clears when the
// load is back down.
const fs = require("fs");
const os = require("os");
const path = require("path");
const v8 = require("v8");
const { monitorEventLoopDelay } = require("perf_hooks");
const { DATA_DIR } = require("./paths");
const log = require("./log");
const { numberSetting } = require("./tools/util");

const TOOL = "server-load";
const SAMPLE_MS = 15000;
const POINT_MS = 60000;
const KEEP_MS = 48 * 3600000;
const MAX_RUNS = 300;
const SAVE_EVERY = 5; // points
const FILE = path.join(DATA_DIR, "monitor.json");
const CPU_MINUTES = 5; // CPU must stay high this long before it alarms

const running = new Map(); // tool id -> { startedAt, tenants, peak }
let points = [];
let runs = [];
let starts = [];
let current = null; // the minute being filled
let alarms = {}; // key -> { since, message, value }
let cpuHighSince = null;
let lastCpu = null;
let lastHost = null;
let timer = null;
let lastSample = null;
const startedAt = new Date().toISOString();
const lag = monitorEventLoopDelay({ resolution: 20 });

// --- readings ---

function hostTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

// The container's memory limit when it has one (cgroup v2, then v1).
function readNumber(file) {
  try {
    const v = fs.readFileSync(file, "utf8").trim();
    return /^\d+$/.test(v) ? Number(v) : null;
  } catch {
    return null;
  }
}
function containerLimit() {
  const v = readNumber("/sys/fs/cgroup/memory.max") ?? readNumber("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  return v && v < os.totalmem() ? v : null;
}

const mb = (b) => Math.round(b / 1048576);
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

function sample() {
  const now = Date.now();
  const cpu = process.cpuUsage();
  const host = hostTimes();
  let procCpu = null;
  let hostCpu = null;
  if (lastCpu) {
    const used = cpu.user - lastCpu.cpu.user + (cpu.system - lastCpu.cpu.system); // microseconds
    procCpu = pct(used / 1000, now - lastCpu.at); // % of one core: Node runs scans on one
  }
  if (lastHost && host.total > lastHost.total) hostCpu = Math.round((1 - (host.idle - lastHost.idle) / (host.total - lastHost.total)) * 1000) / 10;
  lastCpu = { cpu, at: now };
  lastHost = host;
  const mem = process.memoryUsage();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  const limit = containerLimit();
  const s = {
    t: now,
    hostCpu,
    procCpu,
    hostMem: pct(os.totalmem() - os.freemem(), os.totalmem()),
    rss: mb(mem.rss),
    heap: mb(mem.heapUsed),
    heapPct: pct(mem.heapUsed, heapLimit),
    rssPct: limit ? pct(mem.rss, limit) : null,
    lag: Math.round(lag.max / 1e6),
    scans: [...running.keys()],
  };
  lag.reset();
  return s;
}

// --- points: the worst of each minute ---

const WORST = ["hostCpu", "procCpu", "hostMem", "rss", "heap", "heapPct", "rssPct", "lag"];
function addToPoint(s) {
  const minute = Math.floor(s.t / POINT_MS) * POINT_MS;
  if (current && current.t !== minute) {
    points.push(current);
    const cut = Date.now() - KEEP_MS;
    while (points.length && points[0].t < cut) points.shift();
    if (points.length % SAVE_EVERY === 0) save();
    current = null;
  }
  if (!current) {
    current = { t: minute, scans: [] };
    for (const k of WORST) current[k] = null;
  }
  for (const k of WORST) if (s[k] != null && (current[k] == null || s[k] > current[k])) current[k] = s[k];
  for (const id of s.scans) if (!current.scans.includes(id)) current.scans.push(id);
}

// --- scan runs ---

function peakOf(p, s) {
  for (const k of ["hostCpu", "procCpu", "hostMem", "rss", "heapPct", "lag"]) if (s[k] != null && (p[k] == null || s[k] > p[k])) p[k] = s[k];
}

function scanStarted(id, tenantKeys = []) {
  const prev = running.get(id);
  if (prev) {
    prev.depth += 1;
    return;
  }
  running.set(id, { startedAt: Date.now(), tenants: tenantKeys, depth: 1, peak: {}, startRss: mb(process.memoryUsage().rss) });
}

function scanEnded(id, { ok = true } = {}) {
  const r = running.get(id);
  if (!r) return;
  if (--r.depth > 0) return;
  const s = sample();
  peakOf(r.peak, s);
  addToPoint(s);
  running.delete(id);
  runs.push({ tool: id, start: new Date(r.startedAt).toISOString(), seconds: Math.round((Date.now() - r.startedAt) / 1000), ok, startRss: r.startRss, others: [...running.keys()], ...r.peak });
  if (runs.length > MAX_RUNS) runs = runs.slice(-MAX_RUNS);
}

// --- alarms ---

function limits() {
  return {
    cpu: numberSetting("MONITOR_CPU_WARN_PCT", 90, { min: 10, max: 100 }),
    memory: numberSetting("MONITOR_MEMORY_WARN_PCT", 85, { min: 10, max: 100 }),
    lagMs: numberSetting("MONITOR_LAG_WARN_MS", 2000, { min: 100, max: 60000 }),
  };
}

// Scan names for the log lines (server.js hands them over once the tools are registered).
let labels = { "cost-history": "Cost history" };
const setLabels = (map) => (labels = { ...labels, ...map });
const names = (ids) => ids.map((id) => labels[id] || id).join(", ");
const scanText = (ids) => (ids.length ? ` while running ${names(ids)}` : " with no scan running");

function check(s, lim = limits()) {
  const want = {};
  if (s.hostCpu != null && s.hostCpu >= lim.cpu) {
    cpuHighSince = cpuHighSince || s.t;
    if (s.t - cpuHighSince >= CPU_MINUTES * 60000) want.cpu = { value: s.hostCpu, message: `CPU of the instance at ${Math.round(s.hostCpu)}% for over ${CPU_MINUTES} minutes` };
  } else if (s.hostCpu != null && s.hostCpu < lim.cpu - 10) {
    cpuHighSince = null;
  } else if (alarms.cpu) {
    want.cpu = alarms.cpu; // between the two levels: stays as it was
  }
  const memHigh = (v, off) => v != null && v >= lim.memory - off;
  for (const [key, v, what] of [
    ["memory", s.hostMem, "Memory of the instance"],
    ["container", s.rssPct, "Memory of the dashboard's container"],
    ["heap", s.heapPct, "The dashboard's JavaScript heap"],
  ]) {
    if (memHigh(v, 0) || (alarms[key] && memHigh(v, 5))) want[key] = { value: v, message: `${what} at ${Math.round(v)}%${key === "heap" ? " of its limit (it crashes at 100%)" : ""}` };
  }
  if (s.lag >= lim.lagMs || (alarms.lag && s.lag >= lim.lagMs / 2)) want.lag = { value: s.lag, message: `The dashboard stopped answering for up to ${(s.lag / 1000).toFixed(1)} s (busy event loop)` };

  for (const [key, a] of Object.entries(want)) {
    if (!alarms[key]) {
      alarms[key] = { since: new Date(s.t).toISOString(), message: a.message, value: a.value, scans: s.scans };
      log.record({ tool: TOOL, level: "error", message: `${a.message}${scanText(s.scans)}` });
    } else {
      alarms[key].value = a.value;
      for (const id of s.scans) if (!alarms[key].scans.includes(id)) alarms[key].scans.push(id);
    }
  }
  for (const key of Object.keys(alarms)) {
    if (want[key]) continue;
    const a = alarms[key];
    delete alarms[key];
    const mins = Math.max(1, Math.round((s.t - Date.parse(a.since)) / 60000));
    log.record({ tool: TOOL, level: "success", message: `Back to normal after ${mins} min: ${a.message.replace(/ at \d+%.*$/, "")}${a.scans.length ? ` (scans then: ${names(a.scans)})` : ""}` });
  }
}

function tick() {
  try {
    const s = sample();
    lastSample = s;
    for (const r of running.values()) peakOf(r.peak, s);
    addToPoint(s);
    check(s);
  } catch (err) {
    console.error(`Server load: ${err.message}`);
  }
}

// --- keeping it over restarts ---

function save(clean = false) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ savedAt: Date.now(), clean, points: current ? [...points, current] : points, runs, starts }));
  } catch (err) {
    console.error(`Server load: could not save: ${err.message}`);
  }
}

function load() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const cut = Date.now() - KEEP_MS;
    points = (d.points || []).filter((p) => p.t >= cut);
    runs = (d.runs || []).slice(-MAX_RUNS);
    starts = (d.starts || []).filter((x) => Date.parse(x.at) >= cut);
    // Not shut down cleanly: it crashed or was killed (often out of memory).
    const last = points[points.length - 1];
    starts.push({ at: startedAt, previousStop: d.savedAt ? new Date(Math.max(d.savedAt, last ? last.t : 0)).toISOString() : null, clean: Boolean(d.clean), lastPoint: last || null });
    if (!d.clean) {
      log.record({ tool: TOOL, level: "error", message: `The dashboard restarted without a clean stop${last ? ` (last reading: memory ${Math.round(last.hostMem)}%, heap ${Math.round(last.heapPct)}%${last.scans.length ? `, running ${names(last.scans)}` : ""})` : ""}` });
    }
  } catch {
    starts.push({ at: startedAt, previousStop: null, clean: true, lastPoint: null });
  }
}

function start() {
  if (timer) return;
  load();
  lag.enable();
  sample(); // first CPU reading
  timer = setInterval(tick, SAMPLE_MS);
  timer.unref();
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.once(sig, () => {
      save(true);
      process.exit(0);
    });
  }
}

function snapshot() {
  return {
    startedAt,
    sampleSeconds: SAMPLE_MS / 1000,
    host: { cpus: os.cpus().length, memoryMb: mb(os.totalmem()), containerLimitMb: containerLimit() ? mb(containerLimit()) : null, heapLimitMb: mb(v8.getHeapStatistics().heap_size_limit), node: process.version },
    limits: limits(),
    now: lastSample,
    running: [...running.entries()].map(([id, r]) => ({ tool: id, startedAt: new Date(r.startedAt).toISOString(), tenants: r.tenants })),
    alarms: Object.entries(alarms).map(([key, a]) => ({ key, ...a })),
    points: current ? [...points, current] : points,
    runs: [...runs].reverse(),
    starts: [...starts].reverse(),
  };
}

module.exports = { start, setLabels, scanStarted, scanEnded, snapshot, TOOL, _test: { check, addToPoint, reset: () => { points = []; runs = []; alarms = {}; current = null; cpuHighSince = null; running.clear(); }, state: () => ({ points, runs, alarms, current }) } };
