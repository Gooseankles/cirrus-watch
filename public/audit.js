"use strict";
/* Audit log page (Admin): who signed in, looked at which scan, report or cost page, searched whom in Access
   lookup and changed what. GET /api/audit. Uses esc(), fmt, statTile, tableHtml, apiJson, icon, setStatus,
   state and TOOL_BY_ID from app.js. */
const Audit = (() => {
  const st = { data: null, loading: false, error: null, built: false, f: { user: "", action: "", since: "", q: "", changes: false } };

  const LABELS = {
    "sign-in": "Signed in",
    "sign-out": "Signed out",
    "sign-in-refused": "Sign-in refused",
    "sign-in-failed": "Wrong password",
    "view-page": "Opened",
    "view-past-run": "Viewed past run",
    "view-cost": "Viewed cost history",
    "access-lookup": "Looked up access of",
    "run-scan": "Ran scan",
    "refresh-cost": "Refreshed cost history",
    "accept-finding": "Accepted finding",
    "snooze-finding": "Snoozed finding",
    "reopen-finding": "Reopened finding",
    "change-settings": "Changed settings",
    "test-spn": "Tested SPN",
    "save-tenant": "Saved customer tenant",
    "delete-tenant": "Removed customer tenant",
    "test-tenant": "Tested customer tenant",
  };
  const CHANGES = new Set(["run-scan", "refresh-cost", "accept-finding", "snooze-finding", "reopen-finding", "change-settings", "save-tenant", "delete-tenant"]);
  const SIGNIN = new Set(["sign-in", "sign-out", "sign-in-refused", "sign-in-failed"]);
  const label = (a) => LABELS[a] || a;
  const PAGES = { overview: "Overview", lookup: "Access lookup", report: "Monthly report", cost: "Cost history", audit: "Audit log", load: "Server load", settings: "Settings" };
  function target(e) {
    const t = e.target || "";
    if (e.action === "view-page") {
      const [page, arg] = t.split("/");
      if (page === "scan") return TOOL_BY_ID[arg] ? TOOL_BY_ID[arg].label : arg;
      return page === "report" && arg ? `Monthly report ${arg}` : PAGES[page] || t;
    }
    return /scan|finding|past-run/.test(e.action || "") && TOOL_BY_ID[t] ? TOOL_BY_ID[t].label : t;
  }
  const refused = (e) => (e.status && e.status >= 400) || e.action === "sign-in-refused" || e.action === "sign-in-failed";

  async function load() {
    st.loading = true;
    const p = new URLSearchParams({ limit: "2000" });
    if (st.f.user) p.set("user", st.f.user);
    if (st.f.action) p.set("action", st.f.action);
    if (st.f.since) p.set("since", st.f.since);
    try {
      st.data = await apiJson(`/api/audit?${p}`);
      st.error = null;
    } catch (err) {
      st.error = err.message;
    }
    st.loading = false;
    if (state.route === "audit") render();
  }

  function show() {
    const page = $("#page-audit");
    if (!st.built) {
      page.innerHTML = `
        <div class="page-head">
          <div><h1>Audit log</h1><p class="page-sub">Who signed in, which scans, reports and cost pages they looked at, whom they searched for in Access lookup and what they changed. Opening the same page again within ten minutes counts once. Only admins see this.</p></div>
          <div class="page-actions"><button class="btn" id="act-refresh">${icon("refresh")} Refresh</button></div>
        </div>
        <div class="status-msg" id="act-status"></div>
        <div class="stat-row" id="act-stats"></div>
        <div class="card">
          <div class="card-head">
            <h2>Events <span class="meta" id="act-count"></span></h2>
            <div class="card-tools">
              <input class="input search" id="act-q" type="search" placeholder="Search person, page, detail" />
              <select class="select" id="act-user"><option value="">Everyone</option></select>
              <select class="select" id="act-action"><option value="">Every action</option></select>
              <input class="input" id="act-since" type="date" title="From this day" />
              <button class="chip" id="act-changes">${icon("alert")} Changes only</button>
            </div>
          </div>
          <div id="act-body"></div>
        </div>`;
      $("#act-refresh").addEventListener("click", load);
      $("#act-q").addEventListener("input", (e) => { st.f.q = e.target.value.trim().toLowerCase(); render(); });
      $("#act-user").addEventListener("change", (e) => { st.f.user = e.target.value; load(); });
      $("#act-action").addEventListener("change", (e) => { st.f.action = e.target.value; load(); });
      $("#act-since").addEventListener("change", (e) => { st.f.since = e.target.value; load(); });
      $("#act-changes").addEventListener("click", () => { st.f.changes = !st.f.changes; render(); });
      st.built = true;
    }
    render();
    load();
  }

  function options(sel, values, all, fmtValue) {
    const cur = sel.value;
    sel.innerHTML = `<option value="">${esc(all)}</option>` + values.map((v) => `<option value="${esc(v)}">${esc(fmtValue ? fmtValue(v) : v)}</option>`).join("");
    sel.value = values.includes(cur) ? cur : "";
  }

  function render() {
    setStatus($("#act-status"), st.error ? `Could not load the audit log: ${st.error}` : "", "error");
    $("#act-changes").classList.toggle("active", st.f.changes);
    if (!st.data) {
      $("#act-body").innerHTML = `<div class="empty-state">${st.loading ? "Loading…" : "Nothing yet."}</div>`;
      return;
    }
    const d = st.data;
    options($("#act-user"), d.users || [], "Everyone");
    options($("#act-action"), d.actions || [], "Every action", label);
    const all = d.entries || [];
    const dayAgo = new Date(Date.now() - 86400000).toISOString();
    const today = all.filter((e) => e.time >= dayAgo);
    $("#act-stats").innerHTML = [
      statTile({ label: "People, last 24 hours", value: fmt.int(new Set(today.filter((e) => e.user).map((e) => e.user)).size) }),
      statTile({ label: "Sign-ins, last 24 hours", value: fmt.int(today.filter((e) => e.action === "sign-in").length) }),
      statTile({ label: "Changes, last 24 hours", value: fmt.int(today.filter((e) => CHANGES.has(e.action)).length) }),
      statTile({ label: "Refused, last 24 hours", value: fmt.int(today.filter(refused).length), deltaCls: "bad", sub: `Kept ${d.retentionDays} days` }),
    ].join("");
    const shown = all.filter((e) => {
      if (st.f.changes && !CHANGES.has(e.action)) return false;
      if (!st.f.q) return true;
      return [e.user, e.name, label(e.action), target(e), e.detail, e.tenant, e.ip].some((x) => x && String(x).toLowerCase().includes(st.f.q));
    });
    $("#act-count").textContent = `${fmt.int(shown.length)} of ${fmt.int(all.length)}`;
    if (!shown.length) {
      $("#act-body").innerHTML = `<div class="empty-state">No events match these filters.</div>`;
      return;
    }
    const cols = [{ label: "When" }, { label: "Who" }, { label: "What" }, { label: "On" }, { label: "Tenant" }, { label: "Result" }];
    const rows = shown.slice(0, 1000).map((e) => {
      const cls = refused(e) ? "denied" : CHANGES.has(e.action) ? "change" : SIGNIN.has(e.action) ? "signin" : "";
      return [
        `<span title="${esc(e.time)}">${esc(fmt.dateTime(e.time))}</span><div class="secondary">${esc(fmt.rel(e.time))}</div>`,
        `<div class="primary">${esc(e.user || "unknown")}</div>${e.name && e.name !== e.user ? `<div class="secondary">${esc(e.name)}</div>` : ""}<div class="secondary">${esc([e.via, e.ip].filter(Boolean).join(" · "))}</div>`,
        `<span class="act-action ${cls}">${esc(label(e.action))}</span>`,
        `<div class="primary">${esc(target(e))}</div>${e.detail ? `<div class="secondary">${esc(e.detail)}</div>` : ""}`,
        esc(e.tenant || ""),
        e.status == null ? "" : refused(e) ? `<span class="bad">${e.status === 403 ? "Refused" : "Failed"} (${esc(e.status)})</span>` : `<span class="muted">OK</span>`,
      ];
    });
    $("#act-body").innerHTML = tableHtml(cols, rows) + (shown.length > 1000 ? `<div class="card-sub">The newest 1,000 are shown; narrow the filters to see older ones.</div>` : "");
  }

  return { show };
})();
