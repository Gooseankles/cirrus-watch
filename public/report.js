"use strict";
/* Monthly report page: one tenant (or every tenant the person can see) for one month, made to be printed or saved as
   PDF from the browser. Uses esc(), fmt, statTile, tableHtml, kindBadge, kindSev, kindLabel, subCell, apiJson, icon,
   TOOLS, state and tenantList from app.js, Compliance from compliance.js and Charts from charts.js. */
const Report = (() => {
  const st = { month: null, data: {}, loading: {}, built: false };
  const LIST_ROWS = 40;
  const thisMonth = () => new Date().toISOString().slice(0, 7);

  // 100 with nothing open, falling as open findings pile up; critical ones weigh most.
  const WEIGHT = { crit: 5, warn: 2, "": 0.5 };
  function weighted(byKind) {
    let w = 0;
    for (const [k, n] of Object.entries(byKind || {})) w += (WEIGHT[kindSev(k)] || 0.5) * n;
    return w;
  }
  const score = (w) => Math.round((100 * 100) / (100 + w));
  function sevCounts(byKind) {
    const out = { crit: 0, warn: 0, other: 0 };
    for (const [k, n] of Object.entries(byKind || {})) out[kindSev(k) || "other"] += n;
    return out;
  }
  function merge(list) {
    const out = {};
    for (const byKind of list) for (const [k, n] of Object.entries(byKind || {})) out[k] = (out[k] || 0) + n;
    return out;
  }

  function months() {
    const out = [];
    const d = new Date();
    for (let i = 0; i < 13; i++) {
      out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
    }
    return out;
  }
  const cacheKey = () => `${state.tenant}|${st.month}`;

  function show(arg) {
    st.month = /^\d{4}-\d{2}$/.test(arg || "") && arg <= thisMonth() ? arg : st.month || thisMonth();
    const page = $("#page-report");
    if (!st.built) {
      page.innerHTML = `
        <div class="page-head">
          <div><h1>Monthly report</h1><p class="page-sub">Where things stood at the end of the month, what was found and what was fixed. Print it or save it as PDF for the customer.</p></div>
          <div class="page-actions no-print">
            <select class="select" id="rp-month"></select>
            <button class="btn" id="rp-print">${icon("print")} Print / PDF</button>
          </div>
        </div>
        <div id="rp-body"></div>`;
      $("#rp-month").addEventListener("change", (e) => navigate(`report/${e.target.value}`));
      $("#rp-print").addEventListener("click", () => window.print());
      st.built = true;
    }
    $("#rp-month").innerHTML = months().map((m) => `<option value="${m}"${m === st.month ? " selected" : ""}>${esc(fmt.month(m))}${m === thisMonth() ? " (so far)" : ""}</option>`).join("");
    draw();
    load().then(() => {
      if (state.route === "report") draw();
    });
  }

  function load() {
    const key = cacheKey();
    if (st.data[key]) return Promise.resolve(st.data[key]);
    if (!st.loading[key]) {
      st.loading[key] = apiJson(`/api/report?month=${encodeURIComponent(st.month)}`)
        .then((r) => (st.data[key] = r))
        .catch((err) => (st.data[key] = { error: err.message }))
        .finally(() => delete st.loading[key]);
    }
    return st.loading[key];
  }

  function draw() {
    const body = $("#rp-body");
    const r = st.data[cacheKey()];
    if (!r) {
      body.innerHTML = `<div class="empty-state">Building the report…</div>`;
      return;
    }
    if (r.error) {
      body.innerHTML = `<div class="status-msg error">${esc(r.error)}</div>`;
      return;
    }
    const tools = (r.tools || []).filter((t) => TOOL_BY_ID[t.id] && !TOOL_BY_ID[t.id].info);
    const endKinds = merge(tools.map((t) => t.openByKind));
    const startKinds = merge(tools.map((t) => t.startByKind));
    const hadStart = tools.some((t) => t.startRanAt);
    const scoreEnd = score(weighted(endKinds));
    const scoreStart = score(weighted(startKinds));
    const sev = sevCounts(endKinds);
    const open = tools.reduce((n, t) => n + t.open, 0);
    const openStart = tools.reduce((n, t) => n + t.openStart, 0);
    const found = tools.reduce((n, t) => n + t.added.open, 0);
    const fixed = tools.reduce((n, t) => n + t.resolved.total, 0);
    const accepted = tools.reduce((n, t) => n + t.accepted, 0);
    const runs = tools.reduce((n, t) => n + t.runs, 0);
    const names = (r.tenants || []).map((t) => t.name);
    const current = r.month === thisMonth();

    body.innerHTML = `
      <div class="report-title">
        <div class="rt-who">${esc(names.length === 1 ? names[0] : names.length ? `${names.length} tenants: ${names.join(", ")}` : "No tenants")}</div>
        <div class="rt-when">${esc(fmt.month(r.month))}${current ? ` · up to ${esc(fmt.date(r.until))}` : ""} · made ${esc(fmt.dateTime(r.generatedAt))}</div>
      </div>
      ${!runs && !tools.some((t) => t.ranAt) ? `<div class="status-msg">No scan results for this month yet.</div>` : ""}
      <div class="stat-row">
        ${statTile({ label: "Score", value: `${scoreEnd} / 100`, delta: hadStart ? `${fmt.signed(scoreEnd - scoreStart)} since the month began` : "no results from before the month", deltaCls: !hadStart ? "" : scoreEnd > scoreStart ? "good" : scoreEnd < scoreStart ? "bad" : "" })}
        ${statTile({ label: "Open findings", value: fmt.int(open), delta: `${fmt.int(sev.crit)} critical · ${fmt.int(sev.warn)} warning`, deltaCls: sev.crit ? "bad" : "" })}
        ${statTile({ label: "Found this month", value: fmt.int(found), deltaCls: found ? "bad" : "", delta: found ? "new and still open" : "nothing new" })}
        ${statTile({ label: "Fixed this month", value: fmt.int(fixed), deltaCls: fixed ? "good" : "", delta: hadStart ? `open at the start: ${fmt.int(openStart)}` : "" })}
        ${statTile({ label: "Accepted", value: fmt.int(accepted), delta: "known and agreed, not counted" })}
      </div>
      <div class="note">Score = 100 × 100 / (100 + 5 × critical + 2 × warning + 0.5 × other open findings): 100 means nothing open. ${fmt.int(runs)} scan run${runs === 1 ? "" : "s"} this month.</div>
      ${toolsCard(tools)}
      ${criticalCard(tools)}
      ${complianceCard(tools)}
      ${changeCard("Fixed this month", "delta-down", tools, (t) => t.resolved)}
      ${changeCard("Found this month", "delta-up", tools, (t) => ({ total: t.added.total, list: t.added.list }))}`;
    for (const el of $$("#rp-body [data-spark]")) {
      const t = tools.find((x) => x.id === el.dataset.spark);
      Charts.sparkline(el, t ? t.trend.map((p) => p.count) : []);
    }
  }

  function toolsCard(tools) {
    const rows = tools.map((t) => {
      const s = sevCounts(t.openByKind);
      const change = t.open - t.openStart;
      return [
        `<a href="#/scan/${esc(t.id)}">${esc(TOOL_BY_ID[t.id].label)}</a>`,
        fmt.int(t.open),
        s.crit ? `<span class="bad">${fmt.int(s.crit)}</span>` : `<span class="muted">0</span>`,
        fmt.int(s.warn),
        t.startRanAt ? `<span class="${change > 0 ? "delta-up" : change < 0 ? "delta-down" : "muted"}">${fmt.signed(change)}</span>` : `<span class="muted">–</span>`,
        fmt.int(t.added.open),
        fmt.int(t.resolved.total),
        t.accepted ? fmt.int(t.accepted) : `<span class="muted">0</span>`,
        `<div class="rp-spark" data-spark="${esc(t.id)}"></div>`,
        t.ranAt ? `<span class="muted">${esc(fmt.date(t.ranAt))}</span>` : `<span class="muted">never</span>`,
      ];
    });
    const n = { cls: "num" };
    return `<div class="card"><div class="card-head"><h2>${icon("list")} By scan</h2><span class="meta">open at the end of the month, change since its start</span></div>
      ${tableHtml([{ label: "Scan" }, { label: "Open", ...n }, { label: "Critical", ...n }, { label: "Warning", ...n }, { label: "Change", ...n }, { label: "Found", ...n }, { label: "Fixed", ...n }, { label: "Accepted", ...n }, { label: "Runs this month" }, { label: "Last run" }], rows)}</div>`;
  }

  function findingRow(f, toolId) {
    return [
      kindBadge(f.kind),
      `<div class="name-cell"><div class="primary">${esc(f.name || "")}</div><div class="secondary">${esc(TOOL_BY_ID[toolId] ? TOOL_BY_ID[toolId].label : toolId)}</div></div>`,
      subCell(f),
      `<span class="detail-cell">${esc(f.detail || "")}</span>${controlTags(f)}`,
    ];
  }

  function criticalCard(tools) {
    const list = [];
    for (const t of tools) for (const f of t.openList) if (kindSev(f.kind) === "crit") list.push([f, t.id]);
    list.sort((a, b) => String(a[0].firstSeen || "").localeCompare(String(b[0].firstSeen || "")));
    const rows = list.slice(0, LIST_ROWS).map(([f, id]) => [...findingRow(f, id), `<span class="muted nowrap">${esc(fmt.date(f.firstSeen))}</span>`]);
    return `<div class="card"><div class="card-head"><h2>${icon("alert")} Open critical findings</h2><span class="meta">${fmt.int(list.length)}, oldest first</span></div>
      ${rows.length ? tableHtml([{ label: "Kind" }, { label: "Name" }, { label: "Subscription" }, { label: "Detail" }, { label: "Open since", cls: "nowrap" }], rows) : `<div class="empty-state">No critical findings open.</div>`}
      ${list.length > LIST_ROWS ? `<div class="note">Showing the oldest ${LIST_ROWS} of ${fmt.int(list.length)}.</div>` : ""}</div>`;
  }

  // Counted from each tool's open kinds (probes need the finding itself, so they come from the open list).
  function complianceCard(tools) {
    const ctl = new Map();
    const add = (c, n, crit) => {
      const e = ctl.get(c.id) || { c, n: 0, crit: 0 };
      e.n += n;
      e.crit += crit;
      ctl.set(c.id, e);
    };
    for (const t of tools) {
      const listed = t.openList.length >= t.open;
      if (listed) {
        for (const f of t.openList) for (const c of Compliance.of(f)) add(c, 1, kindSev(f.kind) === "crit" ? 1 : 0);
      } else {
        for (const [kind, n] of Object.entries(t.openByKind)) for (const c of Compliance.of({ kind })) add(c, n, kindSev(kind) === "crit" ? n : 0);
      }
    }
    const rows = [...ctl.values()]
      .sort((a, b) => a.c.fw.localeCompare(b.c.fw) || b.crit - a.crit || b.n - a.n)
      .map((e) => [`<span class="ctl ctl-${esc(e.c.fw)}">${esc(e.c.label)}</span>`, esc(e.c.title), fmt.int(e.n), e.crit ? `<span class="bad">${fmt.int(e.crit)}</span>` : `<span class="muted">0</span>`]);
    return `<div class="card"><div class="card-head"><h2>${icon("policy")} Compliance</h2><span class="meta">${Object.values(FRAMEWORKS).map(esc).join(" · ")}</span></div>
      ${rows.length ? tableHtml([{ label: "Control" }, { label: "What it asks for" }, { label: "Open findings", cls: "num" }, { label: "Critical", cls: "num" }], rows) : `<div class="empty-state">No open finding bears on a mapped control.</div>`}
      <div class="note">Controls with open findings that bear on them. A pointer, not an audit: a control with no findings is not proven to be met.</div></div>`;
  }

  function changeCard(title, cls, tools, pick) {
    const list = [];
    let total = 0;
    for (const t of tools) {
      const c = pick(t);
      total += c.total;
      for (const f of c.list) list.push([f, t.id]);
    }
    const rows = list.slice(0, LIST_ROWS).map(([f, id]) => findingRow(f, id));
    return `<div class="card"><div class="card-head"><h2><span class="${cls}">${esc(title)}</span></h2><span class="meta">${fmt.int(total)}</span></div>
      ${rows.length ? tableHtml([{ label: "Kind" }, { label: "Name" }, { label: "Subscription" }, { label: "Detail" }], rows) : `<div class="empty-state">None.</div>`}
      ${total > rows.length ? `<div class="note">Showing ${fmt.int(rows.length)} of ${fmt.int(total)}.</div>` : ""}</div>`;
  }

  function reset() {
    st.data = {};
  }

  return { show, reset };
})();
