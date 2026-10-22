"use strict";
/* Server load page (Admin): the dashboard's own App Service instance. CPU and memory over the last hours with
   the scans that ran at the time, alarms that are on, the heaviest scan runs and restarts. GET /api/monitor.
   Uses esc(), fmt, statTile, tableHtml, apiJson, icon, setStatus, state and Charts from app.js. */
const ServerLoad = (() => {
  const st = { data: null, error: null, built: false, hours: 6, timer: null };
  const RANGES = [[1, "1 hour"], [6, "6 hours"], [24, "24 hours"], [48, "48 hours"]];
  const pctText = (v) => (v == null ? "–" : `${Math.round(v)}%`);
  const label = (id) => (st.data && st.data.labels[id]) || id;
  const time = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const dur = (s) => (s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min ${s % 60 ? `${s % 60} s` : ""}` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

  async function load() {
    try {
      st.data = await apiJson("/api/monitor");
      st.error = null;
    } catch (err) {
      st.error = err.message;
    }
    if (state.route === "load") render();
  }

  function show() {
    const page = $("#page-load");
    if (!st.built) {
      page.innerHTML = `
        <div class="page-head">
          <div><h1>Server load</h1><p class="page-sub">How hard the dashboard's own App Service works: CPU and memory of the instance it runs on, the dashboard's own memory and how quickly it answers, with the scans that were running at the time. An alarm goes to Recent activity when a limit is crossed (Settings, Server load). Only admins see this.</p></div>
          <div class="page-actions"><div class="seg" id="sl-range">${RANGES.map(([h, l]) => `<button type="button" data-h="${h}">${l}</button>`).join("")}</div><button class="btn" id="sl-refresh">${icon("refresh")} Refresh</button></div>
        </div>
        <div class="status-msg" id="sl-status"></div>
        <div id="sl-alarms"></div>
        <div class="stat-row" id="sl-stats"></div>
        <div class="sl-grid">
          <div class="card"><div class="card-head"><h2>CPU of the instance</h2><span class="meta" id="sl-cpu-meta"></span></div><div class="chart sl-chart" id="sl-cpu"></div></div>
          <div class="card"><div class="card-head"><h2>Memory of the instance</h2><span class="meta" id="sl-mem-meta"></span></div><div class="chart sl-chart" id="sl-mem"></div></div>
        </div>
        <div class="card"><div class="card-head"><h2>Scans in this window</h2><span class="meta">each bar is one run; hover for its peaks</span></div><div id="sl-lanes"></div></div>
        <div class="card"><div class="card-head"><h2>Scan runs <span class="meta">newest first, with the highest load seen while each ran</span></h2></div><div id="sl-runs"></div></div>
        <div class="card"><div class="card-head"><h2>Restarts <span class="meta">last 48 hours</span></h2></div><div id="sl-starts"></div></div>`;
      $("#sl-refresh").addEventListener("click", load);
      $("#sl-range").addEventListener("click", (e) => {
        const b = e.target.closest("[data-h]");
        if (!b) return;
        st.hours = Number(b.dataset.h);
        render();
      });
      st.built = true;
    }
    render();
    load();
    // Keep it live while the page is open.
    clearInterval(st.timer);
    st.timer = setInterval(() => (state.route === "load" ? load() : clearInterval(st.timer)), 30000);
  }

  function alarmsHtml(d) {
    if (!d.alarms.length) return "";
    return `<div class="sl-alarm">${icon("alert")}<div>${d.alarms
      .map((a) => `<div><b>${esc(a.message)}</b> <span class="muted">since ${esc(time(a.since))}${a.scans.length ? ` · scans: ${esc(a.scans.map(label).join(", "))}` : ""}</span></div>`)
      .join("")}</div></div>`;
  }

  function lanes(d, from, to) {
    const runs = d.runs.filter((r) => Date.parse(r.start) + r.seconds * 1000 >= from);
    const live = d.running.map((r) => ({ tool: r.tool, start: r.startedAt, seconds: Math.round((to - Date.parse(r.startedAt)) / 1000), live: true }));
    const all = [...runs, ...live];
    if (!all.length) return `<div class="empty-state">No scan ran in this window.</div>`;
    const tools = [...new Set(all.map((r) => r.tool))].sort((a, b) => label(a).localeCompare(label(b)));
    const span = to - from;
    const pos = (t) => Math.max(0, Math.min(100, ((t - from) / span) * 100));
    const rows = tools.map((id) => {
      const bars = all
        .filter((r) => r.tool === id)
        .map((r) => {
          const s = Date.parse(r.start);
          const left = pos(s);
          const width = Math.max(0.4, pos(s + r.seconds * 1000) - left);
          const hot = (r.hostCpu || 0) >= d.limits.cpu || (r.hostMem || 0) >= d.limits.memory || (r.heapPct || 0) >= d.limits.memory;
          const tip = r.live
            ? `${label(id)}: running since ${time(s)}`
            : `${label(id)} ${time(s)}, ${dur(r.seconds)}${r.ok === false ? " (failed)" : ""} · CPU up to ${pctText(r.hostCpu)}, memory up to ${pctText(r.hostMem)}, dashboard ${r.rss != null ? `${r.rss} MB` : "–"}`;
          return `<span class="sl-bar${r.live ? " live" : ""}${hot ? " hot" : ""}${r.ok === false ? " failed" : ""}" style="left:${left.toFixed(2)}%;width:${width.toFixed(2)}%" title="${esc(tip)}"></span>`;
        })
        .join("");
      return `<div class="sl-lane"><span class="sl-name">${esc(label(id))}</span><span class="sl-track">${bars}</span></div>`;
    });
    const ticks = Array.from({ length: 5 }, (_, i) => from + (span * i) / 4).map((t, i) => `<span style="left:${i * 25}%">${esc(time(t))}</span>`).join("");
    return `<div class="sl-lanes">${rows.join("")}<div class="sl-lane sl-axis"><span class="sl-name"></span><span class="sl-track">${ticks}</span></div></div>`;
  }

  function render() {
    setStatus($("#sl-status"), st.error ? `Could not load the server load: ${st.error}` : "", "error");
    $$("#sl-range [data-h]").forEach((b) => b.classList.toggle("active", Number(b.dataset.h) === st.hours));
    const d = st.data;
    if (!d) return;
    const to = Date.now();
    const from = to - st.hours * 3600000;
    const pts = d.points.filter((p) => p.t >= from);
    // Right after a start there is no fresh reading yet: show the newest stored one.
    const n = d.now || d.points[d.points.length - 1] || {};
    const h = d.host;
    $("#sl-alarms").innerHTML = alarmsHtml(d);
    const peak = (k) => pts.reduce((m, p) => (p[k] != null && p[k] > m ? p[k] : m), 0);
    $("#sl-stats").innerHTML = [
      statTile({ label: "CPU now", value: pctText(n.hostCpu), delta: `${h.cpus} core${h.cpus === 1 ? "" : "s"} · peak ${pctText(peak("hostCpu"))} in ${st.hours} h`, deltaCls: (n.hostCpu || 0) >= d.limits.cpu ? "bad" : "" }),
      statTile({ label: "Memory now", value: pctText(n.hostMem), delta: `of ${fmt.int(h.memoryMb)} MB · peak ${pctText(peak("hostMem"))}`, deltaCls: (n.hostMem || 0) >= d.limits.memory ? "bad" : "" }),
      statTile({ label: "Dashboard memory", value: n.rss != null ? `${fmt.int(n.rss)} MB` : "–", delta: `heap ${pctText(n.heapPct)} of ${fmt.int(h.heapLimitMb)} MB${h.containerLimitMb ? ` · limit ${fmt.int(h.containerLimitMb)} MB` : ""}`, deltaCls: (n.heapPct || 0) >= d.limits.memory ? "bad" : "" }),
      statTile({ label: "Slowest answer", value: `${fmt.int(peak("lag"))} ms`, delta: `event-loop delay, ${st.hours} h` }),
      statTile({ label: "Running now", value: fmt.int(d.running.length), delta: d.running.length ? d.running.map((r) => label(r.tool)).join(", ") : `up ${fmt.rel(d.startedAt).replace(/ ago$/, "")}` }),
    ].join("");
    const tip = (key, what) => (p) => ({
      title: fmt.dateTime(new Date(p.t).toISOString()),
      rows: [
        { label: what, value: pctText(p[key]) },
        ...(key === "hostMem" ? [{ label: "Dashboard", value: p.rss != null ? `${fmt.int(p.rss)} MB` : "–" }, { label: "Heap", value: pctText(p.heapPct) }] : [{ label: "Dashboard process", value: p.procCpu != null ? `${Math.round(p.procCpu)}% of a core` : "–" }]),
        { label: "Scans", value: p.scans.length ? p.scans.map(label).join(", ") : "none" },
      ],
    });
    const series = (key) => pts.map((p) => ({ ...p, label: time(p.t), value: p[key] || 0 }));
    $("#sl-cpu-meta").textContent = `alarm at ${d.limits.cpu}% for 5 min · worst of each minute`;
    $("#sl-mem-meta").textContent = `alarm at ${d.limits.memory}% · worst of each minute`;
    Charts.line($("#sl-cpu"), { points: series("hostCpu"), yFormat: (v) => `${v}%`, emptyText: "No readings in this window yet (one a minute)", tooltip: tip("hostCpu", "CPU") });
    Charts.line($("#sl-mem"), { points: series("hostMem"), yFormat: (v) => `${v}%`, emptyText: "No readings in this window yet (one a minute)", tooltip: tip("hostMem", "Memory") });
    $("#sl-lanes").innerHTML = lanes(d, from, to);
    const runs = d.runs.slice(0, 100);
    $("#sl-runs").innerHTML = runs.length
      ? tableHtml(
          [{ label: "Scan" }, { label: "Started" }, { label: "Took", cls: "num" }, { label: "CPU peak", cls: "num" }, { label: "Memory peak", cls: "num" }, { label: "Dashboard memory", cls: "num" }, { label: "Slowest answer", cls: "num" }, { label: "Ran alongside" }],
          runs.map((r) => {
            const bad = (v, lim) => (v != null && v >= lim ? `<span class="bad">${pctText(v)}</span>` : pctText(v));
            return [
              `<div class="primary">${esc(label(r.tool))}</div>${r.ok === false ? `<div class="secondary bad">failed</div>` : ""}`,
              `<span title="${esc(r.start)}">${esc(fmt.dateTime(r.start))}</span>`,
              esc(dur(r.seconds)),
              bad(r.hostCpu, d.limits.cpu),
              bad(r.hostMem, d.limits.memory),
              r.rss != null ? `${fmt.int(r.rss)} MB${r.startRss != null && r.rss > r.startRss ? ` <span class="muted small">+${fmt.int(r.rss - r.startRss)}</span>` : ""}` : "–",
              r.lag != null ? `${fmt.int(r.lag)} ms` : "–",
              esc(r.others.map(label).join(", ")) || '<span class="muted">–</span>',
            ];
          }),
          { scroll: true }
        )
      : `<div class="empty-state">No scan has finished since this page started recording.</div>`;
    $("#sl-starts").innerHTML = d.starts.length
      ? tableHtml(
          [{ label: "Started" }, { label: "Previous stop" }, { label: "Last reading before it" }],
          d.starts.map((s) => [
            esc(fmt.dateTime(s.at)),
            s.previousStop ? `${esc(fmt.dateTime(s.previousStop))} · ${s.clean ? '<span class="muted">clean stop</span>' : '<span class="bad">no clean stop (crash, out of memory or killed)</span>'}` : '<span class="muted">first start</span>',
            s.lastPoint ? esc(`CPU ${pctText(s.lastPoint.hostCpu)}, memory ${pctText(s.lastPoint.hostMem)}, heap ${pctText(s.lastPoint.heapPct)}${s.lastPoint.scans.length ? `, running ${s.lastPoint.scans.map(label).join(", ")}` : ""}`) : '<span class="muted">–</span>',
          ])
        )
      : `<div class="empty-state">None.</div>`;
  }

  return { show };
})();
