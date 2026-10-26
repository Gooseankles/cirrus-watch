"use strict";
/* PIM scan page: the findings, everyone with PIM access (PIM access: each person, role, scope and the way in, direct
   or through a group) and the groups that give PIM access (Groups). The lists come from /api/pim, saved by the last
   scan. Uses app.js helpers. */
(() => {
  const ID = "pim";
  const VIEW_LABELS = [["findings", "Findings"], ["access", "PIM access"], ["groups", "Groups"]];
  const viewOf = (t) => (VIEW_LABELS.some(([k]) => k !== "findings" && k === t.filters.view) ? t.filters.view : "findings");
  const rerender = () => {
    if (state.route === `scan/${ID}`) renderFindings(ID);
  };

  function inventory(t) {
    if (t.pim && t.pim.ranAt === t.data.ranAt) return t.pim;
    if (!t.pimLoading) {
      const ranAt = t.data.ranAt;
      t.pimLoading = apiJson("/api/pim")
        .then((data) => (t.pim = { ranAt, data }))
        .catch((err) => (t.pim = { ranAt, error: err.message }))
        .finally(() => {
          t.pimLoading = null;
          rerender();
        });
    }
    return null;
  }

  const span = (cls, text, title) => `<span class="${cls}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
  const STATE = {
    eligible: ["Eligible", ""],
    "eligible-2-steps": ["Eligible (two steps)", "", "Activate the group membership, then the group's role"],
    active: ["Active now", "good"],
    "time-bound": ["Assigned until end", ""],
  };
  const stateCell = (r) => {
    const [label, cls, title] = STATE[r.state] || [r.state, ""];
    return span(cls, label, title);
  };
  function howText(r) {
    if (r.via === "direct") return "Direct";
    if (r.via === "group") return `Group ${r.group} is eligible`;
    if (r.via === "pim-group-owner") return `PIM for Groups: may become owner of ${r.group}`;
    return `PIM for Groups: member of ${r.group}`;
  }
  const howCell = (r) => (r.via === "direct" ? span("muted", "Direct") : `<span class="tag">${esc(howText(r))}</span>`);
  function endCell(r) {
    if (!r.end) return r.state === "active" ? span("muted", "–") : span("warn", "never");
    const left = Math.floor((Date.parse(r.end) - Date.now()) / 86400000);
    return span(left <= 14 && r.state !== "active" ? "warn" : "", r.state === "active" ? fmt.rel(r.end) : fmt.date(r.end), r.end);
  }
  function personCell(r) {
    const badges = [r.guest ? `<span class="tag bad">guest</span>` : "", r.disabled ? `<span class="tag bad">disabled</span>` : "", r.kind === "app" ? `<span class="tag">app</span>` : "", r.kind === "unknown" ? `<span class="tag">not found</span>` : ""].join(" ");
    return `<div class="name-cell"><div class="primary">${esc(r.name)} ${badges}</div>${r.upn && r.upn !== r.name ? `<div class="secondary">${esc(r.upn)}</div>` : ""}</div>`;
  }
  const roleCell = (r) => `<div class="name-cell"><div class="primary">${esc(r.role)}${r.privileged ? ' <span class="tag warn">privileged</span>' : ""}</div><div class="secondary">${r.plane === "entra" ? "Entra role" : "Azure role"} · ${esc(r.scopeText)}</div></div>`;

  function extra(all, t) {
    const v = viewOf(t);
    for (const sel of ["#scan-fw", "#scan-new", "#scan-csv"]) $(sel).classList.toggle("hidden", v !== "findings");
    $("#scan-q").placeholder = v === "findings" ? "Search name, detail, subscription" : v === "access" ? "Search person, role, group, scope" : "Search group, role, owner";
    const inv = inventory(t);
    const notes = inv && inv.data ? inv.data.notes : [];
    return `<div class="seg">${VIEW_LABELS.map(([k, label]) => `<button type="button" data-view="${k}" class="${v === k ? "active" : ""}">${label}${k === "findings" ? ` <span class="n">${fmt.int(all.length)}</span>` : ""}</button>`).join("")}</div>` +
      [...new Set(notes)].map((n) => `<div class="note">${esc(n)}</div>`).join("");
  }

  function filtered(list, t, fields) {
    const q = t.filters.q;
    const sub = t.filters.sub;
    return list.filter((x) => (!sub || x.subscriptionId === sub) && (!q || fields(x).join(" ").toLowerCase().includes(q)));
  }

  // Worst first: guests and disabled accounts, then active now, then privileged, then the rest.
  const rank = (r) => (r.guest || r.disabled ? 0 : r.state === "active" ? 1 : r.privileged ? 2 : 3);

  let csvUrl = null;
  function csvLink(list) {
    const cell = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
    const cols = [["Person", (r) => r.name], ["Sign-in name", (r) => r.upn], ["Guest", (r) => (r.guest ? "yes" : "")], ["Disabled", (r) => (r.disabled ? "yes" : "")],
      ["Role", (r) => r.role], ["Privileged", (r) => (r.privileged ? "yes" : "")], ["Plane", (r) => (r.plane === "entra" ? "Entra" : "Azure")], ["Scope", (r) => r.scopeText],
      ["Subscription", (r) => r.subscriptionName || r.subscriptionId], ["How", howText], ["State", (r) => (STATE[r.state] || [r.state])[0]], ["Ends", (r) => r.end || "never"],
      ["Last activated", (r) => r.lastActivated || ""], ...(multiView() ? [["Tenant", (r) => r.tenantName]] : [])];
    const lines = [cols.map(([h]) => cell(h)).join(","), ...list.map((r) => cols.map(([, get]) => cell(get(r))).join(","))];
    if (csvUrl) URL.revokeObjectURL(csvUrl);
    csvUrl = URL.createObjectURL(new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" }));
    return `<a class="btn small ghost" href="${csvUrl}" download="pim-access-${new Date().toISOString().slice(0, 10)}.csv">${icon("download")} CSV</a>`;
  }

  function access(t) {
    const inv = inventory(t);
    if (!inv) return `<div class="empty-state">Loading the PIM access list…</div>`;
    if (inv.error) return `<div class="empty-state">Could not load the PIM access list: ${esc(inv.error)}</div>`;
    const d = inv.data;
    if (!d.rows.length) return `<div class="empty-state">${d.updatedAt ? "Nobody has PIM access: no one is eligible for a role or active through PIM." : "No PIM access list yet; it is saved by the next scan."}</div>`;
    const list = filtered(d.rows, t, (r) => [r.name, r.upn, r.role, r.scopeText, r.group, r.subscriptionName, r.subscriptionId, r.tenantName, howText(r)])
      .sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name)) || String(a.role).localeCompare(String(b.role)));
    const people = new Set(d.rows.filter((r) => r.kind === "user").map((r) => r.personId)).size;
    const priv = new Set(d.rows.filter((r) => r.kind === "user" && r.privileged).map((r) => r.personId)).size;
    const viaGroup = new Set(d.rows.filter((r) => r.kind === "user" && r.via !== "direct").map((r) => r.personId)).size;
    const now = d.rows.filter((r) => r.state === "active").length;
    const rows = list.slice(0, t.shown).map((r) => [
      personCell(r),
      roleCell(r),
      subCell(r),
      howCell(r),
      stateCell(r),
      endCell(r),
      r.lastActivated ? span("", fmt.rel(r.lastActivated), r.lastActivated) : span("muted", r.via === "group" ? "not tracked" : "none seen"),
    ]);
    return `<div class="row-between"><p class="muted small">${fmt.int(people)} people have PIM access, ${fmt.int(priv)} to a privileged role, ${fmt.int(viaGroup)} through a group. ${fmt.int(now)} activation${now === 1 ? " is" : "s are"} active now.</p>${csvLink(list)}</div>` +
      tableHtml([{ label: "Person" }, { label: "Role and scope" }, { label: "Subscription" }, { label: "How" }, { label: "State" }, { label: "Ends" }, { label: "Last activated" }], rows) +
      moreButton(Math.min(list.length, t.shown), list.length, t);
  }

  const roleList = (g) =>
    g.roles.map((r) => `<div class="small">${esc(r.role)} <span class="muted">· ${esc(r.scopeText)} · ${r.state === "eligible" ? "eligible" : r.end ? "until " + esc(fmt.date(r.end)) : "permanent"}</span>${r.privileged ? ' <span class="tag warn">privileged</span>' : ""}</div>`).join("");
  function groups(t) {
    const inv = inventory(t);
    if (!inv) return `<div class="empty-state">Loading the groups…</div>`;
    if (inv.error) return `<div class="empty-state">Could not load the groups: ${esc(inv.error)}</div>`;
    const d = inv.data;
    if (!d.groups.length) return `<div class="empty-state">${d.updatedAt ? "No group gives PIM access." : "No group list yet; it is saved by the next scan."}</div>`;
    const list = filtered(d.groups, t, (g) => [g.name, g.subscriptionName, g.subscriptionId, g.tenantName, ...g.owners, ...g.roles.map((r) => `${r.role} ${r.scopeText}`)])
      .sort((a, b) => Number(b.roles.some((r) => r.privileged)) - Number(a.roles.some((r) => r.privileged)) || String(a.name).localeCompare(String(b.name)));
    const rows = list.slice(0, t.shown).map((g) => [
      `<div class="name-cell"><div class="primary">${esc(g.name)}</div><div class="secondary">${g.roleAssignable ? "role-assignable" : '<span class="warn">not role-assignable</span>'}${g.pimManaged ? "" : " · not managed by PIM for Groups"}</div></div>`,
      roleList(g),
      subCell(g),
      g.eligible || g.eligibleOwners ? `${fmt.int(g.eligible)}${g.eligibleOwners ? ` <span class="muted small">+${fmt.int(g.eligibleOwners)} owner</span>` : ""}` : span("muted", "0"),
      g.activeNow ? span("good", fmt.int(g.activeNow)) : span("muted", "0"),
      g.permanent ? span(g.eligible && g.roles.some((r) => r.state !== "eligible") ? "warn" : "", fmt.int(g.permanent)) : span("muted", "0"),
      g.owners.length ? `<span class="small">${esc(g.owners.slice(0, 3).join(", "))}${g.owners.length > 3 ? ` <span class="muted">+${g.owners.length - 3}</span>` : ""}</span>` : span("muted", "none"),
    ]);
    return `<p class="muted small">Groups that give PIM access: the group is eligible for a role (members activate the role), or the group holds a role and people are eligible members (they activate the membership). Owners can add members to their group.</p>` +
      tableHtml([{ label: "Group" }, { label: "Roles it holds" }, { label: "Subscription" }, { label: "Eligible members" }, { label: "Active now" }, { label: "Permanent members" }, { label: "Owners" }], rows) +
      moreButton(Math.min(list.length, t.shown), list.length, t);
  }

  function page(all, t) {
    const v = viewOf(t);
    if (v === "access") return access(t);
    if (v === "groups") return groups(t);
    return null;
  }

  VIEWS[ID] = { stats: genericStats, extra, page, showKinds: (t) => viewOf(t) === "findings", body: genericBody };
})();
