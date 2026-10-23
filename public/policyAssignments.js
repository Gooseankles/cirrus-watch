"use strict";
/* Policy check: every policy assignment with its parameters, member policies and their effects, excluded scopes,
   identity and exemptions (the Assignments view, and the Details panel on Assignment health rows). The list comes
   from /api/policy-check/assignments, saved by the last scan. Uses app.js helpers. */
const PolicyAssignments = (() => {
  const ID = "policy-check";
  const EFFECTS = {
    deny: "Deny",
    denyaction: "DenyAction",
    modify: "Modify",
    deployifnotexists: "DeployIfNotExists",
    append: "Append",
    audit: "Audit",
    auditifnotexists: "AuditIfNotExists",
    manual: "Manual",
    disabled: "Disabled",
    unknown: "Unknown",
  };
  const effectName = (e) => EFFECTS[e] || e || "Unknown";
  const effectCls = (e) => (e === "deny" || e === "denyaction" ? "bad" : e === "modify" || e === "deployifnotexists" || e === "append" ? "hit" : e === "disabled" ? "" : "");
  const rerender = () => {
    if (state.route === `scan/${ID}`) renderFindings(ID);
  };

  function inventory(t) {
    if (t.pa && t.pa.ranAt === t.data.ranAt) return t.pa;
    if (!t.paLoading) {
      const ranAt = t.data.ranAt;
      t.paLoading = apiJson(`/api/${ID}/assignments`)
        .then((data) => {
          const byId = new Map(data.assignments.map((a) => [String(a.id).toLowerCase(), a]));
          t.pa = { ranAt, data, byId };
        })
        .catch((err) => (t.pa = { ranAt, error: err.message, byId: new Map() }))
        .finally(() => {
          t.paLoading = null;
          rerender();
        });
    }
    return null;
  }

  // The assignment a health finding is about ("<kind>/<assignment id>"); exemption findings have none.
  const assignmentIdOf = (f) => (String(f.kind || "").startsWith("exemption-") ? null : String(f.id || "").slice(String(f.kind || "").length + 1) || null);

  function effectSummary(a) {
    const n = new Map();
    for (const p of a.policies) n.set(p.effect, (n.get(p.effect) || 0) + 1);
    return [...n]
      .sort((x, y) => Object.keys(EFFECTS).indexOf(x[0]) - Object.keys(EFFECTS).indexOf(y[0]))
      .map(([e, c]) => `<span class="tag ${effectCls(e)}">${fmt.int(c)} ${esc(effectName(e))}</span>`)
      .join(" ");
  }

  const fact = (label, value) => (value ? `<div class="pa-fact"><div class="pa-label">${esc(label)}</div><div>${value}</div></div>` : "");
  const code = (s) => `<code class="pa-val">${esc(s)}</code>`;

  function detail(a, t) {
    const q = t.filters.q;
    const d = a.definition || {};
    const defState = d.state === "missing" ? ` <span class="tag bad">deleted</span>` : d.state === "not read" ? ` <span class="tag">not read this run</span>` : "";
    const facts = [
      fact("Definition", `${esc(d.name || "")}${defState}<div class="secondary">${d.initiative ? "Initiative" : "Policy"}${d.type ? " · " + esc(d.type) : ""}${d.version ? " · v" + esc(d.version) : ""}</div><div class="secondary mono small">${esc(d.id || "")}</div>`),
      fact("Scope", `${esc(a.scopeText || "")}<div class="secondary mono small">${esc(a.scope || "")}</div>`),
      fact("Enforcement", /donotenforce/i.test(a.enforcement) ? `<span class="bad">Do not enforce</span> <span class="muted small">(deny and deploy do nothing)</span>` : `<span class="good">Enforced</span>`),
      fact("Excluded scopes", a.notScopes.length ? a.notScopes.map((s) => `<div class="mono small">${esc(s)}</div>`).join("") : `<span class="muted">none</span>`),
      fact("Non-compliance message", a.nonComplianceMessages.map((m) => `<div>${esc(m.message)}${m.policy ? ` <span class="muted small">(${esc(m.policy)})</span>` : ""}</div>`).join("")),
      fact("Description", a.description ? esc(a.description) : ""),
      fact("Managed identity", a.identity ? `${esc(a.identity.type || "")}${a.identity.location ? " · " + esc(a.identity.location) : ""}${(a.identity.principalIds || []).map((p) => `<div class="secondary mono small">${esc(p)}</div>`).join("")}` : ""),
      fact("Compliance", a.compliance ? `${fmt.int(a.compliance.nonCompliant)} non-compliant of ${fmt.int(a.compliance.total)} evaluated` : `<span class="muted">nothing evaluated</span>`),
      fact("Exemptions", a.exemptions.length ? a.exemptions.map((x) => `<div>${esc(x.name)} <span class="muted small">${esc(x.category || "")}${x.expiresOn ? " · until " + esc(fmt.date(x.expiresOn)) : " · no end date"}</span></div>`).join("") : ""),
      fact("Assigned", [a.assignedBy ? esc(a.assignedBy) : "", a.createdOn ? `created ${esc(fmt.date(a.createdOn))}` : "", a.updatedOn ? `changed ${esc(fmt.date(a.updatedOn))}` : ""].filter(Boolean).join(" · ")),
      fact("Assignment ID", `<span class="mono small">${esc(a.id)}</span>`),
    ].join("");

    const params = a.parameters.length
      ? `<div class="table-wrap pa-scroll"><table class="data pa-params"><thead><tr><th>Parameter</th><th>Value</th><th></th></tr></thead><tbody>${a.parameters
          .map(
            (p) =>
              `<tr${q && (p.name + " " + (p.label || "") + " " + (p.value || "")).toLowerCase().includes(q) ? ' class="pa-hit"' : ""}><td><div class="primary">${esc(p.label || p.name)}</div>${p.label ? `<div class="secondary">${esc(p.name)}</div>` : ""}${p.description ? `<div class="secondary">${esc(p.description)}</div>` : ""}</td><td>${p.value === undefined || p.value === null ? `<span class="muted">not set</span>` : code(p.value)}</td><td class="nowrap">${p.source === "set" ? `<span class="tag hit">set</span>` : p.source === "default" ? `<span class="tag">default</span>` : ""}</td></tr>`
          )
          .join("")}</tbody></table></div>`
      : `<p class="muted small">${d.state === "ok" ? "No parameters." : "Parameters unknown: the definition could not be read."}</p>`;

    const more = a.policyCount > a.policies.length ? `<div class="note">${fmt.int(a.policyCount - a.policies.length)} more not listed.</div>` : "";
    const policies = a.policies.length
      ? `<div class="table-wrap pa-scroll"><table class="data"><thead><tr><th>Policy</th><th>Effect</th></tr></thead><tbody>${a.policies
          .map((p) => `<tr${q && String(p.name).toLowerCase().includes(q) ? ' class="pa-hit"' : ""}><td>${esc(p.name)}</td><td class="nowrap"><span class="tag ${effectCls(p.effect)}">${esc(effectName(p.effect))}</span></td></tr>`)
          .join("")}</tbody></table></div>${more}`
      : `<p class="muted small">No policies read.</p>`;
    const missing = a.missingPolicies ? `<div class="note bad">${fmt.int(a.missingPolicies)} policy definition(s) it points to no longer exist.</div>` : "";

    return `<div class="pa-detail">
      <div class="pa-facts">${facts}</div>
      <div class="pa-cols">
        <div><h4>Parameters <span class="muted">${fmt.int(a.parameters.length)}</span></h4>${params}</div>
        <div><h4>${d.initiative ? "Policies in it" : "Policy"} <span class="muted">${fmt.int(a.policyCount)}</span> ${effectSummary(a)}</h4>${policies}${missing}</div>
      </div>
    </div>`;
  }

  // The Details panel under a health finding (or a note while the list loads).
  function detailFor(f, t) {
    const id = assignmentIdOf(f);
    if (!id) return null;
    const inv = inventory(t);
    if (!inv) return `<div class="muted">Loading the assignment…</div>`;
    if (inv.error) return `<div class="muted">Could not load the assignment details: ${esc(inv.error)}</div>`;
    const a = inv.byId.get(id.toLowerCase());
    return a ? detail(a, t) : `<div class="muted">No details saved for this assignment yet; the next scan saves them.</div>`;
  }
  const hasDetail = (f) => Boolean(assignmentIdOf(f));

  function searchText(a) {
    return [a.name, a.id, a.scope, a.scopeText, a.subscriptionName, a.tenantName, a.description, (a.definition || {}).name, (a.definition || {}).id, ...a.parameters.flatMap((p) => [p.name, p.label, p.value]), ...a.policies.map((p) => p.name), ...a.nonComplianceMessages.map((m) => m.message)]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
  }

  function extra(t) {
    const e = t.filters.paEffect || "";
    const opts = [["", "Any effect"], ["deny", "Has Deny"], ["modify", "Has Modify or Deploy"], ["audit", "Has Audit"], ["off", "Not enforced"]];
    return `<select class="select" data-filter="paEffect">${opts.map(([v, l]) => `<option value="${v}"${e === v ? " selected" : ""}>${l}</option>`).join("")}</select>`;
  }

  function matchesEffect(a, e) {
    if (!e) return true;
    if (e === "off") return /donotenforce/i.test(a.enforcement);
    if (e === "deny") return a.policies.some((p) => p.effect === "deny" || p.effect === "denyaction");
    if (e === "modify") return a.policies.some((p) => p.effect === "modify" || p.effect === "deployifnotexists");
    return a.policies.some((p) => p.effect === "audit" || p.effect === "auditifnotexists");
  }

  function page(t) {
    const inv = inventory(t);
    if (!inv) return `<div class="empty-state">Loading the assignments…</div>`;
    if (inv.error) return `<div class="empty-state">Could not load the assignments: ${esc(inv.error)}</div>`;
    const all = inv.data.assignments;
    if (!all.length) return `<div class="empty-state">No assignment list yet; it is saved by the next scan.</div>`;
    const q = t.filters.q;
    const list = all
      .filter((a) => (!t.filters.sub || a.subscriptionId === t.filters.sub) && matchesEffect(a, t.filters.paEffect) && (!q || searchText(a).includes(q)))
      .sort((x, y) => String(x.name).localeCompare(String(y.name)));
    const slice = list.slice(0, t.shown);
    const rows = slice.map((a) => {
      const key = `pa:${a.id}`;
      const open = t.open.has(key);
      const off = /donotenforce/i.test(a.enforcement);
      const main = `<tr>
        <td><div class="name-cell"><div class="primary">${esc(a.name)}</div><div class="secondary">${esc((a.definition || {}).name || "")}${(a.definition || {}).initiative ? " · initiative" : ""}</div></div></td>
        <td><div class="sub-cell"><div class="primary">${esc(a.subscriptionName || a.subscriptionId || "Tenant")}</div><div class="secondary" style="font-family:inherit">${esc(a.scopeText || "")}</div></div></td>
        <td>${off ? `<span class="bad">Do not enforce</span>` : `<span class="good">Enforced</span>`}</td>
        <td>${effectSummary(a)}</td>
        <td class="nowrap">${fmt.int(a.parameters.filter((p) => p.source === "set").length)} set</td>
        <td><button type="button" class="chip${open ? " active" : ""}" data-toggle="${esc(key)}">${icon("chevron")} Details</button></td>
      </tr>`;
      return main + (open ? `<tr class="ar-members-row" data-members="${esc(key)}"><td colspan="6">${detail(a, t)}</td></tr>` : "");
    });
    const off = all.filter((a) => /donotenforce/i.test(a.enforcement)).length;
    return (
      `<p class="muted small">${fmt.int(all.length)} assignments${off ? `, ${fmt.int(off)} not enforced` : ""}. Search finds names, parameters and the policies inside initiatives, so the assignment named in a "disallowed by policy" error can be looked up here.</p>` +
      `<div class="table-wrap"><table class="data"><thead><tr><th>Assignment</th><th>Where</th><th>Enforcement</th><th>Effects</th><th>Parameters</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div>` +
      moreButton(slice.length, list.length, t)
    );
  }

  return { page, extra, detailFor, hasDetail };
})();
