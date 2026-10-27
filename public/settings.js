"use strict";
/* Settings page (Admin): GET/POST /api/settings, per-tool SPN groups, test connection, clear secrets.
   Uses esc(), $, $$, apiJson, postJson, setStatus and icon from app.js. */
const Settings = (() => {
  let built = false;
  let loadSeq = 0;

  // The customer tenant whose own settings the page shows (its tab is open),
  // or null for the home tenant's, which are every customer's defaults too.
  function scope() {
    const k = state.tenant;
    const t = k && k !== "home" ? tenantList().find((x) => x.key === k) : null;
    return t ? t : null;
  }
  const settingsUrl = () => (scope() ? `/api/settings?tenant=${encodeURIComponent(scope().key)}` : "/api/settings");

  function show() {
    const page = $("#page-settings");
    if (!built) {
      page.innerHTML = `
        <div class="page-head">
          <div><h1>Settings</h1><p class="page-sub" id="settings-sub"></p></div>
        </div>
        <div class="settings-layout">
          <div class="card">
            <div class="status-msg" id="settings-load-status"></div>
            <div id="settings-rows"><div class="empty-state">Loading…</div></div>
            <div class="save-bar"><button class="btn primary" id="settings-save">${icon("check")} Save</button><span class="status-msg" id="settings-status"></span></div>
          </div>
          <div class="card" id="notify-card">
            <div class="card-head"><h2 id="notify-title">Notifications</h2></div>
            <div class="note">Once a day this tenant's new findings and failed scans go to one place: a Teams channel (in the channel: Workflows, "Post to a channel when a webhook request is received", copy its link), a Slack incoming webhook, any https webhook, or email addresses where webhooks are blocked (a Teams channel's email address works too). Accepted and snoozed findings are left out, and a day with nothing new sends nothing. The send time and the mailbox email is sent from are under Notifications on the Home tab. A webhook link works as a password: it is kept like a secret and never shown again.</div>
            <div class="status-msg" id="notify-status"></div>
            <div id="notify-body"><div class="empty-state">Loading…</div></div>
          </div>
          <div class="card" id="tenants-card">
            <div class="card-head"><h2 id="tenants-title">Customer tenants</h2><button type="button" class="btn small" data-tenant-new="1">Add tenant</button></div>
            <div class="note" id="tenants-note">Other organizations' tenants this dashboard scans. In each, make an app registration with a client secret, give it read permissions, and enter its client ID (here or in Terraform) and its secret (here only; it is never shown again). Each tenant gets a tab, its own storage container and the app roles Admin-&lt;key&gt; (read and run) and User-&lt;key&gt; (read); the roles exist only for tenants in Terraform's customers. Tenants from Terraform can be changed here; Reset drops those changes, Remove deletes only tenants added here.</div>
            <div class="status-msg" id="tenants-status"></div>
            <div id="tenants-list"><div class="empty-state">Loading…</div></div>
            <div id="tenant-form"></div>
          </div>
        </div>`;
      page.addEventListener("click", onClick);
      page.addEventListener("change", onChange);
      built = true;
    }
    load();
  }

  function onChange(e) {
    const sel = e.target;
    if (sel.matches("select[data-auth-type]")) applyAuthType(sel);
    if (sel.matches("[data-scan-on]")) {
      // The setting holds the scans that are off.
      const field = sel.closest(".field");
      field.querySelector("[data-setting]").value = $$("[data-scan-on]", field).filter((c) => !c.checked).map((c) => c.dataset.scanOn).join(",");
    }
  }
  async function onClick(e) {
    const t = e.target.closest("[data-tenant-new],[data-tenant-edit],[data-tenant-del],[data-tenant-test],[data-tenant-save],[data-tenant-cancel]");
    if (t) return tenantClick(t);
    const n = e.target.closest("[data-notify]");
    if (n) return notifyClick(n);
    const el = e.target.closest("#settings-save,[data-clear],[data-test]");
    if (!el) return;
    if (el.id === "settings-save") return saveClicked(el);
    if (el.dataset.clear !== undefined) return clearSecret(el);
    if (el.dataset.test !== undefined) return testConnection(el);
  }

  // Rows with data-auth-only show only for the auth types they list.
  function applyAuthType(sel) {
    const group = sel.closest(".settings-group");
    if (!group) return;
    for (const row of $$("[data-auth-only]", group)) row.classList.toggle("hidden", !row.dataset.authOnly.split(",").includes(sel.value));
  }

  function fieldHtml(f) {
    const rowAttrs = Array.isArray(f.authOnly) ? ` data-auth-only="${esc(f.authOnly.join(","))}"` : "";
    const labelHtml = `<label>${esc(f.label)}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ""}</label>`;
    let control;
    if (f.scanPicker) {
      // One tick per scan, by menu group; ticked = runs for this tenant.
      const off = new Set(String(f.value || "").split(",").map((s) => s.trim()).filter(Boolean));
      const groups = TOOL_GROUPS.map((g) => ({ g, tools: TOOLS.filter((t) => t.group === g.id) })).filter((x) => x.tools.length);
      control = `<input type="hidden" data-setting="${esc(f.key)}" value="${esc([...off].join(","))}" /><div class="scan-picker">${groups
        .map(({ g, tools }) => `<div class="scan-picker-group"><div class="scan-picker-head">${esc(g.label)}</div>${tools
          .map((t) => `<label class="check"><input type="checkbox" data-scan-on="${esc(t.id)}"${off.has(t.id) ? "" : " checked"} /> ${esc(t.label)}</label>`)
          .join("")}</div>`)
        .join("")}</div>`;
    } else if (Array.isArray(f.options)) {
      // Options come as {value, label} from the server; accept plain strings too.
      const opts = f.options.map((o) => (o && typeof o === "object" ? { value: String(o.value), label: String(o.label || o.value) } : { value: String(o), label: String(o) }));
      // A customer tenant's field may follow Home (blank).
      const tenantField = f.homeValue !== undefined;
      const current = tenantField ? f.value || "" : f.value || f.envDefault || f.defaultValue || "";
      const homeOpt = opts.find((o) => o.value === (f.homeValue || f.defaultValue || ""));
      control = `<select class="select" data-setting="${esc(f.key)}"${/AZURE_AUTH_TYPE$/.test(f.key) ? ' data-auth-type="1"' : ""} data-fallback="${esc(tenantField ? "" : f.envDefault || f.defaultValue || "")}">${
        tenantField ? `<option value=""${current ? "" : " selected"}>Same as Home${homeOpt ? ` (${esc(homeOpt.label)})` : ""}</option>` : ""
      }${opts.map((o) => `<option value="${esc(o.value)}"${o.value === current ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>`;
    } else if (f.secret) {
      control = `<input class="input" type="password" data-setting="${esc(f.key)}" placeholder="leave blank to keep current value" autocomplete="new-password" />
        <span class="secret-state${f.isSet ? " is-set" : ""}">${f.isSet ? `set (${esc(f.source)})` : "not set"}</span>${
        f.isSet ? `<button type="button" class="btn small ghost" data-clear="${esc(f.key)}">Clear</button>` : ""
      }`;
    } else {
      const ph = f.homeValue !== undefined ? (f.homeValue ? `Home: ${f.homeValue}` : "same as Home") : f.envDefault || "not set in .env";
      control = `<input class="input" type="text" data-setting="${esc(f.key)}" placeholder="${esc(ph)}" value="${esc(f.value || "")}" />`;
    }
    return `<div class="settings-row"${rowAttrs}>${labelHtml}<div class="field">${control}</div></div>`;
  }

  function renderHead() {
    const t = scope();
    $("#settings-sub").textContent = t
      ? `Tool settings for ${t.name} only. Blank = the Home value, shown in grey. Sign-in, storage and the per-tool SPNs are on the Home tab.`
      : showTenants()
        ? "The home tenant, and the defaults for every customer tenant (a customer's tab can change its tool settings). Overrides the matching .env value without a restart; leave a plain field blank to fall back to .env."
        : "Overrides the matching .env value without a restart. Leave a plain field blank to fall back to .env.";
    $("#tenants-title").textContent = t ? "This tenant" : "Customer tenants";
    $("#tenants-note").classList.toggle("hidden", Boolean(t));
    $("[data-tenant-new]").classList.toggle("hidden", Boolean(t));
  }

  async function load() {
    const rows = $("#settings-rows");
    const loadStatus = $("#settings-load-status");
    const seq = ++loadSeq;
    renderHead();
    if (scope() && tn.editing && tn.editing.key !== scope().key) tn.editing = null;
    let fields;
    try {
      fields = await apiJson(settingsUrl());
      if (seq !== loadSeq) return; // another tab was opened meanwhile
      if (!Array.isArray(fields)) fields = [];
      setStatus(loadStatus, "");
    } catch (err) {
      rows.innerHTML = "";
      setStatus(loadStatus, `Could not load settings: ${err.message}`, "error");
      return;
    }
    const groups = new Map();
    for (const f of fields) {
      const g = f.group || "General";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(f);
    }
    let html = "";
    let introDone = false;
    for (const [groupName, groupFields] of groups) {
      const collapsible = groupFields.some((f) => f.collapsible);
      const spnTool = groupFields[0].spnTool;
      const isSharedSpn = groupFields.some((f) => f.key === "AZURE_CLIENT_ID");
      if (collapsible && !introDone) {
        html += `<div class="settings-group"><h3>Per-tool SPNs (optional)</h3><div class="hint-top">Give a tool its own least-privilege service principal. A tool without a client ID here uses the shared SPN.</div></div>`;
        introDone = true;
      }
      const own = groupFields.some((f) => f.key.endsWith("AZURE_CLIENT_ID") && (f.value || f.envDefault));
      const body = groupFields.map(fieldHtml).join("");
      const test = collapsible || isSharedSpn
        ? `<div class="settings-row"><label>Connection<div class="hint">Saves these settings, then asks Azure for a token.</div></label><div class="field"><button type="button" class="btn small" data-test="1" data-tool="${esc(spnTool || "")}">${icon("play")} Test connection</button><span class="test-result"></span></div></div>`
        : "";
      if (collapsible) {
        html += `<details class="settings-group spn-tool"${own ? " open" : ""}><summary><span>${esc(groupName.replace(/^SPN override: /, ""))}</span><span class="spn-badge${own ? " own" : ""}">${own ? "own SPN" : "shared SPN"}</span></summary>${body}${test}</details>`;
      } else {
        html += `<div class="settings-group"><h3>${esc(groupName)}</h3>${body}${test}</div>`;
      }
    }
    rows.innerHTML = html || `<div class="empty-state">No settings are exposed by this server.</div>`;
    for (const sel of $$("select[data-auth-type]", rows)) applyAuthType(sel);
    loadTenants();
    loadNotify();
  }

  /* ---------- notifications (one link per tenant) ---------- */
  const notifyKey = () => (scope() ? scope().key : "home");
  const notifyUrl = (path = "") => `/api/notify${path}?tenant=${encodeURIComponent(notifyKey())}`;
  const when = (iso) => (iso ? new Date(iso).toLocaleString() : "never");

  async function loadNotify() {
    const body = $("#notify-body");
    const key = notifyKey();
    try {
      const d = await apiJson(notifyUrl());
      if (key !== notifyKey()) return; // another tab was opened meanwhile
      renderNotify(d);
      setStatus($("#notify-status"), "");
    } catch (err) {
      body.innerHTML = "";
      setStatus($("#notify-status"), `Could not load notifications: ${err.message}`, "error");
    }
  }

  function renderNotify(d) {
    $("#notify-title").textContent = showTenants() ? `Notifications for ${d.tenantName}` : "Notifications";
    const kind = { teams: "Teams", slack: "Slack", webhook: "webhook", email: "email" }[d.kind] || "";
    const state = !d.isSet ? "not set" : d.to ? `email to ${esc(d.to.join(", "))}` : `set${kind ? `, ${kind}` : ""} (${esc(d.where)})`;
    const rows = [
      `<div class="settings-row"><label>Link or email<div class="hint">A webhook link, or email addresses separated by commas. Enter a new one to replace the current one.</div></label><div class="field">
        <input class="input" type="password" id="notify-url" placeholder="https://… or ops@contoso.com, alerts@contoso.com" autocomplete="new-password" />
        <span class="secret-state${d.isSet ? " is-set" : ""}">${state}</span></div></div>`,
    ];
    if (d.to && !d.mailFrom) rows.push(`<div class="settings-row"><label></label><div class="field"><span class="bad">No mailbox to send from yet: set Send email from under Notifications on the Home tab.</span></div></div>`);
    if (d.isSet) {
      rows.push(`<div class="settings-row"><label>Status</label><div class="field"><span>Sent daily at ${esc(d.time)}. Waiting: ${d.pending}. Last sent: ${esc(when(d.lastSent))}.${d.lastError ? ` <span class="bad">Last try failed (${esc(when(d.lastErrorAt))}): ${esc(d.lastError)}</span>` : ""}</span></div></div>`);
    }
    $("#notify-body").innerHTML = `${rows.join("")}
      <div class="save-bar">
        <button type="button" class="btn primary" data-notify="save">${icon("check")} Save</button>
        ${d.isSet ? `<button type="button" class="btn small" data-notify="test">${icon("play")} Send test</button><button type="button" class="btn small ghost" data-notify="clear">Remove</button>` : ""}
        <span class="test-result" id="notify-result"></span>
      </div>`;
  }

  async function notifyClick(el) {
    const what = el.dataset.notify;
    const status = $("#notify-status");
    const result = $("#notify-result");
    el.disabled = true;
    try {
      if (what === "save") {
        const url = $("#notify-url").value.trim();
        if (!url) return setStatus(status, "Enter a link or email addresses first.", "error");
        renderNotify(await postJson(notifyUrl(), { url }));
        setStatus(status, "Saved. Send a test to check it.", "ok");
      } else if (what === "clear") {
        if (!confirm("Remove this tenant's notification link? Anything waiting to be sent is dropped.")) return;
        renderNotify(await postJson(notifyUrl(), { clear: true }));
        setStatus(status, "Link removed.", "ok");
      } else if (what === "test") {
        result.className = "test-result";
        result.textContent = "Sending…";
        const r = await postJson(notifyUrl("/test"));
        result.className = `test-result ${r.ok ? "good" : "bad"}`;
        result.textContent = r.ok ? (r.kind === "email" ? "Sent. Check the inbox." : "Sent. Check the channel.") : r.error;
      }
    } catch (err) {
      setStatus(status, err.message, "error");
    } finally {
      el.disabled = false;
    }
  }

  /* ---------- customer tenants ---------- */
  const tn = { list: [], editing: null };

  async function loadTenants() {
    const status = $("#tenants-status");
    try {
      const r = await apiJson("/api/tenants");
      tn.list = Array.isArray(r.tenants) ? r.tenants : [];
      setStatus(status, "");
    } catch (err) {
      tn.list = [];
      setStatus(status, `Could not load tenants: ${err.message}`, "error");
    }
    renderTenants();
  }

  // A Test's permission check, as plain lines: what is missing, or that all is there.
  function permLines(p) {
    if (!p) return { html: "", bad: false };
    const short = (list) => (list.length > 4 ? `${list.slice(0, 4).join(", ")} and ${list.length - 4} more` : list.join(", "));
    const out = [];
    const g = p.graph;
    if (g) {
      if (g.error) out.push(["bad", `Graph permissions not checked: ${g.error}`]);
      else {
        if (g.missing.length) out.push(["bad", `Missing Graph application permissions (add them, then Grant admin consent): ${g.missing.join(", ")}`]);
        if ((g.pending || []).length) {
          const age = g.tokenAge != null ? ` The token in use is ${g.tokenAge} h old.` : "";
          out.push(["wait", `Granted in Entra but not yet in the identity's token: ${g.pending.join(", ")}. Tokens are cached (managed identity tokens for up to 24 hours); the scans get these once it renews.${age}`]);
        }
        if (!g.missing.length && !(g.pending || []).length) out.push(["good", `Graph: all ${g.needed.length} application permissions granted`]);
      }
    }
    const a = p.azure;
    if (a && a.error) out.push(["bad", `Azure roles not checked: ${a.error}`]);
    else if (a && a.needed.length) {
      if (!a.subscriptions && !a.notVisible.length) out.push(["bad", "Azure: the app sees no subscription. Give it Reader on the subscriptions or on a management group"]);
      for (const m of a.missing) out.push(["bad", `Missing ${m.role} on ${m.subscriptions.length} of ${a.subscriptions} subscriptions: ${short(m.subscriptions)} (a role given through a group is not seen here)`]);
      if (a.notVisible.length) out.push(["bad", `Cannot see ${a.notVisible.length} of the configured subscriptions: ${short(a.notVisible)}`]);
      if (a.failed.length) out.push(["bad", `Role assignments not readable on ${short(a.failed)}`]);
      if (a.subscriptions && !a.missing.length) out.push(["good", `Azure: ${a.needed.join(", ")} on all ${a.subscriptions} subscriptions${a.more ? ` checked (${a.more} more not checked)` : ""}`]);
    }
    return { html: out.map(([c, t]) => `<div class="perm-line ${c}">${esc(t)}</div>`).join(""), bad: out.some(([c]) => c === "bad") };
  }

  function renderTenants() {
    const el = $("#tenants-list");
    if (!el) return;
    const only = scope();
    const list = only ? tn.list.filter((t) => t.key === only.key) : tn.list;
    if (!list.length) {
      el.innerHTML = `<div class="empty-state">No customer tenants. Only this tenant is scanned.</div>`;
    } else {
      el.innerHTML = tableHtml(
        [{ label: "Tenant" }, { label: "App (client) ID" }, { label: "Subscriptions" }, { label: "Storage" }, { label: "" }],
        list.map((t) => [
          `<div class="name-cell"><div class="primary">${esc(t.name)}${t.enabled ? "" : ' <span class="tag">off</span>'}</div><div class="secondary mono">${esc(t.key)} · ${esc(t.tenantId)}</div></div>`,
          `<div class="name-cell"><div class="primary">${t.clientId ? `<span class="mono">${esc(t.clientId)}</span>` : '<span class="bad">not set</span>'}</div><div class="secondary">${t.hasSecret ? `secret set${t.secretIn ? ` (${esc(t.secretIn)})` : ""}` : '<span class="bad">no secret</span>'}</div></div>`,
          t.subscriptionIds.length ? esc(t.subscriptionIds.length === 1 ? t.subscriptionIds[0] : `${t.subscriptionIds.length} listed`) : '<span class="muted">all it can see</span>',
          `<div class="name-cell"><div class="primary mono">${esc(t.container || "")}</div><div class="secondary">from ${esc(t.source)}</div></div>`,
          `<div class="tenant-actions"><button type="button" class="btn small ghost" data-tenant-test="${esc(t.key)}">Test</button><button type="button" class="btn small ghost" data-tenant-edit="${esc(t.key)}">Edit</button>${
            t.source === "terraform"
              ? ""
              : t.source === "settings"
                ? `<button type="button" class="btn small ghost" data-tenant-del="${esc(t.key)}">Remove</button>`
                : `<button type="button" class="btn small ghost" data-tenant-del="${esc(t.key)}" data-tenant-reset="1" title="Drop the changes made here and use what Terraform set">Reset</button>`
          }<div class="test-result" data-test-out="${esc(t.key)}"></div></div>`,
        ])
      );
    }
    renderTenantForm();
  }

  function tenantRow(label, hint, control) {
    return `<div class="settings-row"><label>${esc(label)}${hint ? `<div class="hint">${esc(hint)}</div>` : ""}</label><div class="field">${control}</div></div>`;
  }
  function renderTenantForm() {
    const el = $("#tenant-form");
    if (!el) return;
    const e = tn.editing;
    if (!e) {
      el.innerHTML = "";
      return;
    }
    const t = e.key ? tn.list.find((x) => x.key === e.key) || {} : {};
    const input = (name, value, ph, extra) => `<input class="input" type="text" data-tf="${name}" value="${esc(value || "")}" placeholder="${esc(ph || "")}"${extra || ""} />`;
    el.innerHTML = `<div class="tenant-form settings-group">
      <h3>${e.key ? `Edit ${esc(t.name || e.key)}` : "New customer tenant"}</h3>
      ${tenantRow("Key", "Lowercase letters, digits, - or _. Names the roles Admin-<key> / User-<key> and the storage container; cannot be changed later.", input("key", e.key, "acme", e.key ? " disabled" : ""))}
      ${tenantRow("Name", "Shown on the tab and next to findings.", input("name", t.name, "Acme AS"))}
      ${tenantRow("Tenant ID", "The customer's Entra tenant ID.", input("tenantId", t.tenantId, "00000000-0000-0000-0000-000000000000"))}
      ${tenantRow("App (client) ID", "The app registration made in that tenant.", input("clientId", t.clientId, "00000000-0000-0000-0000-000000000000"))}
      ${tenantRow("Client secret", "Certificates & secrets → New client secret on that app; paste its Value. Kept in the dashboard's key vault (on the server without one), never shown again.", `<input class="input" type="password" data-tf="clientSecret" autocomplete="new-password" placeholder="${t.hasSecret ? "set; leave blank to keep" : "not set"}" />${
        t.hasSecret ? '<label class="check"><input type="checkbox" data-tf="clearSecret" /> Remove the stored secret</label>' : ""
      }`)}
      ${tenantRow("Subscriptions", "Comma-separated IDs; blank = every subscription it can see.", input("subscriptionIds", (t.subscriptionIds || []).join(", "), "all"))}
      ${tenantRow("Scan", "", `<label class="check"><input type="checkbox" data-tf="enabled"${t.enabled === false ? "" : " checked"} /> Scan this tenant</label>`)}
      <div class="save-bar"><button type="button" class="btn primary" data-tenant-save="1">Save tenant</button><button type="button" class="btn ghost" data-tenant-cancel="1">Cancel</button><span class="status-msg" id="tenant-form-status"></span></div>
    </div>`;
  }

  async function tenantClick(el) {
    const d = el.dataset;
    const status = $("#tenants-status");
    if (d.tenantNew !== undefined) {
      tn.editing = { key: "" };
      renderTenantForm();
      $("#tenant-form [data-tf=key]").focus();
    } else if (d.tenantEdit !== undefined) {
      tn.editing = { key: d.tenantEdit };
      renderTenantForm();
      $("#tenant-form").scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else if (d.tenantCancel !== undefined) {
      tn.editing = null;
      renderTenantForm();
    } else if (d.tenantDel !== undefined) {
      const reset = d.tenantReset !== undefined;
      const ask = reset ? `Reset ${d.tenantDel} to what Terraform set? Changes made here are dropped.` : `Remove ${d.tenantDel}? Its stored results stay in storage but are no longer shown.`;
      if (!window.confirm(ask)) return;
      try {
        const r = await apiJson(`/api/tenants/${encodeURIComponent(d.tenantDel)}`, { method: "DELETE" });
        tn.list = r.tenants || [];
        if (tn.editing && tn.editing.key === d.tenantDel) tn.editing = null;
        setStatus(status, reset ? `${d.tenantDel} reset to the Terraform values.` : `${d.tenantDel} removed. Reload the page to update the tabs.`, "ok");
        renderTenants();
      } catch (err) {
        setStatus(status, `${reset ? "Reset" : "Remove"} failed: ${err.message}`, "error");
      }
    } else if (d.tenantTest !== undefined) {
      const out = $(`[data-test-out="${CSS.escape(d.tenantTest)}"]`);
      el.disabled = true;
      out.className = "test-result";
      out.textContent = "Testing…";
      try {
        const r = await postJson(`/api/tenants/${encodeURIComponent(d.tenantTest)}/test`, {});
        const perms = permLines(r.permissions);
        out.className = `test-result ${r.ok && r.graph === "ok" && !perms.bad ? "good" : "bad"}`;
        out.textContent = r.ok ? (r.graph === "ok" ? "Signs in: Azure and Graph tokens" : `Azure OK; Graph: ${r.graph}`) : `Failed: ${r.error || "unknown error"}`;
        out.insertAdjacentHTML("beforeend", perms.html);
      } catch (err) {
        out.className = "test-result bad";
        out.textContent = `Failed: ${err.message}`;
      }
      el.disabled = false;
    } else if (d.tenantSave !== undefined) {
      const form = $("#tenant-form");
      const val = (n) => {
        const f = $(`[data-tf="${n}"]`, form);
        return !f ? undefined : f.type === "checkbox" ? f.checked : f.value.trim();
      };
      const body = {
        key: tn.editing.key || val("key"),
        name: val("name"), tenantId: val("tenantId"), clientId: val("clientId"),
        clientSecret: val("clientSecret"), clearSecret: val("clearSecret") === true,
        subscriptionIds: val("subscriptionIds"), enabled: val("enabled"),
      };
      const fstatus = $("#tenant-form-status");
      el.disabled = true;
      setStatus(fstatus, "Saving…");
      try {
        const r = await postJson("/api/tenants", body);
        tn.list = r.tenants || [];
        tn.editing = null;
        setStatus(status, `${body.key} saved. Reload the page to update the tabs.`, "ok");
        renderTenants();
      } catch (err) {
        el.disabled = false;
        setStatus(fstatus, `Save failed: ${err.message}`, "error");
      }
    }
  }

  async function save() {
    const values = {};
    for (const el of $$("#settings-rows [data-setting]")) {
      const isFallback = el.dataset.fallback !== undefined && el.value === el.dataset.fallback;
      values[el.dataset.setting] = isFallback ? "" : el.value;
    }
    try {
      await postJson(settingsUrl(), { values });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }
  async function saveClicked(btn) {
    const status = $("#settings-status");
    btn.disabled = true;
    setStatus(status, "Saving…");
    const r = await save();
    btn.disabled = false;
    if (r.ok) {
      setStatus(status, "Saved.", "ok");
      refreshScans();
      await load();
    } else setStatus(status, `Save failed: ${r.error}`, "error");
  }
  // Scans turned on or off change the menu and the overview.
  async function refreshScans() {
    try {
      const me = await apiJson("/api/me");
      if (me && Array.isArray(me.tenants)) state.me = me;
      rebuildNav();
    } catch {
      /* the page still works; a reload shows the change */
    }
  }
  async function clearSecret(btn) {
    const key = btn.dataset.clear;
    const status = $("#settings-status");
    btn.disabled = true;
    try {
      await postJson("/api/settings", { values: {}, clear: [key] });
      setStatus(status, `${key} cleared.`, "ok");
      await load();
    } catch (err) {
      btn.disabled = false;
      setStatus(status, `Clear failed: ${err.message}`, "error");
    }
  }
  async function testConnection(btn) {
    const out = btn.parentElement.querySelector(".test-result");
    const toolId = btn.dataset.tool || null;
    btn.disabled = true;
    out.className = "test-result";
    out.textContent = "Saving…";
    const saved = await save();
    if (!saved.ok) {
      out.className = "test-result bad";
      out.textContent = `Not tested: saving the settings failed: ${saved.error}`;
      btn.disabled = false;
      return;
    }
    out.textContent = "Testing…";
    try {
      const r = await postJson("/api/settings/test-spn", { toolId });
      const who = r.source
        ? `${r.source} ${r.authType === "managed-identity" ? "managed identity" : "SPN"} ${r.clientId || (r.authType === "managed-identity" ? "(system-assigned)" : "")}`.trim()
        : "";
      if (r.ok) {
        const perms = permLines(r.permissions);
        out.className = `test-result ${perms.bad ? "bad" : "good"}`;
        out.textContent = `${who} got a token`;
        out.insertAdjacentHTML("beforeend", perms.html);
      } else {
        out.className = "test-result bad";
        out.textContent = `Failed${who ? ` (${who})` : ""}: ${r.error || "unknown error"}`;
      }
    } catch (err) {
      out.className = "test-result bad";
      out.textContent = `Failed: ${err.message}`;
    }
    btn.disabled = false;
  }

  return { show };
})();
