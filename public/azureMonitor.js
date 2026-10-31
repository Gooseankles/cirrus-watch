"use strict";
/* Azure Monitor scan page: coverage counts at the top (machines monitored, alert coverage, alert rules on), the findings, every machine with its agent,
   collection rules, destination workspace (and whether a log alert reads it) and last heartbeat (Machines), and every alert rule with whether it is on and whom it tells (Alert rules). The lists come from
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
  // Where its data goes, and whether a log alert reads it (m.alert is missing in an inventory from before that was judged).
  const short = (s, n = 24) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  function workspaceCell(m) {
    const list = m.workspaces || [];
    if (!list.length) return `<span class="muted">–</span>`;
    const read = new Set(m.alertWorkspaces || []);
    const tags = list.slice(0, 2).map((w) => `<span class="tag${read.has(w) ? " good" : m.alert === "none" ? " warn" : ""}" title="${esc(w)}">${esc(short(w))}</span>`).join(" ");
    const more = list.length > 2 ? ` <span class="muted small">+${list.length - 2}</span>` : "";
    const note = m.alert === "workspace" ? state_("good", "a log alert reads it") : m.alert === "scope" ? state_("good", "log alert on its scope") : m.alert === "none" ? state_("warn", "no log alert reads it") : "";
    return `${tags}${more}${note ? `<div class="secondary">${note}</div>` : ""}`;
  }
  // Worst first: what needs a look comes to the top.
  function machineRank(m, hours) {
    if (!m.running) return m.kind === "Arc" ? 1 : 6;
    if (m.agent !== "ama" || (m.agentState || "").toLowerCase() === "failed" || !m.rules.length) return 2;
    if (m.heartbeatChecked && (!m.lastHeartbeat || (Date.now() - Date.parse(m.lastHeartbeat)) / 3600000 > hours)) return 0;
    if (m.alert === "none") return 3;
    return 5;
  }
  // Which workspaces the alerts read, per tenant in view: from Settings or from the log alert rules.
  function alertLine(d) {
    const list = d.alertWorkspaces || [];
    if (!list.length) return "";
    const one = (a) => {
      const names = (a.names || []).slice(0, 4).join(", ") + ((a.names || []).length > 4 ? ", …" : "");
      const where = a.source === "setting" ? `log alerts read ${names} (set in Settings)` : a.source === "rules" ? (names ? `log alert rules read ${names}` : "log alert rules read only their own scopes") : "no enabled log alert rule";
      return list.length > 1 ? `${a.name}: ${where}` : where.charAt(0).toUpperCase() + where.slice(1);
    };
    return ` ${esc(list.map(one).join("; "))}.`;
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
    const list = filtered(d.machines, t, (m) => [m.name, m.resourceGroup, m.subscriptionName, m.subscriptionId, m.tenantName, ...m.rules, ...(m.workspaces || [])])
      .sort((a, b) => machineRank(a, hours) - machineRank(b, hours) || String(a.name).localeCompare(String(b.name)));
    const watched = d.machines.filter((m) => m.running && m.agent === "ama" && m.rules.length).length;
    const running = d.machines.filter((m) => m.running).length;
    const rows = list.slice(0, t.shown).map((m) => [
      nameCell(m, null, `${m.kind}${m.os ? " · " + m.os : ""}${m.resourceGroup ? " · rg " + m.resourceGroup : ""}`),
      subCell(m),
      m.running ? esc(m.state) : state_(m.kind === "Arc" ? "warn" : "muted", m.state),
      agentCell(m),
      m.rules.length ? esc(m.rules.join(", ")) : `<span class="${m.agent === "ama" && m.running ? "warn" : "muted"}">none</span>`,
      workspaceCell(m),
      heartbeatCell(m, hours),
    ]);
    return `<p class="muted small">${fmt.int(watched)} of ${fmt.int(running)} running machines have the agent and a collection rule. A heartbeat older than ${fmt.int(hours)} h is flagged.${alertLine(d)}</p>` +
      tableHtml([{ label: "Machine" }, { label: "Subscription" }, { label: "State" }, { label: "Agent" }, { label: "Collection rules" }, { label: "Workspace" }, { label: "Last heartbeat" }], rows) +
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

  // One row of counts: findings, then what is monitored, from the summary the scan saved
  // (added up over the tenants in view). Until the inventory loads, or with none, the usual tiles.
  const MISSING = [["noAgent", "no agent"], ["legacy", "legacy agent"], ["agentFailed", "agent failed"], ["noDcr", "no collection rule"], ["noHeartbeat", "no heartbeat"], ["disconnected", "disconnected"]];
  function coverTile(label, c) {
    const gaps = MISSING.filter(([k]) => c[k]).map(([k, text]) => `${fmt.int(c[k])} ${text}`);
    return statTile({
      label,
      value: `${fmt.int(c.monitored)} / ${fmt.int(c.total)}`,
      delta: !c.total ? "none found" : gaps.length ? gaps.join(" · ") : "all monitored",
      deltaCls: gaps.length ? "bad" : c.total ? "good" : "",
    });
  }
  function stats(all, t) {
    const inv = inventory(t);
    const s = inv && inv.data && inv.data.summary;
    if (!s) return genericStats(all, t);
    const last = t.history[t.history.length - 1];
    const tiles = [statTile({ label: "Open findings", value: fmt.int(all.length), delta: last ? `+${fmt.int(last.added)} new · −${fmt.int(last.resolved)} resolved` : "" })];
    if (s.vms) tiles.push(coverTile("Virtual machines monitored", s.vms));
    if (s.arc && s.arc.total) tiles.push(coverTile("Arc servers monitored", s.arc));
    if (s.scaleSets && s.scaleSets.total) tiles.push(coverTile("Scale sets monitored", s.scaleSets));
    // Machines whose data an enabled log alert reads (left out for an inventory from before this was counted).
    const ac = s.alertCoverage;
    if (ac && ac.total) {
      const gaps = [[ac.notAlerted, "to a workspace no log alert reads"], [ac.noData, "send no logs"]].filter(([n]) => n).map(([n, text]) => `${fmt.int(n)} ${text}`);
      tiles.push(statTile({ label: "Alert coverage", value: `${fmt.int(ac.covered)} / ${fmt.int(ac.total)}`, delta: gaps.length ? gaps.join(" · ") : "every machine's data reaches a log alert", deltaCls: ac.notAlerted ? "bad" : gaps.length ? "" : "good" }));
    }
    if (s.alertRules) {
      const off = s.alertRules.total - s.alertRules.enabled;
      tiles.push(statTile({ label: "Alert rules on", value: `${fmt.int(s.alertRules.enabled)} / ${fmt.int(s.alertRules.total)}`, delta: off ? `${fmt.int(off)} off` : s.alertRules.total ? "all on" : "none found", deltaCls: off ? "bad" : "" }));
    }
    if (s.dataCollectionRules != null) {
      const more = [[s.actionGroups, "action group"], [s.workspaces, "workspace"]].filter(([n]) => n != null).map(([n, w]) => `${fmt.int(n)} ${w}${n === 1 ? "" : "s"}`);
      tiles.push(statTile({ label: "Data collection rules", value: fmt.int(s.dataCollectionRules), delta: more.join(" · ") }));
    }
    return tiles.join("");
  }

  function page(all, t) {
    const v = viewOf(t);
    if (v === "machines") return machines(t);
    if (v === "rules") return rules(t);
    return null;
  }

  VIEWS[ID] = { stats, extra, page, showKinds: (t) => viewOf(t) === "findings", body: genericBody };
})();
