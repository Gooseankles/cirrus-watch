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
  }
  async function onClick(e) {
    const t = e.target.closest("[data-tenant-new],[data-tenant-edit],[data-tenant-del],[data-tenant-test],[data-tenant-save],[data-tenant-cancel]");
    if (t) return tenantClick(t);
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
    if (Array.isArray(f.options)) {
      // Options come as {value, label} from the server; accept plain strings too.
      const current = f.value || f.envDefault || f.defaultValue || "";
      control = `<select class="select" data-setting="${esc(f.key)}"${/AZURE_AUTH_TYPE$/.test(f.key) ? ' data-auth-type="1"' : ""} data-fallback="${esc(f.envDefault || f.defaultValue || "")}">${f.options
        .map((o) => (o && typeof o === "object" ? { value: String(o.value), label: String(o.label || o.value) } : { value: String(o), label: String(o) }))
        .map((o) => `<option value="${esc(o.value)}"${o.value === current ? " selected" : ""}>${esc(o.label)}</option>`)
        .join("")}</select>`;
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
        out.className = `test-result ${r.ok && r.graph === "ok" ? "good" : "bad"}`;
        out.textContent = r.ok ? (r.graph === "ok" ? "OK: Azure and Graph tokens" : `Azure OK; Graph: ${r.graph}`) : `Failed: ${r.error || "unknown error"}`;
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
      await load();
    } else setStatus(status, `Save failed: ${r.error}`, "error");
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
        out.className = "test-result good";
        out.textContent = `OK: ${who} got a token`;
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
