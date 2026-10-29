"use strict";
/* Compliance page: every control of one framework (NIS2, its Implementing Regulation, NSM or CIS) with what the latest scans say about it, for
   the tenant tab in view. Built from the same tool data as the scan pages (state.tools), so a tenant switch needs no
   reset of its own. Uses esc(), fmt, icon, statTile, tableHtml, kindSev, loadTool, toolState, TOOLS, shownTools, TOOL_BY_ID and
   state from app.js and Compliance / FRAMEWORKS from compliance.js. */
const ComplianceView = (() => {
  const st = { fw: "nis2", built: false };
  const STALE_DAYS = 8;
  const SHORT = { nis2: "NIS2", ir: "NIS2 IR", nsm: "NSM", cis: "CIS" };
  const NOTES = {
    nis2: "NIS2 Article 21(2) lists the measures an essential or important entity must take. In Norway it is expected to replace the Digital Security Act (the NIS1 law); until then use it as a checklist.",
    ir: "Implementing Regulation (EU) 2024/2690 spells out the NIS2 Article 21(2) measures section by section. It binds cloud, data centre, managed and managed security service providers, DNS, CDNs, online marketplaces, search engines, social networks and trust services; for anyone else it is a detailed checklist for NIS2.",
    nsm: "NSM's ICT security principles are the Norwegian baseline: what the National Security Authority expects of public bodies, municipalities included, and what auditors often check against. Principle 2.6.7 is MFA.",
    cis: "CIS Controls v8.1 safeguards that the scans can see. Many safeguards (training, physical, endpoint) are outside what an Azure scan can check and are not listed.",
  };

  function show() {
    const page = $("#page-compliance");
    if (!st.built) {
      page.innerHTML = `
        <div class="page-head">
          <div><h1>Compliance</h1><p class="page-sub">Each control, and what the latest scans found that bears on it. A pointer for an audit, not the audit itself.</p></div>
          <div class="page-actions no-print">
            <div class="seg" id="cp-fw" role="tablist">${Object.entries(FRAMEWORKS).map(([k, v]) => `<button data-fw="${k}" title="${esc(v)}">${esc(SHORT[k] || k.toUpperCase())}</button>`).join("")}</div>
            <button class="btn" id="cp-print">${icon("print")} Print / PDF</button>
          </div>
        </div>
        <div id="cp-body"></div>`;
      $("#cp-fw").addEventListener("click", (e) => {
        const b = e.target.closest("button[data-fw]");
        if (!b) return;
        st.fw = b.dataset.fw;
        draw();
      });
      $("#cp-print").addEventListener("click", () => window.print());
      st.built = true;
    }
    draw();
    Promise.all(shownTools().map((t) => loadTool(t.id))).then(() => {
      if (state.route === "compliance") draw();
    });
  }

  // One row per control: { c, status, open, crit, tools: [{tool, t}], ran, ranAt (the oldest covering run), partial }
  function rows() {
    const cover = Compliance.coverage();
    return Compliance.controlsOf(st.fw).map((c) => {
      const tools = (cover[c.id] || []).filter((id) => TOOL_BY_ID[id]).map((id) => ({ tool: TOOL_BY_ID[id], t: toolState(id) }));
      let open = 0, crit = 0, ranAt = null, ran = 0, partial = false;
      for (const { t } of tools) {
        if (!t.loaded) continue;
        if (t.data.ranAt && !t.error) {
          ran++;
          if (!ranAt || t.data.ranAt < ranAt) ranAt = t.data.ranAt;
        }
        if (t.error || Object.keys(t.tenantErrors || {}).length || t.data.findings.some((f) => f.kind === "scan-error")) partial = true;
        for (const f of t.data.findings) {
          if (!Compliance.of(f).some((x) => x.id === c.id)) continue;
          open++;
          if (kindSev(f.kind) === "crit") crit++;
        }
      }
      const loading = tools.some(({ t }) => !t.loaded);
      const status = !tools.length ? "manual" : crit ? "crit" : open ? "open" : ran ? "clear" : loading ? "loading" : "notrun";
      return { c, status, open, crit, tools, ran, ranAt, partial };
    });
  }

  const STATUS = {
    crit: ["Critical findings", "k-crit"],
    open: ["Findings", "k-warn"],
    clear: ["No findings", "k-good"],
    notrun: ["Not run yet", ""],
    loading: ["Loading…", ""],
    manual: ["Check by hand", ""],
  };
  function statusCell(r) {
    const [label, cls] = STATUS[r.status];
    return `<span class="kind${cls ? " " + cls : ""}">${esc(label)}</span>`;
  }
  function toolsCell(r) {
    if (!r.tools.length) return `<span class="muted small">${esc(Compliance.MANUAL[r.c.id] || "Not something a scan can see")}</span>`;
    return `<div class="cp-tools">${r.tools
      .map(({ tool, t }) => {
        const warn = t.error ? "The scan could not be loaded" : !t.data.ranAt && t.loaded ? "Never run" : "";
        return `<a href="#/scan/${esc(tool.id)}"${warn ? ` class="muted" title="${esc(warn)}"` : ""}>${esc(tool.label)}</a>`;
      })
      .join("")}</div>`;
  }
  function checkedCell(r) {
    if (!r.ranAt) return `<span class="muted">–</span>`;
    const old = Date.now() - Date.parse(r.ranAt) > STALE_DAYS * 86400000;
    const runs = r.tools.filter(({ t }) => t.data.ranAt && !t.error).map(({ tool, t }) => `${tool.label}: ${fmt.dateTime(t.data.ranAt)}`).join("\n");
    const parts = [`<span class="${old ? "warn-text" : "muted"} nowrap" title="${esc(runs)}">${old && r.ran > 1 ? "oldest " : ""}${esc(fmt.rel(r.ranAt))}</span>`];
    if (r.ran < r.tools.length) parts.push(`<span class="muted small nowrap">${r.ran} of ${r.tools.length} scans ran</span>`);
    if (r.partial) parts.push(`<span class="warn-text small nowrap" title="A scan had errors or could not reach every tenant or subscription">partly checked</span>`);
    return parts.join("<br>");
  }

  function draw() {
    $$("#cp-fw button").forEach((b) => {
      b.classList.toggle("active", b.dataset.fw === st.fw);
      b.setAttribute("aria-selected", b.dataset.fw === st.fw);
    });
    const list = rows();
    const n = (s) => list.filter((r) => s.includes(r.status)).length;
    const scope = multiView() ? "all tenants you can see" : (tenantList().find((t) => t.key === state.tenant) || {}).name || "this tenant";
    $("#cp-body").innerHTML = `
      <div class="report-title cp-title"><span class="rt-who">${esc(FRAMEWORKS[st.fw])}</span><span class="rt-when">${esc(scope)} · ${esc(fmt.dateTime(new Date().toISOString()))}</span></div>
      <div class="stat-row">
        ${statTile({ label: "Critical findings", value: fmt.int(n(["crit"])), delta: "controls", deltaCls: n(["crit"]) ? "bad" : "" })}
        ${statTile({ label: "With findings", value: fmt.int(n(["open"])), delta: "controls" })}
        ${statTile({ label: "No findings", value: fmt.int(n(["clear"])), delta: "controls", deltaCls: "good" })}
        ${statTile({ label: "Not run yet", value: fmt.int(n(["notrun", "loading"])), delta: "controls" })}
        ${statTile({ label: "Check by hand", value: fmt.int(n(["manual"])), delta: "controls the scans cannot see" })}
      </div>
      <div class="card">
        ${tableHtml(
          [{ label: "Control", cls: "nowrap" }, { label: "What it asks for" }, { label: "Status" }, { label: "Open", cls: "num" }, { label: "Checked by" }, { label: "Last checked" }],
          list.map((r) => [
            `<span class="ctl ctl-${esc(r.c.fw)}">${esc(r.c.label)}</span>`,
            esc(r.c.title) + (r.tools.length && Compliance.MANUAL[r.c.id] ? `<div class="muted small">By hand: ${esc(Compliance.MANUAL[r.c.id])}</div>` : ""),
            statusCell(r),
            r.tools.length ? (r.crit ? `<span class="bad">${fmt.int(r.open)}</span>` : fmt.int(r.open)) : `<span class="muted">–</span>`,
            toolsCell(r),
            r.tools.length ? checkedCell(r) : "",
          ])
        )}
        <div class="note">${esc(NOTES[st.fw])} "No findings" means the scans that look at a control found nothing in the latest run; it does not prove the control is met. Accepted findings are left out.</div>
        ${sourceNote()}
      </div>`;
  }

  // Which text the mapping follows and when it was last checked against it.
  function sourceNote() {
    const info = Compliance.FRAMEWORK_INFO[st.fw];
    if (!info) return "";
    return `<div class="note cp-source">Mapped against <a href="${esc(info.url)}" target="_blank" rel="noopener">${esc(info.source)}</a> · mapping reviewed ${esc(fmt.date(info.reviewed))}</div>`;
  }

  return { show };
})();
