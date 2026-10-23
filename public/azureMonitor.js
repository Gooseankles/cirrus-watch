"use strict";
/* Azure Monitor scan page: the findings, every machine with its agent, collection rules and last heartbeat
   (Machines), and every alert rule with whether it is on and whom it tells (Alert rules). The lists come from
   /api/azure-monitor, saved by the last scan, which also names the tenants where the check is switched off
   (Settings, Azure Monitor). Uses app.js helpers. */
(() => {
  const ID = "azure-monitor";
  const VIEW_LABELS = [["findings", "Findings"], ["machines", "Machines"], ["rules", "Alert rules"]];
  const viewOf = (t) => (VIEW_LABELS.some(([k]) => k !== "findings" && k === t.filters.view) ? t.filters.view : "findings");
  const rerender = () => {
    if (state.route === `scan/${ID}`) renderFindings(ID);
  };

  function inventory(t) {
    if (t.amon && t.amon.ranAt === t.data.ranAt) return t.amon;
    if (!t.amonLoading) {
      const ranAt = t.data.ranAt;
      t.amonLoading = apiJson("/api/azure-monitor")
        .then((data) => (t.amon = { ranAt, data }))
        .catch((err) => (t.amon = { ranAt, error: err.message }))
        .finally(() => {
          t.amonLoading = null;
          rerender();
        });
    }
    return null;
  }

  const state_ = (cls, text) => `<span class="${cls}">${esc(text)}</span>`;
  const agentCell = (m) =>
    m.agent === "ama"
      ? m.agentState && m.agentState.toLowerCase() === "failed" ? state_("bad", "Azure Monitor Agent (failed)") : state_("good", "Azure Monitor Agent")
      : m.agent === "legacy" ? state_("bad", "Legacy agent only") : state_(m.running ? "warn" : "muted", "None");
  function heartbeatCell(m, hours) {
    if (!m.running) return `<span class="muted">–</span>`;
    if (m.agent !== "ama" || !m.rules.length) return `<span class="muted">not collected</span>`;
    if (!m.heartbeatChecked) return `<span class="muted">not checked</span>`;
    if (!m.lastHeartbeat) return state_("bad", "none in 7 days");
    const late = (Date.now() - Date.parse(m.lastHeartbeat)) / 3600000 > hours;
    return `<span class="${late ? "bad" : "good"}" title="${esc(m.lastHeartbeat)}">${esc(fmt.rel(m.lastHeartbeat))}</span>`;
  }
  // Worst first: what needs a look comes to the top.
  function machineRank(m, hours) {
    if (!m.running) return m.kind === "Arc" ? 1 : 6;
    if (m.agent !== "ama" || (m.agentState || "").toLowerCase() === "failed" || !m.rules.length) return 2;
    if (m.heartbeatChecked && (!m.lastHeartbeat || (Date.now() - Date.parse(m.lastHeartbeat)) / 3600000 > hours)) return 0;
    return 5;
  }

  function extra(all, t) {
    const v = viewOf(t);
    for (const sel of ["#scan-fw", "#scan-new"]) $(sel).classList.toggle("hidden", v !== "findings");
    $("#scan-q").placeholder = v === "findings" ? "Search name, detail, subscription" : "Search name, resource group, subscription";
    const inv = inventory(t);
    const off = inv && inv.data ? inv.data.off : [];
    const note = off.length
      ? `<div class="note">Not checked in ${esc(off.map((o) => o.name).join(", "))}: set to not using Azure Monitor (Settings, Azure Monitor).</div>`
      : "";
    return `<div class="seg">${VIEW_LABELS.map(([k, label]) => `<button type="button" data-view="${k}" class="${v === k ? "active" : ""}">${label}${k === "findings" ? ` <span class="n">${fmt.int(all.length)}</span>` : ""}</button>`).join("")}</div>${note}`;
  }

  function filtered(list, t, fields) {
    const q = t.filters.q;
    const sub = t.filters.sub;
    return list.filter((x) => (!sub || x.subscriptionId === sub) && (!q || fields(x).join(" ").toLowerCase().includes(q)));
  }

  function machines(t) {
    const inv = inventory(t);
    if (!inv) return `<div class="empty-state">Loading the machine list…</div>`;
    if (inv.error) return `<div class="empty-state">Could not load the machine list: ${esc(inv.error)}</div>`;
    const d = inv.data;
    if (!d.machines.length) return `<div class="empty-state">${d.updatedAt ? "No VMs or Arc servers found." : "No machine list yet; it is saved by the next scan."}</div>`;
    const hours = d.heartbeatHours || 2;
    const list = filtered(d.machines, t, (m) => [m.name, m.resourceGroup, m.subscriptionName, m.subscriptionId, m.tenantName, ...m.rules, ...m.workspaces])
      .sort((a, b) => machineRank(a, hours) - machineRank(b, hours) || String(a.name).localeCompare(String(b.name)));
    const watched = d.machines.filter((m) => m.running && m.agent === "ama" && m.rules.length).length;
    const running = d.machines.filter((m) => m.running).length;
    const rows = list.slice(0, t.shown).map((m) => [
      nameCell(m, null, `${m.kind}${m.os ? " · " + m.os : ""}${m.resourceGroup ? " · rg " + m.resourceGroup : ""}`),
      subCell(m),
      m.running ? esc(m.state) : state_(m.kind === "Arc" ? "warn" : "muted", m.state),
      agentCell(m),
      m.rules.length ? `${esc(m.rules.join(", "))}${m.workspaces.length ? `<div class="secondary">to ${esc(m.workspaces.join(", "))}</div>` : ""}` : `<span class="${m.agent === "ama" && m.running ? "warn" : "muted"}">none</span>`,
      heartbeatCell(m, hours),
    ]);
    return `<p class="muted small">${fmt.int(watched)} of ${fmt.int(running)} running machines have the agent and a collection rule. A heartbeat older than ${fmt.int(hours)} h is flagged.</p>` +
      tableHtml([{ label: "Machine" }, { label: "Subscription" }, { label: "State" }, { label: "Agent" }, { label: "Collection rules" }, { label: "Last heartbeat" }], rows) +
      moreButton(Math.min(list.length, t.shown), list.length, t);
  }

  const SEV = ["Critical", "Error", "Warning", "Informational", "Verbose"];
  // Worst first: on but tells nobody, then a missing action group, then fine, then switched off.
  const ruleRank = (r) => (!r.enabled ? 3 : !r.actionGroups.length ? 0 : r.actionGroups.some((g) => /\(missing\)$/.test(g)) ? 1 : 2);
  function rules(t) {
    const inv = inventory(t);
    if (!inv) return `<div class="empty-state">Loading the alert rules…</div>`;
    if (inv.error) return `<div class="empty-state">Could not load the alert rules: ${esc(inv.error)}</div>`;
    const d = inv.data;
    if (!d.rules.length) return `<div class="empty-state">${d.updatedAt ? "No alert rules found." : "No alert rule list yet; it is saved by the next scan."}</div>`;
    const list = filtered(d.rules, t, (r) => [r.name, r.kind, r.resourceGroup, r.subscriptionName, r.subscriptionId, r.tenantName, ...r.actionGroups, ...r.scopes])
      .sort((a, b) => ruleRank(a) - ruleRank(b) || String(a.name).localeCompare(String(b.name)));
    const rows = list.slice(0, t.shown).map((r) => [
      nameCell(r, null, `${r.kind}${r.severity != null && SEV[r.severity] ? " · Sev " + r.severity + " " + SEV[r.severity] : ""}`),
      subCell(r),
      r.enabled ? state_("good", "On") : state_("muted", "Off"),
      r.actionGroups.length ? r.actionGroups.map((g) => `<span class="tag${/\(missing\)$/.test(g) ? " bad" : ""}">${esc(g)}</span>`).join(" ") : state_(r.enabled ? "warn" : "muted", "nobody"),
      `<span class="small">${esc(r.scopes.slice(0, 3).join(", "))}${r.scopes.length > 3 ? ` <span class="muted">+${r.scopes.length - 3}</span>` : ""}</span>`,
    ]);
    const on = d.rules.filter((r) => r.enabled).length;
    return `<p class="muted small">${fmt.int(on)} of ${fmt.int(d.rules.length)} alert rules are on.</p>` +
      tableHtml([{ label: "Alert rule" }, { label: "Subscription" }, { label: "State" }, { label: "Tells" }, { label: "Watches" }], rows) +
      moreButton(Math.min(list.length, t.shown), list.length, t);
  }

  function page(all, t) {
    const v = viewOf(t);
    if (v === "machines") return machines(t);
    if (v === "rules") return rules(t);
    return null;
  }

  VIEWS[ID] = { stats: genericStats, extra, page, showKinds: (t) => viewOf(t) === "findings", body: genericBody };
})();
