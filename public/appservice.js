"use strict";
/* App Service usage scan page: the findings, and every App Service plan with its CPU and memory over the last
   7 days (Plans). The usage comes from /api/app-service-usage, saved by the last scan. Uses app.js helpers. */
(() => {
  const ID = "app-service-usage";
  const VIEW_LABELS = [["findings", "Findings"], ["plans", "Plans"]];
  const NO_METRICS = /^(free|shared|dynamic|flexconsumption)$/i;
  const viewOf = (t) => (t.filters.view === "plans" ? "plans" : "findings");
  const rerender = () => {
    if (state.route === `scan/${ID}`) renderFindings(ID);
  };

  /* data: loaded once per scan run (and again after a tenant tab change, which clears the tool state) */
  function usage(t) {
    if (t.asUsage && t.asUsage.ranAt === t.data.ranAt) return t.asUsage;
    if (!t.asLoading) {
      const ranAt = t.data.ranAt;
      t.asLoading = apiJson("/api/app-service-usage")
        .then((data) => (t.asUsage = { ranAt, data }))
        .catch((err) => (t.asUsage = { ranAt, error: err.message }))
        .finally(() => {
          t.asLoading = null;
          rerender();
        });
    }
    return null;
  }

  /* small parts */
  const level = (v, warn) => (v >= warn ? " crit" : v >= warn * 0.8 ? " warn" : "");
  function spark(hourly, warn) {
    const pts = (hourly || []).map((v, i) => [i, v]).filter(([, v]) => v != null);
    if (pts.length < 2) return "";
    const w = 150, h = 24, n = Math.max(1, hourly.length - 1);
    const xy = ([i, v]) => `${((i / n) * w).toFixed(1)},${(h - 1 - (Math.min(100, v) / 100) * (h - 2)).toFixed(1)}`;
    const wy = (h - 1 - (warn / 100) * (h - 2)).toFixed(1);
    const top = Math.max(...pts.map(([, v]) => v));
    return `<svg class="as-spark${level(top, warn)}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="${wy}" x2="${w}" y2="${wy}"/><polyline points="${pts.map(xy).join(" ")}"/></svg>`;
  }
  function meter(s, warn, plan) {
    if (NO_METRICS.test(plan.tier || "")) return `<span class="muted small">not measured on ${esc(plan.tier)}</span>`;
    if (!plan.apps) return `<span class="muted small">no apps</span>`;
    if (!s) return `<span class="muted small">no data</span>`;
    const avg = Math.min(100, s.avg);
    return `<div class="as-use"><div class="ip-bar${level(s.p95, warn)}" title="Average over ${fmt.int(s.hours)} hours"><span style="width:${avg.toFixed(1)}%"></span></div>${spark(s.hourly, warn)}<span class="small"><b>${Math.round(s.avg)}%</b> avg <span class="muted">· p95 ${Math.round(s.p95)}% · peak ${Math.round(s.peak)}%</span></span></div>`;
  }
  const sizeText = (p) => `${p.workers > 1 ? `${fmt.int(p.workers)} × ` : ""}${p.sku || "?"}`;
  const top = (p) => Math.max(p.cpu ? p.cpu.p95 : -1, p.memory ? p.memory.p95 : -1);
  const loading = () => `<div class="empty-state">Loading the plans…</div>`;
  const noUsage = () =>
    `<div class="empty-state big"><h3>No plan usage yet</h3><p>The usage is saved by each scan. Run the scan once${canRun() ? " (Run now above)" : ""} and the plans show here.</p></div>`;

  /* stats: the plan picture when the usage is in, else the usual counts */
  function stats(all, t) {
    const u = usage(t);
    if (!u || !u.data || !u.data.plans.length) return genericStats(all, t);
    const p = u.data.plans;
    const instances = p.reduce((n, x) => n + (x.workers || 1), 0);
    const apps = p.reduce((n, x) => n + (x.apps || 0), 0);
    const n = (k) => all.filter((f) => f.kind === k).length;
    const hot = new Set(all.filter((f) => f.kind === "appservice-cpu-high" || f.kind === "appservice-memory-high").map((f) => f.id.split("#")[0])).size;
    const measured = p.filter((x) => x.cpu);
    const avgCpu = measured.length ? Math.round(measured.reduce((s, x) => s + x.cpu.avg, 0) / measured.length) : null;
    return (
      statTile({ label: "App Service plans", value: fmt.int(p.length), delta: `${fmt.int(instances)} instances · ${fmt.int(apps)} apps` }) +
      statTile({ label: "Average CPU", value: avgCpu == null ? "–" : `${avgCpu}%`, delta: measured.length ? `across ${fmt.int(measured.length)} measured plans` : "" }) +
      statTile({ label: "Running hot", value: fmt.int(hot), deltaCls: hot ? "bad" : "", delta: hot ? "CPU or memory" : "" }) +
      statTile({ label: "Bigger than needed", value: fmt.int(n("appservice-plan-oversized")) }) +
      statTile({ label: "Plans with no apps", value: fmt.int(n("appservice-plan-empty")), deltaCls: n("appservice-plan-empty") ? "bad" : "" })
    );
  }

  function extra(all, t) {
    const v = viewOf(t);
    for (const sel of ["#scan-sub", "#scan-fw", "#scan-new"]) $(sel).classList.toggle("hidden", v !== "findings");
    $("#scan-q").placeholder = v === "plans" ? "Search plan, size, app or subscription" : "Search name, detail, subscription";
    return `<div class="seg">${VIEW_LABELS.map(([k, label]) => `<button type="button" data-view="${k}" class="${v === k ? "active" : ""}">${label}${k === "findings" ? ` <span class="n">${fmt.int(all.length)}</span>` : ""}</button>`).join("")}</div>`;
  }

  /* Plans: one row per plan, busiest first, opened to show its apps */
  function plans(t) {
    const u = usage(t);
    if (!u) return loading();
    if (u.error) return `<div class="empty-state big"><h3>Could not load the plan usage</h3><p class="muted">${esc(u.error)}</p></div>`;
    const d = u.data;
    if (!d.updatedAt) return noUsage();
    const cpuWarn = d.cpuWarn || 80, memWarn = d.memoryWarn || 85;
    const q = t.filters.q;
    const match = (p) => !q || [p.name, p.resourceGroup, p.subscriptionName, p.subscriptionId, p.tenantName, p.location, p.sku, p.tier, p.os, ...(p.appNames || [])].join(" ").toLowerCase().includes(q);
    const list = d.plans.filter(match).sort((a, b) => top(b) - top(a) || String(a.name).localeCompare(String(b.name)));
    const slice = list.slice(0, t.shown);
    const rows = slice.map((p) => {
      const key = `as:${p.id}`;
      const open = t.open.has(key);
      const size = `<b>${esc(sizeText(p))}</b><div class="secondary">${esc([p.tier, p.os, p.zoneRedundant ? "zone redundant" : ""].filter(Boolean).join(" · "))}</div>`;
      const toggle = p.apps
        ? `<button type="button" class="chip nowrap${open ? " active" : ""}" data-toggle="${esc(key)}">${icon("chevron")} ${fmt.int(p.apps)} app${p.apps === 1 ? "" : "s"}</button>`
        : `<span class="muted small">no apps</span>`;
      const main = `<tr>${[nameCell(p, null, `${p.location || ""}${p.resourceGroup ? " · rg " + p.resourceGroup : ""}`), subCell(p), size, meter(p.cpu, cpuWarn, p), meter(p.memory, memWarn, p), toggle].map((c) => `<td>${c}</td>`).join("")}</tr>`;
      const names = (p.appNames || []).map((n) => `<span class="tag">${esc(n)}</span>`).join("");
      const more = p.apps > (p.appNames || []).length ? `<span class="muted small">and ${fmt.int(p.apps - p.appNames.length)} more</span>` : "";
      return main + (p.apps ? `<tr class="ar-members-row${open ? "" : " hidden"}" data-members="${esc(key)}"><td colspan="6"><div class="as-apps">${names}${more}</div></td></tr>` : "");
    });
    const head = ["Plan", "Subscription", "Size", "CPU", "Memory", ""];
    const table = list.length
      ? `<div class="table-wrap"><table class="data"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` + moreButton(slice.length, list.length, t)
      : `<div class="empty-state">${d.plans.length ? "No plans match the search." : "No App Service plans found."}</div>`;
    const note = `<div class="note">Saved by the scan ${esc(fmt.rel(d.updatedAt))}. Hourly averages over the last ${fmt.int(d.days || 7)} days, across all instances of a plan; the dashed line is the warning level (CPU ${cpuWarn}%, memory ${memWarn}%). p95: 95% of hours were at or below it. Free, Shared and Consumption plans report no CPU or memory.</div>`;
    return table + note;
  }

  function page(all, t) {
    return viewOf(t) === "plans" ? plans(t) : null;
  }

  VIEWS[ID] = { stats, extra, page, showKinds: (t) => viewOf(t) === "findings", body: genericBody };
})();
