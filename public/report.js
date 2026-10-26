"use strict";
/* Monthly report page: one tenant (or every tenant the person can see) for one month, made to be printed or saved as
   PDF from the browser. Uses esc(), fmt, statTile, tableHtml, kindBadge, kindSev, kindLabel, subCell, apiJson, icon,
   TOOLS, state and tenantList from app.js, Compliance from compliance.js and Charts from charts.js. */
const Report = (() => {
  const st = { month: null, data: {}, loading: {}, built: false };
  const LIST_ROWS = 40;
  const redraw = () => {
    if (state.route === "report") draw();
  };
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
    const scoreCls = !hadStart ? "" : scoreEnd > scoreStart ? "good" : scoreEnd < scoreStart ? "bad" : "";

    body.innerHTML = `
      <div class="rp-head">
        <div>
          <div class="rp-kicker">Monthly report · ${esc(fmt.month(r.month))}${current ? ` (up to ${esc(fmt.date(r.until))})` : ""}</div>
          <div class="rp-who">${esc(names.length === 1 ? names[0] : names.length ? `${names.length} tenants` : "No tenants")}</div>
          ${names.length > 1 ? `<div class="rp-tenants">${esc(names.join(" · "))}</div>` : ""}
        </div>
        <div class="rp-score ${scoreCls}"><span class="n">${scoreEnd}</span><span class="of">/ 100</span><span class="d">${hadStart ? `${fmt.signed(scoreEnd - scoreStart)} this month` : "score"}</span></div>
      </div>
      ${!runs && !tools.some((t) => t.ranAt) ? `<div class="status-msg">No scan results for this month yet.</div>` : `<p class="rp-summary">${summary({ open, sev, found, fixed, openStart, hadStart, accepted })}</p>`}
      <div class="stat-row rp-stats">
        ${statTile({ label: "Open findings", value: fmt.int(open), delta: `${fmt.int(sev.crit)} critical · ${fmt.int(sev.warn)} warning`, deltaCls: sev.crit ? "bad" : "" })}
        ${statTile({ label: "Fixed this month", value: fmt.int(fixed), deltaCls: fixed ? "good" : "", delta: hadStart ? `of ${fmt.int(openStart)} open at the start` : "" })}
        ${statTile({ label: "Found this month", value: fmt.int(found), deltaCls: found ? "bad" : "", delta: found ? "new and still open" : "nothing new" })}
        ${statTile({ label: "Accepted", value: fmt.int(accepted), delta: "known and agreed" })}
        ${savedTile(r.month)}
      </div>
      ${criticalCard(tools)}
      ${toolsCard(tools)}
      ${changeCard("Fixed this month", "good", tools, (t) => t.resolved)}
      ${changeCard("Found this month", "bad", tools, (t) => t.added)}
      ${savingsCard(r.month)}
      ${complianceCard(tools)}
      <div class="note rp-foot">Score = 100 × 100 / (100 + 5 × critical + 2 × warning + 0.5 × other open findings); 100 means nothing open. Accepted findings are not counted. ${fmt.int(runs)} scan run${runs === 1 ? "" : "s"} this month. Made ${esc(fmt.dateTime(r.generatedAt))}.</div>`;
    for (const el of $$("#rp-body [data-spark]")) {
      const t = tools.find((x) => x.id === el.dataset.spark);
      Charts.sparkline(el, t ? t.trend.map((p) => p.count) : []);
    }
  }

  // One or two plain sentences a customer can read without the tables.
  function summary({ open, sev, found, fixed, openStart, hadStart, accepted }) {
    const n = (x, word) => `${fmt.int(x)} ${word}${x === 1 ? "" : "s"}`;
    const first = open
      ? `${n(open, "finding")} ${open === 1 ? "is" : "are"} open${sev.crit ? `, <b class="bad">${fmt.int(sev.crit)} of them critical</b>` : ", none critical"}.`
      : `<b class="good">Nothing is open.</b>`;
    const parts = [];
    if (fixed) parts.push(`<b class="good">${fmt.int(fixed)} fixed</b>${hadStart ? ` of the ${fmt.int(openStart)} open when the month began` : ""}`);
    if (found) parts.push(`${fmt.int(found)} new found`);
    const second = parts.length ? ` This month: ${parts.join(", ")}.` : " Nothing was fixed or found this month.";
    return first + second + (accepted ? ` ${n(accepted, "finding")} ${accepted === 1 ? "is" : "are"} accepted as known.` : "");
  }

  // Savings done by cleaning up orphaned resources: what was deleted in the month and what it saves a month
  // (list price). Comes from the Orphaned resources scan's cleaned-up list.
  function savingsIn(month) {
    const t = toolState("orphaned-resources");
    if (!t.loaded) {
      loadTool("orphaned-resources").then(redraw);
      return null;
    }
    if (!t.data.ranAt) return null;
    const sv = orSavings(t);
    if (!sv || !sv.data) return null;
    const all = sv.data.entries || [];
    return { all, month: all.filter((e) => String(e.savedAt || "").slice(0, 7) === month && e.monthlyCost > 0) };
  }
  const moneyList = (pairs, k = 1) => pairs.map(([c, m]) => fmt.money(m * k, c, true)).join(" + ");
  function savedTile(month) {
    const s = savingsIn(month);
    if (!s || !s.all.length) return "";
    const pairs = orSaved(s.month);
    const total = orSaved(s.all.filter((e) => String(e.savedAt || "").slice(0, 7) <= month));
    return statTile({ label: "Saved by cleanup", value: pairs.length ? `${moneyList(pairs)} / mo` : "–", deltaCls: pairs.length ? "good" : "", delta: total.length ? `${moneyList(total)} a month in all` : "" });
  }
  function savingsCard(month) {
    const s = savingsIn(month);
    if (!s || !s.month.length) return "";
    const list = s.month.slice().sort((a, b) => (b.monthlyCost || 0) - (a.monthlyCost || 0));
    const pairs = orSaved(list);
    const rows = list.slice(0, LIST_ROWS).map((e) => [
      esc(savingAction(e)),
      `<div class="name-cell"><div class="primary">${esc(e.name || "")}</div>${e.resourceGroup ? `<div class="secondary">rg ${esc(e.resourceGroup)}</div>` : ""}</div>`,
      subCell(e),
      `<span class="muted nowrap">${esc(fmt.date(e.savedAt))}</span>`,
      `<span class="good">${esc(fmt.money(e.monthlyCost, e.currency))}</span>`,
    ]);
    return `<div class="card"><div class="card-head"><h2>${icon("trash")} <span class="good">Savings done</span></h2><span class="meta">${moneyList(pairs)} a month · ${moneyList(pairs, 12)} a year</span></div>
      ${tableHtml([{ label: "What was done" }, { label: "Resource" }, { label: "Subscription" }, { label: "When", cls: "nowrap" }, { label: "Saves a month", cls: "num" }], rows)}
      ${list.length > LIST_ROWS ? `<div class="note">Showing the largest ${LIST_ROWS} of ${fmt.int(list.length)}.</div>` : ""}
      <div class="note">Leftovers the dashboard found that were cleaned up this month, at Azure list price before discounts.</div></div>`;
  }

  // Scans with something open or something that changed get a row; the rest are named in one line.
  function toolsCard(tools) {
    const active = tools.filter((t) => t.open || t.added.total || t.resolved.total).sort((a, b) => sevCounts(b.openByKind).crit - sevCounts(a.openByKind).crit || b.open - a.open);
    const clean = tools.filter((t) => t.ranAt && !active.includes(t));
    const never = tools.filter((t) => !t.ranAt && !active.includes(t));
    const rows = active.map((t) => {
      const s = sevCounts(t.openByKind);
      const change = t.open - t.openStart;
      const sevs = [s.crit ? `<span class="bad">${fmt.int(s.crit)} critical</span>` : "", s.warn ? `${fmt.int(s.warn)} warning` : ""].filter(Boolean).join(" · ");
      return [
        `<a href="#/scan/${esc(t.id)}">${esc(TOOL_BY_ID[t.id].label)}</a>`,
        `<b>${fmt.int(t.open)}</b>${sevs ? `<div class="secondary">${sevs}</div>` : ""}`,
        t.startRanAt ? `<span class="${change > 0 ? "delta-up" : change < 0 ? "delta-down" : "muted"}">${change ? fmt.signed(change) : "±0"}</span>` : `<span class="muted">–</span>`,
        t.resolved.total ? `<span class="good">${fmt.int(t.resolved.total)}</span>` : `<span class="muted">0</span>`,
        t.added.open ? fmt.int(t.added.open) : `<span class="muted">0</span>`,
        `<div class="rp-spark" data-spark="${esc(t.id)}"></div>`,
      ];
    });
    const n = { cls: "num" };
    const label = (list) => list.map((t) => esc(TOOL_BY_ID[t.id].label)).join(", ");
    return `<div class="card"><div class="card-head"><h2>${icon("list")} By scan</h2><span class="meta">open at the end of the month</span></div>
      ${rows.length ? tableHtml([{ label: "Scan" }, { label: "Open" }, { label: "Change", ...n }, { label: "Fixed", ...n }, { label: "Found", ...n }, { label: "This month" }], rows) : ""}
      ${clean.length ? `<div class="rp-line"><span class="good">${icon("check")} Nothing open</span> ${label(clean)}</div>` : ""}
      ${never.length ? `<div class="rp-line muted">Not run: ${label(never)}</div>` : ""}</div>`;
  }

  function criticalCard(tools) {
    const list = [];
    for (const t of tools) for (const f of t.openList) if (kindSev(f.kind) === "crit") list.push([f, t.id]);
    if (!list.length) return "";
    list.sort((a, b) => String(a[0].firstSeen || "").localeCompare(String(b[0].firstSeen || "")));
    const rows = list.slice(0, LIST_ROWS).map(([f, id]) => [
      `<div class="name-cell"><div class="primary">${esc(f.name || "")}</div><div class="secondary">${kindBadge(f.kind)} ${esc(TOOL_BY_ID[id] ? TOOL_BY_ID[id].label : id)}</div></div>`,
      subCell(f),
      `<span class="detail-cell">${esc(f.detail || "")}</span>${controlTags(f)}`,
      `<span class="muted nowrap">${esc(fmt.date(f.firstSeen))}</span>`,
    ]);
    return `<div class="card rp-crit"><div class="card-head"><h2>${icon("alert")} Needs action: critical findings</h2><span class="meta">${fmt.int(list.length)}, oldest first</span></div>
      ${tableHtml([{ label: "What" }, { label: "Subscription" }, { label: "Detail" }, { label: "Open since", cls: "nowrap" }], rows)}
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
    const entries = [...ctl.values()];
    const groups = Object.keys(FRAMEWORKS)
      .map((fw) => [fw, entries.filter((e) => e.c.fw === fw).sort((a, b) => b.crit - a.crit || b.n - a.n)])
      .filter(([, list]) => list.length);
    const rows = groups.flatMap(([fw, list]) => [
      { attrs: 'class="kind-group-head"', cells: [esc(FRAMEWORKS[fw]), "", "", ""] },
      ...list.map((e) => [`<span class="ctl ctl-${esc(e.c.fw)}">${esc(e.c.label)}</span>`, esc(e.c.title), fmt.int(e.n), e.crit ? `<span class="bad">${fmt.int(e.crit)}</span>` : `<span class="muted">0</span>`]),
    ]);
    const body = rows.length ? tableHtml([{ label: "Control" }, { label: "What it asks for" }, { label: "Open", cls: "num" }, { label: "Critical", cls: "num" }], rows) : "";
    return `<div class="card"><div class="card-head"><h2>${icon("policy")} Compliance</h2><span class="meta">controls with open findings</span></div>
      ${body || `<div class="empty-state">No open finding bears on a mapped control.</div>`}
      <div class="note">A pointer, not an audit: a control with no findings is not proven to be met.</div></div>`;
  }

  // Grouped by scan and kind, with a few names each, so a month with hundreds of changes still reads in a glance.
  const EXAMPLES = 4;
  function changeCard(title, cls, tools, pick) {
    let total = 0;
    const rows = [];
    for (const t of tools) {
      const c = pick(t);
      if (!c.total) continue;
      total += c.total;
      // Reports saved before byKind existed are counted from their list.
      const counts = c.byKind || c.list.reduce((o, f) => ((o[f.kind || "other"] = (o[f.kind || "other"] || 0) + 1), o), {});
      const kinds = Object.entries(counts);
      kinds.sort((a, b) => b[1] - a[1]);
      kinds.forEach(([kind, n], i) => {
        const names = c.list.filter((f) => (f.kind || "other") === kind).map((f) => f.name).filter(Boolean);
        const shown = [...new Set(names)].slice(0, EXAMPLES);
        rows.push([
          i === 0 ? `<a href="#/scan/${esc(t.id)}">${esc(TOOL_BY_ID[t.id].label)}</a>` : "",
          kindBadge(kind),
          `<span class="${cls}">${fmt.int(n)}</span>`,
          `<span class="rp-names">${shown.map(esc).join(", ")}${n > shown.length ? ` <span class="muted">and ${fmt.int(n - shown.length)} more</span>` : ""}</span>`,
        ]);
      });
    }
    return `<div class="card rp-change"><div class="card-head"><h2><span class="${cls}">${esc(title)}</span></h2><span class="meta">${fmt.int(total)}</span></div>
      ${rows.length ? tableHtml([{ label: "Scan" }, { label: "Kind" }, { label: "Count", cls: "num" }, { label: "For example" }], rows) : `<div class="empty-state">None.</div>`}</div>`;
  }

  function reset() {
    st.data = {};
  }

  return { show, reset, redraw };
})();
