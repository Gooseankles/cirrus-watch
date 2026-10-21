"use strict";
/* Settings page (Admin): GET/POST /api/settings, per-tool SPN groups, test connection, clear secrets.
   Uses esc(), $, $$, apiJson, postJson, setStatus and icon from app.js. */
const Settings = (() => {
  let built = false;

  function show() {
    const page = $("#page-settings");
    if (!built) {
      page.innerHTML = `
        <div class="page-head">
          <div><h1>Settings</h1><p class="page-sub">Overrides the matching .env value without a restart. Leave a plain field blank to fall back to .env.</p></div>
        </div>
        <div class="settings-layout">
          <div class="card">
            <div class="status-msg" id="settings-load-status"></div>
            <div id="settings-rows"><div class="empty-state">Loading…</div></div>
            <div class="save-bar"><button class="btn primary" id="settings-save">${icon("check")} Save</button><span class="status-msg" id="settings-status"></span></div>
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
    const el = e.target.closest("#settings-save,[data-clear],[data-test]");
    if (!el) return;
    if (el.id === "settings-save") return saveClicked(el);
    if (el.dataset.clear !== undefined) return clearSecret(el);
    if (el.dataset.test !== undefined) return testConnection(el);
  }

  function applyAuthType(sel) {
    const group = sel.closest(".settings-group");
    if (!group) return;
    const hide = sel.value === "managed-identity";
    for (const row of $$("[data-secret-auth-only]", group)) row.classList.toggle("hidden", hide);
  }

  function fieldHtml(f) {
    const rowAttrs = f.secretAuthOnly ? ' data-secret-auth-only="1"' : "";
    const labelHtml = `<label>${esc(f.label)}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ""}</label>`;
    let control;
    if (Array.isArray(f.options)) {
      // Options come as {value, label} from the server; accept plain strings too.
      const current = f.value || f.envDefault || f.defaultValue || "";
      control = `<select class="select" data-setting="${esc(f.key)}" data-auth-type="1" data-fallback="${esc(f.envDefault || f.defaultValue || "")}">${f.options
        .map((o) => (o && typeof o === "object" ? { value: String(o.value), label: String(o.label || o.value) } : { value: String(o), label: String(o) }))
        .map((o) => `<option value="${esc(o.value)}"${o.value === current ? " selected" : ""}>${esc(o.label)}</option>`)
        .join("")}</select>`;
    } else if (f.secret) {
      control = `<input class="input" type="password" data-setting="${esc(f.key)}" placeholder="leave blank to keep current value" autocomplete="new-password" />
        <span class="secret-state${f.isSet ? " is-set" : ""}">${f.isSet ? `set (${esc(f.source)})` : "not set"}</span>${
        f.isSet ? `<button type="button" class="btn small ghost" data-clear="${esc(f.key)}">Clear</button>` : ""
      }`;
    } else {
      control = `<input class="input" type="text" data-setting="${esc(f.key)}" placeholder="${esc(f.envDefault || "not set in .env")}" value="${esc(f.value || "")}" />`;
    }
    return `<div class="settings-row"${rowAttrs}>${labelHtml}<div class="field">${control}</div></div>`;
  }

  async function load() {
    const rows = $("#settings-rows");
    const loadStatus = $("#settings-load-status");
    let fields;
    try {
      fields = await apiJson("/api/settings");
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
  }

  async function save() {
    const values = {};
    for (const el of $$("#settings-rows [data-setting]")) {
      const isFallback = el.dataset.fallback !== undefined && el.value === el.dataset.fallback;
      values[el.dataset.setting] = isFallback ? "" : el.value;
    }
    try {
      await postJson("/api/settings", { values });
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
