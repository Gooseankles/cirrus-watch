"use strict";
/* Azure Virtual Desktop scan page: the findings, and every host pool with its session hosts, scaling plan and
   workspaces (Host pools). The list comes from /api/avd, saved by the last scan, which also names the tenants with
   no host pools at all (those are skipped). Uses app.js helpers. */
(() => {
  const ID = "avd";
  const VIEW_LABELS = [["findings", "Findings"], ["pools", "Host pools"]];
  const viewOf = (t) => (VIEW_LABELS.some(([k]) => k !== "findings" && k === t.filters.view) ? t.filters.view : "findings");
  const rerender = () => {
    if (state.route === `scan/${ID}`) renderFindings(ID);
  };

  function inventory(t) {
    if (t.avd && t.avd.ranAt === t.data.ranAt) return t.avd;
    if (!t.avdLoading) {
      const ranAt = t.data.ranAt;
      t.avdLoading = apiJson("/api/avd")
        .then((data) => (t.avd = { ranAt, data }))
        .catch((err) => (t.avd = { ranAt, error: err.message }))
        .finally(() => {
          t.avdLoading = null;
          rerender();
        });
    }
    return null;
  }

  const span = (cls, text) => `<span class="${cls}">${esc(text)}</span>`;

  function extra(all, t) {
    const v = viewOf(t);
    for (const sel of ["#scan-fw", "#scan-new"]) $(sel).classList.toggle("hidden", v !== "findings");
    $("#scan-q").placeholder = v === "findings" ? "Search name, detail, subscription" : "Search host pool, resource group, subscription";
    const inv = inventory(t);
    const none = inv && inv.data ? inv.data.none : [];
    const note = none.length ? `<div class="note">No Azure Virtual Desktop in ${esc(none.map((o) => o.name).join(", "))}: no host pools found, nothing to check.</div>` : "";
    return `<div class="seg">${VIEW_LABELS.map(([k, label]) => `<button type="button" data-view="${k}" class="${v === k ? "active" : ""}">${label}${k === "findings" ? ` <span class="n">${fmt.int(all.length)}</span>` : ""}</button>`).join("")}</div>${note}`;
  }

  function pools(t) {
    const inv = inventory(t);
    if (!inv) return `<div class="empty-state">Loading the host pools…</div>`;
    if (inv.error) return `<div class="empty-state">Could not load the host pools: ${esc(inv.error)}</div>`;
    const d = inv.data;
    if (!d.pools.length) return `<div class="empty-state">${d.updatedAt ? "No Azure Virtual Desktop host pools found." : "No host pool list yet; it is saved by the next scan."}</div>`;
    const q = t.filters.q;
    const sub = t.filters.sub;
    const list = d.pools
      .filter((p) => (!sub || p.subscriptionId === sub) && (!q || [p.name, p.type, p.resourceGroup, p.subscriptionName, p.subscriptionId, p.tenantName, p.scalingPlan, ...p.appGroups, ...p.workspaces].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => a.available / (a.hosts || 1) - b.available / (b.hosts || 1) || String(a.name).localeCompare(String(b.name)));
    const rows = list.slice(0, t.shown).map((p) => [
      nameCell(p, null, `${p.type}${p.location ? " · " + p.location : ""}${p.resourceGroup ? " · rg " + p.resourceGroup : ""}`),
      subCell(p),
      !p.checked ? span("muted", "not read") : !p.hosts ? span("warn", "none") : `<span class="${p.available < p.hosts ? "warn" : "good"}">${fmt.int(p.available)} of ${fmt.int(p.hosts)} available</span>${p.draining ? `<div class="secondary">${fmt.int(p.draining)} in drain mode</div>` : ""}`,
      p.checked ? fmt.int(p.sessions) : span("muted", "–"),
      p.scalingPlan ? esc(p.scalingPlan) : span(p.type === "Pooled" ? "warn" : "muted", "none"),
      p.startOnConnect ? span("good", "On") : span("muted", "Off"),
      p.workspaces.length ? esc(p.workspaces.join(", ")) : span("warn", "none"),
    ]);
    return tableHtml([{ label: "Host pool" }, { label: "Subscription" }, { label: "Session hosts" }, { label: "Sessions" }, { label: "Scaling plan" }, { label: "Start VM on Connect" }, { label: "Workspaces" }], rows) +
      moreButton(Math.min(list.length, t.shown), list.length, t);
  }

  function page(all, t) {
    return viewOf(t) === "pools" ? pools(t) : null;
  }

  VIEWS[ID] = { stats: genericStats, extra, page, showKinds: (t) => viewOf(t) === "findings", body: genericBody };
})();
