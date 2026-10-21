"use strict";
/* Cost history page: tenant trend, per-subscription table, drill-down with daily and breakdown charts.
   Uses esc(), fmt, statTile, tableHtml, apiJson, postJson, icon and Charts from app.js / charts.js. */
const Cost = (() => {
  const st = {
    index: null, loadedAt: null, loading: null, error: null,
    sort: { key: "monthToDate", dir: -1 }, sel: null, detail: {}, range: 6, table: false, poll: null, built: false, refreshing: false,
  };
  const RANGES = [[3, "3 months"], [6, "6 months"], [12, "12 months"], [0, "All"]];
  const TOP_N = 7;

  async function loadIndex() {
    if (st.loading) return st.loading;
    st.loading = (async () => {
      try {
        const r = await apiJson("/api/cost/history");
        st.index = {
          updatedAt: r.updatedAt || null,
          running: Boolean(r.running),
          subscriptions: Array.isArray(r.subscriptions) ? r.subscriptions : [],
          failures: Array.isArray(r.failures) ? r.failures : [],
        };
        st.loadedAt = new Date();
        st.error = null;
      } catch (err) {
        st.error = err.message;
        if (!st.index) st.index = { updatedAt: null, running: false, subscriptions: [], failures: [] };
      }
      st.loading = null;
      return st.index;
    })();
    return st.loading;
  }

  const thisMonth = () => new Date().toISOString().slice(0, 7);

  function summary() {
    const ix = st.index;
    if (!ix || !ix.subscriptions.length) return null;
    const subs = ix.subscriptions;
    const curCount = {};
    for (const s of subs) if (s.currency) curCount[s.currency] = (curCount[s.currency] || 0) + 1;
    const currencies = Object.entries(curCount).sort((a, b) => b[1] - a[1]);
    const currency = currencies.length ? currencies[0][0] : "";
    const sum = (k) => subs.reduce((a, s) => a + (Number(s[k]) || 0), 0);
    const last30 = sum("last30");
    const prev30 = sum("prev30");
    const monthly = {};
    for (const s of subs) for (const [m, v] of Object.entries(s.monthly || {})) monthly[m] = (monthly[m] || 0) + (Number(v) || 0);
    const cur = thisMonth();
    const months = Object.keys(monthly).sort().slice(-13).map((m) => ({ month: m, total: monthly[m], partial: m === cur }));
    return {
      subs, updatedAt: ix.updatedAt, running: ix.running, currency, mixed: currencies.length > 1,
      mtd: sum("monthToDate"), forecast: sum("forecast"), lastMonth: sum("lastMonth"), last12: sum("last12Months"),
      change30: prev30 > 0 ? ((last30 - prev30) / prev30) * 100 : null,
      months,
      currencyNote: currencies.length > 1 ? `Subscriptions bill in ${currencies.map((c) => c[0]).join(", ")}; the totals above add the numbers as they are and are shown in ${currency}.` : "",
    };
  }

  /* ---------- page ---------- */
  function show() {
    const page = $("#page-cost");
    if (!st.built) {
      page.innerHTML = `
        <div class="page-head">
          <div><h1>Cost history</h1><p class="page-sub">Spend per subscription from Azure Cost Management: month to date, forecast, 30-day change and twelve months of history. Refreshed daily at 07:30.</p></div>
          <div class="page-actions"><div class="last-run" id="cost-updated"></div><button class="btn primary" id="cost-refresh" data-action="refresh">${icon("refresh")} Refresh now</button></div>
        </div>
        <div class="status-msg" id="cost-status"></div>
        <div id="cost-main"></div>
        <div id="cost-drill"></div>
        <div id="cost-anoms"></div>`;
      page.addEventListener("click", onClick);
      st.built = true;
    }
    render();
    loadIndex().then(() => {
      if (state.route !== "cost") return;
      render();
      if (st.index.running) startPoll();
    });
    loadTool("cost-anomaly").then(() => state.route === "cost" && renderAnomalies());
  }

  function onClick(e) {
    const el = e.target.closest("[data-action],th[data-sort],tr[data-sub],[data-range],[data-cview]");
    if (!el) return;
    if (el.dataset.action === "refresh") return refresh();
    if (el.dataset.sort) {
      const key = el.dataset.sort;
      if (st.sort.key === key) st.sort.dir = -st.sort.dir;
      else st.sort = { key, dir: key === "subscriptionName" ? 1 : -1 };
      renderMain();
    } else if (el.dataset.sub !== undefined) {
      select(el.dataset.sub);
    } else if (el.dataset.range !== undefined) {
      st.range = Number(el.dataset.range);
      renderDrill();
    } else if (el.dataset.cview) {
      st.table = el.dataset.cview === "table";
      renderDrill();
    }
  }

  function render() {
    renderMain();
    renderDrill();
    renderAnomalies();
  }

  function renderMain() {
    const runner = canRun();
    const s = summary();
    const ix = st.index;
    const btn = $("#cost-refresh");
    btn.classList.toggle("hidden", !runner);
    const running = Boolean(ix && ix.running);
    btn.disabled = running || st.refreshing;
    btn.innerHTML = running ? `${icon("loader", "spin")} Refreshing…` : `${icon("refresh")} Refresh now`;
    btn.classList.toggle("running", running);
    $("#cost-updated").innerHTML = !ix
      ? "Loading…"
      : running
        ? `<span class="refresh-badge"><span class="spin"></span>Reading Cost Management</span>`
        : ix.updatedAt
          ? `Updated <b title="${esc(ix.updatedAt)}">${esc(fmt.rel(ix.updatedAt))}</b><br>${fmt.int(ix.subscriptions.length)} subscription${ix.subscriptions.length === 1 ? "" : "s"}${ix.failures.length ? ` · ${fmt.int(ix.failures.length)} failed` : ""}`
          : "<b>No data yet</b>";
    const main = $("#cost-main");
    if (!ix) {
      main.innerHTML = `<div class="card"><div class="empty-state">Loading…</div></div>`;
      return;
    }
    if (st.error && !ix.subscriptions.length) {
      main.innerHTML = `<div class="card"><div class="empty-state big"><h3>Could not load cost history</h3><p class="muted">${esc(st.error)}</p></div></div>`;
      return;
    }
    if (!s) {
      main.innerHTML = `<div class="card"><div class="empty-state big">${icon("cost")}<h3>No cost data yet</h3><p>${
        running
          ? "The first refresh is running. This page updates by itself when it finishes."
          : runner
            ? "Nothing has been read from Cost Management on this server. Start the first refresh; it takes a few minutes for a large tenant."
            : "Nothing has been read from Cost Management on this server yet. Ask an admin to refresh the cost history."
      }</p>${runner && !running ? `<p><button class="btn primary" data-action="refresh">${icon("refresh")} Refresh now</button></p>` : ""}${
        ix.failures.length ? failuresHtml(ix.failures) : ""
      }</div></div>`;
      return;
    }
    const up = s.change30 > 0;
    main.innerHTML = `
      <div class="stat-row cost-layout">
        ${statTile({ label: "Month to date", value: fmt.money(s.mtd, s.currency, true), delta: fmt.month(thisMonth()) })}
        ${statTile({ label: "Forecast this month", value: fmt.money(s.forecast, s.currency, true), delta: s.lastMonth > 0 ? `${fmt.pct(((s.forecast - s.lastMonth) / s.lastMonth) * 100)} vs last month` : "", deltaCls: s.lastMonth > 0 ? (s.forecast > s.lastMonth ? "bad" : "good") : "" })}
        ${statTile({ label: "Last month", value: fmt.money(s.lastMonth, s.currency, true) })}
        ${statTile({ label: "30-day change", value: fmt.pct(s.change30, 1), deltaCls: s.change30 == null ? "" : up ? "bad" : "good", delta: s.change30 == null ? "not enough history" : "last 30 days vs the 30 before" })}
        ${statTile({ label: "Last 12 months", value: fmt.money(s.last12, s.currency, true) })}
      </div>
      ${s.currencyNote ? `<div class="note">${esc(s.currencyNote)}</div>` : ""}
      <div class="card">
        <div class="card-head"><h2>${icon("trend")} Spend by month</h2><span class="meta">${multiView() ? "every tenant" : "all subscriptions"} · ${esc(s.currency)}</span></div>
        <div class="chart trend-chart" id="cost-trend"></div>
        <div class="chart-foot"><span>Last 13 months</span><span>The current month is still filling up</span></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>Subscriptions</h2><span class="meta">${fmt.int(s.subs.length)} · click a row for daily spend and breakdowns</span></div>
        <div class="cost-table-wrap">${subTable(s)}</div>
        ${ix.failures.length ? failuresHtml(ix.failures) : ""}
      </div>`;
    Charts.columns($("#cost-trend"), {
      data: s.months.map((m) => ({ label: fmt.monthShort(m.month), value: m.total, partial: m.partial, month: m.month })),
      yFormat: Charts.compact,
      emptyText: "No monthly totals yet",
      tooltip: (d, i) => {
        const prev = i > 0 ? s.months[i - 1].total : null;
        const rows = [{ label: "Total", value: fmt.money(d.value, s.currency) }];
        if (prev != null && prev > 0 && !d.partial) rows.push({ label: "vs month before", value: fmt.pct(((d.value - prev) / prev) * 100, 1) });
        return { title: fmt.month(d.month), rows, note: d.partial ? "Month in progress" : undefined };
      },
    });
  }

  function failuresHtml(failures) {
    return `<details class="failures"><summary>${fmt.int(failures.length)} subscription${failures.length === 1 ? "" : "s"} could not be read</summary><ul>${failures
      .map((f) => `<li>${multiView() && f.tenantName ? `<span class="tenant-badge">${esc(f.tenantName)}</span>` : ""}<b>${esc(f.subscriptionName || f.subscriptionId || "Subscription list")}</b> <span class="mono muted">${esc(f.subscriptionId)}</span>: ${esc(f.error)}</li>`)
      .join("")}</ul></details>`;
  }

  function sortValue(s, key) {
    if (key === "subscriptionName") return String(s.subscriptionName || s.subscriptionId || "").toLowerCase();
    if (key === "topService") return s.topService ? Number(s.topService.cost) || 0 : -1;
    if (key === "change30Pct") return s.change30Pct == null ? -Infinity : Number(s.change30Pct);
    return Number(s[key]) || 0;
  }
  function subTable(s) {
    const cols = [
      { key: "subscriptionName", label: "Subscription" },
      { key: "monthToDate", label: "Month to date", cls: "num" },
      { key: "forecast", label: "Forecast", cls: "num" },
      { key: "lastMonth", label: "Last month", cls: "num" },
      { key: "change30Pct", label: "30-day change", cls: "num" },
      { key: "last12Months", label: "12 months", cls: "num" },
      { key: "topService", label: "Top service" },
    ];
    const rows = s.subs.slice().sort((a, b) => {
      const va = sortValue(a, st.sort.key);
      const vb = sortValue(b, st.sort.key);
      return (va < vb ? -1 : va > vb ? 1 : 0) * st.sort.dir;
    });
    const head = cols.map((c) => `<th class="sortable ${c.cls || ""}${st.sort.key === c.key ? " sorted" + (st.sort.dir > 0 ? " asc" : "") : ""}" data-sort="${c.key}">${esc(c.label)}</th>`).join("");
    const body = rows
      .map((r) => {
        const cur = r.currency || s.currency;
        const ch = r.change30Pct;
        const chCell = ch == null ? '<span class="muted">–</span>' : `<span class="${ch > 0.5 ? "delta-up" : ch < -0.5 ? "delta-down" : "muted"}">${esc(fmt.pct(ch, 1))}</span>`;
        const top = r.topService && r.topService.name ? `<div class="name-cell"><div class="primary">${esc(r.topService.name)}</div><div class="secondary">${esc(fmt.money(r.topService.cost, cur, true))} last 30 days</div></div>` : '<span class="muted">–</span>';
        return `<tr class="clickable${st.sel === r.subscriptionId ? " sel" : ""}" data-sub="${esc(r.subscriptionId)}">
          <td><div class="sub-cell"><div class="primary">${multiView() && r.tenantName ? `<span class="tenant-badge">${esc(r.tenantName)}</span>` : ""}${esc(r.subscriptionName || r.subscriptionId)}</div><div class="secondary">${esc(r.subscriptionId)}</div></div></td>
          <td class="num">${esc(fmt.money(r.monthToDate, cur, true))}</td>
          <td class="num">${esc(fmt.money(r.forecast, cur, true))}</td>
          <td class="num">${esc(fmt.money(r.lastMonth, cur, true))}</td>
          <td class="num">${chCell}</td>
          <td class="num">${esc(fmt.money(r.last12Months, cur, true))}</td>
          <td>${top}</td>
        </tr>`;
      })
      .join("");
    return `<div class="table-wrap"><table class="data"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  /* ---------- drill-down ---------- */
  function fetchDetail(key) {
    return apiJson(`/api/cost/history/${encodeURIComponent(key)}`)
      .then((d) => {
        st.detail[key] = d;
      })
      .catch((err) => {
        st.detail[key] = { error: err.status === 404 ? "No daily data has been stored for this subscription yet." : err.message };
      })
      .then(() => st.sel === key && state.route === "cost" && renderDrill());
  }
  function select(id) {
    st.sel = st.sel === id ? null : id;
    renderMain();
    renderDrill();
    if (st.sel && !st.detail[st.sel]) fetchDetail(st.sel);
    if (st.sel) {
      const card = $("#cost-drill");
      if (card) card.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  function monthsBack(n) {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - (n - 1));
    return d.toISOString().slice(0, 7);
  }
  function daysBack(n) {
    const d = new Date(Date.now() - n * 86400000);
    return d.toISOString().slice(0, 10);
  }

  function renderDrill() {
    const el = $("#cost-drill");
    if (!el) return;
    if (!st.sel) {
      el.innerHTML = "";
      return;
    }
    const sub = (st.index && st.index.subscriptions.find((s) => s.subscriptionId === st.sel)) || { subscriptionId: st.sel, subscriptionName: st.sel };
    const d = st.detail[st.sel];
    const cur = (d && d.currency) || sub.currency || "";
    const head = `<div class="drill-head">
        <div><div class="d-name">${esc(sub.subscriptionName || sub.subscriptionId)}</div><div class="d-id">${esc(sub.subscriptionId)}${d && d.firstDay ? ` · data since ${esc(fmt.date(d.firstDay))}` : ""}</div></div>
        <div class="range-row">
          <div class="seg">${RANGES.map(([n, l]) => `<button type="button" data-range="${n}" class="${st.range === n ? "active" : ""}">${l}</button>`).join("")}</div>
          <div class="seg"><button type="button" data-cview="chart" class="${st.table ? "" : "active"}">Chart</button><button type="button" data-cview="table" class="${st.table ? "active" : ""}">Table</button></div>
        </div>
      </div>
      <div class="stat-row cost-layout" style="margin-top:12px">
        ${statTile({ label: "Month to date", value: fmt.money(sub.monthToDate, cur, true) })}
        ${statTile({ label: "Forecast", value: fmt.money(sub.forecast, cur, true) })}
        ${statTile({ label: "Last month", value: fmt.money(sub.lastMonth, cur, true) })}
        ${statTile({ label: "30-day change", value: fmt.pct(sub.change30Pct, 1), deltaCls: sub.change30Pct == null ? "" : sub.change30Pct > 0 ? "bad" : "good", delta: `${fmt.money(sub.last30, cur, true)} vs ${fmt.money(sub.prev30, cur, true)}` })}
        ${statTile({ label: "Top service", value: sub.topService && sub.topService.name ? sub.topService.name : "–", small: true, delta: sub.topService ? fmt.money(sub.topService.cost, cur, true) + " in 30 days" : "" })}
      </div>`;
    let body;
    if (!d) body = `<div class="empty-state">Loading daily spend…</div>`;
    else if (d.error) body = `<div class="empty-state">${esc(d.error)}</div>`;
    else {
      const monthFrom = st.range ? monthsBack(st.range) : "";
      const dayFrom = st.range ? daysBack(st.range * 30) : "";
      const daily = Object.keys(d.daily || {}).sort().filter((k) => k >= dayFrom).map((k) => ({ day: k, label: fmt.dateShort(k), value: Number(d.daily[k]) || 0 }));
      const rangeLabel = st.range ? `last ${st.range} months` : "all stored history";
      body = `
        <div class="card-head" style="margin-top:14px"><h2>Daily spend</h2><span class="meta">${esc(rangeLabel)} · ${fmt.int(daily.length)} days · ${esc(fmt.money(daily.reduce((a, p) => a + p.value, 0), cur, true))}</span></div>
        ${st.table ? dailyTable(daily, cur) : `<div class="chart daily-chart" id="cost-daily"></div>`}
        <div class="two-col">
          ${breakdownCard("svc", "By service", d.monthlyByService, monthFrom, cur)}
          ${breakdownCard("rg", "By resource group", d.monthlyByRg, monthFrom, cur)}
        </div>`;
    }
    el.innerHTML = `<div class="card" id="cost-drill-card">${head}${body}</div>`;
    if (d && !d.error) {
      if (!st.table) {
        const monthFrom = st.range ? monthsBack(st.range) : "";
        const dayFrom = st.range ? daysBack(st.range * 30) : "";
        const daily = Object.keys(d.daily || {}).sort().filter((k) => k >= dayFrom).map((k) => ({ day: k, label: fmt.dateShort(k), value: Number(d.daily[k]) || 0 }));
        Charts.line($("#cost-daily"), {
          points: daily,
          yFormat: Charts.compact,
          emptyText: "No daily data in this range",
          tooltip: (p) => ({ title: fmt.date(p.day), rows: [{ label: "Spend", value: fmt.money(p.value, cur) }] }),
        });
        drawBreakdown("svc", d.monthlyByService, monthFrom, cur);
        drawBreakdown("rg", d.monthlyByRg, monthFrom, cur);
      }
    }
  }

  function dailyTable(daily, cur) {
    if (!daily.length) return `<div class="empty-state">No daily data in this range.</div>`;
    return tableHtml([{ label: "Day" }, { label: "Spend", cls: "num" }], daily.slice().reverse().map((p) => [esc(fmt.date(p.day)), esc(fmt.money(p.value, cur))]), { scroll: true });
  }

  // Top series by all-time total so colours stay with the entity when the range changes.
  function breakdown(byMonth, monthFrom) {
    const all = byMonth || {};
    const totals = {};
    for (const m of Object.keys(all)) for (const [k, v] of Object.entries(all[m] || {})) totals[k] = (totals[k] || 0) + (Number(v) || 0);
    const ranked = Object.entries(totals).sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    const top = ranked.slice(0, TOP_N);
    const rest = ranked.slice(TOP_N);
    const months = Object.keys(all).sort().filter((m) => m >= monthFrom);
    const series = top.map((name, i) => ({ name, color: Charts.SERIES[i], values: months.map((m) => Number((all[m] || {})[name]) || 0) }));
    if (rest.length) series.push({ name: `Other (${rest.length})`, color: Charts.OTHER, values: months.map((m) => rest.reduce((a, k) => a + (Number((all[m] || {})[k]) || 0), 0)) });
    return { months, series };
  }
  function breakdownCard(key, title, byMonth, monthFrom, cur) {
    const b = breakdown(byMonth, monthFrom);
    const inner = st.table ? breakdownTable(b, cur) : `<div class="legend" id="cost-${key}-legend"></div><div class="chart breakdown-chart" id="cost-${key}"></div>`;
    return `<div class="card"><div class="card-head"><h2>${esc(title)}</h2><span class="meta">${b.series.length ? `top ${Math.min(TOP_N, b.series.length)} by total` : ""}</span></div>${inner}</div>`;
  }
  function drawBreakdown(key, byMonth, monthFrom, cur) {
    const b = breakdown(byMonth, monthFrom);
    const el = $(`#cost-${key}`);
    if (!el) return;
    Charts.legend($(`#cost-${key}-legend`), b.series.length > 1 ? b.series : []);
    Charts.stacked(el, {
      categories: b.months.map(fmt.monthShort),
      series: b.series,
      yFormat: Charts.compact,
      format: (v) => fmt.money(v, cur),
      tooltipTitle: (c, i) => fmt.month(b.months[i]),
      emptyText: "No breakdown in this range",
    });
  }
  function breakdownTable(b, cur) {
    if (!b.months.length || !b.series.length) return `<div class="empty-state">No breakdown in this range.</div>`;
    const cols = [{ label: "Month", cls: "nowrap" }, ...b.series.map((s) => ({ label: s.name, cls: "num" })), { label: "Total", cls: "num" }];
    const rows = b.months
      .map((m, i) => [`<span class="nowrap">${esc(fmt.month(m))}</span>`, ...b.series.map((s) => esc(fmt.money(s.values[i], cur, true))), esc(fmt.money(b.series.reduce((a, s) => a + s.values[i], 0), cur, true))])
      .reverse();
    return tableHtml(cols, rows, { scroll: true });
  }

  /* ---------- anomalies ---------- */
  function renderAnomalies() {
    const el = $("#cost-anoms");
    if (!el) return;
    const t = toolState("cost-anomaly");
    const jumps = t.data.findings.filter((f) => f.kind === "cost-jump");
    const errors = t.data.findings.filter((f) => f.kind === "scan-error");
    el.innerHTML = `<div class="card">
      <div class="card-head"><h2>${icon("alert")} Cost jumps</h2><span class="meta">${t.data.ranAt ? "scan ran " + esc(fmt.rel(t.data.ranAt)) : ""}</span><a href="#/scan/cost-anomaly">Open the cost anomaly scan ${icon("arrow")}</a></div>
      ${
        !t.loaded
          ? `<div class="empty-state">Loading…</div>`
          : !t.data.ranAt
            ? `<div class="empty-state">The cost anomaly scan has not run yet.</div>`
            : jumps.length
              ? tableHtml(
                  [{ label: "Subscription" }, { label: "Detail" }, { label: "First seen", cls: "nowrap" }],
                  jumps.slice(0, 10).map((f) => [subCell(f), `<span class="detail-cell">${esc(f.detail || "")}</span>${isNew(f, t.data.ranAt) ? '<span class="new-badge">NEW</span>' : ""}`, `<span class="muted">${esc(fmt.date(f.firstSeen))}</span>`])
                ) + (jumps.length > 10 ? `<div class="note">Showing 10 of ${fmt.int(jumps.length)}.</div>` : "")
              : `<div class="empty-state">No subscription jumped against its baseline in the last scan.${errors.length ? ` ${fmt.int(errors.length)} subscription${errors.length === 1 ? "" : "s"} could not be checked.` : ""}</div>`
      }
    </div>`;
  }

  /* ---------- refresh ---------- */
  async function refresh() {
    if (st.refreshing) return;
    st.refreshing = true;
    renderMain();
    const status = $("#cost-status");
    try {
      const r = await postJson("/api/cost/history/refresh", {});
      setStatus(status, r.status === "already running" ? "A refresh is already running; waiting for it to finish." : "Refresh started. Reading Cost Management for every subscription; this can take a few minutes.");
      if (st.index) st.index.running = true;
      startPoll();
    } catch (err) {
      setStatus(status, `Refresh failed: ${err.message}`, "error");
    }
    st.refreshing = false;
    renderMain();
  }
  function startPoll() {
    if (st.poll) return;
    st.poll = setInterval(async () => {
      await loadIndex();
      if (!st.index.running) {
        clearInterval(st.poll);
        st.poll = null;
        st.detail = {};
        setStatus($("#cost-status"), `Cost history refreshed ${fmt.rel(st.index.updatedAt)}.${st.index.failures.length ? ` ${fmt.int(st.index.failures.length)} subscription${st.index.failures.length === 1 ? "" : "s"} failed.` : ""}`, st.index.failures.length ? "error" : "ok");
        if (state.route === "cost") {
          render();
          if (st.sel) fetchDetail(st.sel);
        }
      } else if (state.route === "cost") renderMain();
    }, 3000);
  }

  // Tenant tab changed: forget what was loaded for the other tab.
  function reset() {
    if (st.poll) clearInterval(st.poll);
    Object.assign(st, { index: null, loadedAt: null, loading: null, error: null, sel: null, detail: {}, poll: null, refreshing: false });
    setStatus($("#cost-status"), "");
  }

  return { show, loadIndex, summary, reset, index: () => st.index };
})();
