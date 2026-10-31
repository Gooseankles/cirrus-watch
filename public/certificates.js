"use strict";
/* Certificates scan page: the findings, and every certificate the last scan saw (In use): where it is used, who
   issued it, when it expires and its state, also the healthy and unused ones. The list comes from /api/certificates.
   Uses app.js helpers. */
(() => {
  const ID = "certificates";
  const VIEW_LABELS = [["findings", "Findings"], ["certs", "In use"]];
  const viewOf = (t) => (VIEW_LABELS.some(([k]) => k !== "findings" && k === t.filters.view) ? t.filters.view : "findings");
  const rerender = () => {
    if (state.route === `scan/${ID}`) renderFindings(ID);
  };

  // State -> label, class, sort order (worst first).
  const STATES = {
    expired: ["Expired", "bad", 0],
    name: ["Wrong name", "bad", 1],
    untrusted: ["Not trusted", "bad", 2],
    unreachable: ["No answer", "warn", 3],
    expiring: ["Expires soon", "warn", 4],
    unread: ["Not readable", "muted", 5],
    ok: ["OK", "good", 6],
    unused: ["Not used", "muted", 7],
  };
  const TYPES = {
    site: "Web app domain",
    appservice: "App Service certificate",
    gateway: "Gateway listener",
    gatewaylive: "Gateway listener",
    root: "Gateway trusted root",
    listed: "Listed address",
  };
  const stateOf = (c) => STATES[c.status] || [c.status || "?", "muted", 9];

  function inventory(t) {
    if (t.certInv && t.certInv.ranAt === t.data.ranAt) return t.certInv;
    if (!t.certInvLoading) {
      const ranAt = t.data.ranAt;
      t.certInvLoading = apiJson("/api/certificates")
        .then((data) => (t.certInv = { ranAt, data }))
        .catch((err) => (t.certInv = { ranAt, error: err.message }))
        .finally(() => {
          t.certInvLoading = null;
          rerender();
        });
    }
    return null;
  }

  const span = (cls, text) => `<span class="${cls}">${esc(text)}</span>`;

  function extra(all, t) {
    const v = viewOf(t);
    for (const sel of ["#scan-fw", "#scan-new"]) $(sel).classList.toggle("hidden", v !== "findings");
    $("#scan-q").placeholder = v === "findings" ? "Search name, detail, subscription" : "Search name, used by, issuer, state";
    const inv = inventory(t);
    const n = inv && inv.data ? inv.data.certs.length : null;
    return `<div class="seg">${VIEW_LABELS.map(([k, label]) => {
      const count = k === "findings" ? all.length : n;
      return `<button type="button" data-view="${k}" class="${v === k ? "active" : ""}">${label}${count != null ? ` <span class="n">${fmt.int(count)}</span>` : ""}</button>`;
    }).join("")}</div>`;
  }

  function certs(t) {
    const inv = inventory(t);
    if (!inv) return `<div class="empty-state">Loading the certificates…</div>`;
    if (inv.error) return `<div class="empty-state">Could not load the certificates: ${esc(inv.error)}</div>`;
    const d = inv.data;
    if (!d.certs.length) return `<div class="empty-state">${d.updatedAt ? "No certificates found." : "No certificate list yet; it is saved by the next scan."}</div>`;
    const q = t.filters.q;
    const sub = t.filters.sub;
    const list = d.certs
      .filter((c) => (!sub || c.subscriptionId === sub) && (!q || [c.name, c.usedBy, c.subject, c.issuer, c.source, TYPES[c.type], stateOf(c)[0], c.resourceGroup, c.subscriptionName, c.subscriptionId, c.tenantName].join(" ").toLowerCase().includes(q)))
      .sort((a, b) => stateOf(a)[2] - stateOf(b)[2] || (a.days ?? 1e9) - (b.days ?? 1e9) || String(a.name).localeCompare(String(b.name)));

    const counts = {};
    for (const c of list) counts[c.status] = (counts[c.status] || 0) + 1;
    const summary = Object.keys(STATES)
      .filter((k) => counts[k])
      .map((k) => `<span class="${STATES[k][1]}">${fmt.int(counts[k])} ${esc(STATES[k][0].toLowerCase())}</span>`)
      .join(" · ");

    const rows = list.slice(0, t.shown).map((c) => {
      const [label, cls] = stateOf(c);
      const sec = [TYPES[c.type] || c.type, c.subject && c.subject !== c.name ? c.subject : null].filter(Boolean).join(" · ");
      const expires = c.expires
        ? `${esc(c.expires)}<div class="secondary">${c.days < 0 ? `${fmt.int(-c.days)} days ago` : `${fmt.int(c.days)} days left`}</div>`
        : span("muted", "–");
      // State and expiry come right after the name, so a phone shows them without scrolling.
      return [
        nameCell(c, null, sec),
        `${span(cls, label)}<div class="secondary">${esc(c.source || "")}</div>`,
        expires,
        `${esc(c.usedBy || "")}${c.note ? `<div class="secondary">${esc(c.note)}</div>` : ""}`,
        c.issuer ? esc(c.issuer) : span("muted", "–"),
        subCell(c),
      ];
    });
    return `<div class="note">${fmt.int(list.length)} certificate${list.length === 1 ? "" : "s"}: ${summary}</div>` +
      tableHtml([{ label: "Certificate" }, { label: "State", cls: "nowrap" }, { label: "Expires", cls: "nowrap" }, { label: "Used by" }, { label: "Issuer" }, { label: "Subscription" }], rows) +
      moreButton(Math.min(list.length, t.shown), list.length, t);
  }

  function page(all, t) {
    return viewOf(t) === "certs" ? certs(t) : null;
  }

  VIEWS[ID] = { stats: genericStats, extra, page, showKinds: (t) => viewOf(t) === "findings", body: genericBody };
})();
