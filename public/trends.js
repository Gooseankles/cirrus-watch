"use strict";
/* Weekly trends page: open findings at the end of each week across every scan tool, by severity, with what was
   found and fixed each week and a row per tool. GET /api/trends. Uses esc(), fmt, statTile, tableHtml, kindSev,
   apiJson, icon, navigate, state and TOOL_BY_ID from app.js and Charts from charts.js. */
const Trends = (() => {
  const st = { weeks: 12, data: {}, loading: {}, built: false };
  const RANGES = [8, 12, 26, 52];
  const SEV = [
    ["crit", "Critical", "#e66767"],
    ["warn", "Warning", "#c98500"],
    ["other", "Other", Charts.OTHER],
  ];
  const cacheKey = () => `${state.tenant}|${st.weeks}`;
  const weekLabel = (w) => fmt.dateShort(w.start);

  function show() {
    const page = $("#page-trends");
    if (!st.built) {
      page.innerHTML = `
        <div class="page-head">
          <div><h1>Weekly trends</h1><p class="page-sub">Open findings at the end of each week across every scan, with what was found and fixed during it. A week without a scan keeps the last count; a tool's first scan is the starting point, not new findings.</p></div>
          <div class="page-actions"><div class="seg" id="tr-range">${RANGES.map((n) => `<button type="button" data-w="${n}">${n} weeks</button>`).join("")}</div></div>
        </div>
        <div class="status-msg" id="tr-status"></div>
        <div class="stat-row" id="tr-stats"></div>
        <div class="card"><div class="card-head"><h2>Open findings by severity</h2><span class="meta" id="tr-legend"></span></div><div class="chart trend-chart" id="tr-open"></div></div>
        <div class="sl-grid">
          <div class="card"><div class="card-head"><h2>Found</h2><span class="meta">new findings each week</span></div><div class="chart sl-chart" id="tr-added"></div></div>
          <div class="card"><div class="card-head"><h2>Fixed</h2><span class="meta">findings gone each week</span></div><div class="chart sl-chart" id="tr-resolved"></div></div>
        </div>
        <div class="card"><div class="card-head"><h2>By tool</h2><span class="meta">open now, and the change over the period</span></div><div id="tr-tools"></div></div>`;
      $("#tr-range").addEventListener("click", (e) => {
        const b = e.target.closest("[data-w]");
        if (!b) return;
        st.weeks = Number(b.dataset.w);
        show();
      });
      $("#tr-tools").addEventListener("click", (e) => {
        const r = e.target.closest("[data-tool]");
        if (r) navigate(`scan/${r.dataset.tool}`);
      });
      st.built = true;
    }
    $$("#tr-range [data-w]").forEach((b) => b.classList.toggle("active", Number(b.dataset.w) === st.weeks));
    draw();
    load().then(() => {
      if (state.route === "trends") draw();
    });
  }

  function load() {
    const key = cacheKey();
    if (st.data[key]) return Promise.resolve(st.data[key]);
    if (!st.loading[key]) {
      st.loading[key] = apiJson(`/api/trends?weeks=${st.weeks}`)
        .then((r) => (st.data[key] = r))
        .catch((err) => (st.data[key] = { error: err.message }))
        .finally(() => delete st.loading[key]);
    }
    return st.loading[key];
  }

  function sevSeries(tools, n) {
    const out = { crit: Array(n).fill(0), warn: Array(n).fill(0), other: Array(n).fill(0) };
    for (const t of tools) {
      t.byKind.forEach((byKind, i) => {
        for (const [k, c] of Object.entries(byKind || {})) out[kindSev(k) || "other"][i] += c;
      });
    }
    return out;
  }
  const sum = (list) => list.reduce((a, b) => a + b, 0);

  function draw() {
    const r = st.data[cacheKey()];
    const status = $("#tr-status");
    if (!r || r.error) {
      setStatus(status, r ? `Could not load the trends: ${r.error}` : "Loading…", r ? "error" : "");
      if (!r) return;
      $("#tr-stats").innerHTML = "";
      return;
    }
    setStatus(status, r.tools.length ? "" : "No scan results yet. Trends show once scans have run.");
    const weeks = r.weeks;
    const n = weeks.length;
    const tools = r.tools.filter((t) => TOOL_BY_ID[t.id] && !TOOL_BY_ID[t.id].info);
    const open = weeks.map((w, i) => sum(tools.map((t) => t.open[i])));
    const added = weeks.map((w, i) => sum(tools.map((t) => t.added[i])));
    const resolved = weeks.map((w, i) => sum(tools.map((t) => t.resolved[i])));
    const sev = sevSeries(tools, n);
    // Change is counted from the first week any tool had results.
    const first = weeks.findIndex((w, i) => tools.some((t) => t.known && t.known[i]));
    const startAt = first < 0 ? 0 : first;
    const change = open[n - 1] - open[startAt];

    $("#tr-stats").innerHTML = [
      statTile({ label: "Open now", value: fmt.int(open[n - 1]), delta: `${fmt.int(sev.crit[n - 1])} critical · ${fmt.int(sev.warn[n - 1])} warning`, deltaCls: sev.crit[n - 1] ? "bad" : "" }),
      statTile({ label: "Change", value: fmt.signed(change), delta: `since ${fmt.date(weeks[startAt].start)}`, deltaCls: change < 0 ? "good" : change > 0 ? "bad" : "" }),
      statTile({ label: "Critical change", value: fmt.signed(sev.crit[n - 1] - sev.crit[startAt]), deltaCls: sev.crit[n - 1] < sev.crit[startAt] ? "good" : sev.crit[n - 1] > sev.crit[startAt] ? "bad" : "" }),
      statTile({ label: "Found", value: fmt.int(sum(added)), delta: `in ${n} weeks` }),
      statTile({ label: "Fixed", value: fmt.int(sum(resolved)), delta: `in ${n} weeks`, deltaCls: sum(resolved) ? "good" : "" }),
    ].join("");

    const cats = weeks.map(weekLabel);
    const series = SEV.map(([k, name, color]) => ({ name, color, values: sev[k] }));
    Charts.legend($("#tr-legend"), series);
    Charts.stacked($("#tr-open"), { categories: cats, series, emptyText: "No scans yet", tooltipTitle: (c, i) => `Week ${weeks[i].week.split("-W")[1]} (from ${fmt.date(weeks[i].start)})`, format: fmt.int });
    const cols = (vals) => weeks.map((w, i) => ({ label: weekLabel(w), value: vals[i], partial: i === n - 1, week: w }));
    const tip = (what) => (d) => ({ title: `Week ${d.week.week.split("-W")[1]} (from ${fmt.date(d.week.start)})`, rows: [{ label: what, value: fmt.int(d.value) }] });
    Charts.columns($("#tr-added"), { data: cols(added), integer: true, tooltip: tip("Found") });
    Charts.columns($("#tr-resolved"), { data: cols(resolved), integer: true, tooltip: tip("Fixed") });

    const rows = tools
      .map((t) => ({ t, now: t.open[n - 1], delta: t.open[n - 1] - t.open[startAt], found: sum(t.added), fixed: sum(t.resolved) }))
      .sort((a, b) => b.now - a.now || a.t.label.localeCompare(b.t.label));
    $("#tr-tools").innerHTML = rows.length
      ? tableHtml(
          [{ label: "Tool" }, { label: `Last ${n} weeks` }, { label: "Open now", cls: "num" }, { label: "Change", cls: "num" }, { label: "Found", cls: "num" }, { label: "Fixed", cls: "num" }],
          rows.map((x) => ({
            attrs: `data-tool="${esc(x.t.id)}" class="clickable"`,
            cells: [
              `${icon(TOOL_BY_ID[x.t.id].icon)} ${esc(TOOL_BY_ID[x.t.id].label)}`,
              `<div class="tr-spark" data-spark="${esc(x.t.id)}"></div>`,
              fmt.int(x.now),
              `<span class="${x.delta < 0 ? "good" : x.delta > 0 ? "bad" : "text-2"}">${fmt.signed(x.delta)}</span>`,
              fmt.int(x.found),
              fmt.int(x.fixed),
            ],
          }))
        )
      : `<div class="empty-state">No scan results yet.</div>`;
    for (const x of rows) {
      const el = $(`#tr-tools [data-spark="${x.t.id}"]`);
      if (el) Charts.sparkline(el, x.t.open);
    }
  }

  return { show };
})();
