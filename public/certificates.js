"use strict";
/* Certificates scan page: the findings, every certificate the last scan saw (In use): where it is used, who
   issued it, when it expires and its state, also the healthy and unused ones, and every application gateway with
   its addresses (Application gateways): frontends, listeners, their certificate and what each answered live. Both
   lists come from /api/certificates. Uses app.js helpers. */
(() => {
  const ID = "certificates";
  const VIEW_LABELS = [["findings", "Findings"], ["certs", "In use"], ["gateways", "Application gateways"]];
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
    differs: ["Other certificate", "warn", 3],
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
    $("#scan-q").placeholder = v === "findings" ? "Search name, detail, subscription" : v === "gateways" ? "Search gateway, address, host name, certificate" : "Search name, used by, issuer, state";
    const inv = inventory(t);
    const counts = { findings: all.length, certs: inv && inv.data ? inv.data.certs.length : null, gateways: inv && inv.data ? (inv.data.gateways || []).length : null };
    return `<div class="seg">${VIEW_LABELS.map(([k, label]) => {
      const count = counts[k];
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

  // --- Application gateways: addresses, listeners, and the certificate each one serves ---

  // What a live check found. No answer is said plainly: many gateways let in only Front Door or known addresses.
  const CHECKS = {
    ...STATES,
    unreachable: ["Not reachable from the dashboard", "muted", 8],
    unchecked: ["Not checked", "muted", 9],
  };
  const checkOf = (c) => CHECKS[c.status] || [c.status || "?", "muted", 9];
  const daysText = (d) => (d == null ? "" : d < 0 ? `${fmt.int(-d)} days ago` : `${fmt.int(d)} days left`);
  const sec = (html) => (html ? `<div class="secondary">${html}</div>` : "");
  // A host or DNS name breaks at its dots on a narrow screen, not mid-word: a <wbr> after each dot, once escaped.
  const dotted = (s) => esc(s).replace(/\./g, ".<wbr>");

  function listenerRow(l) {
    const https = l.protocol === "HTTPS";
    const where = [l.frontendKind ? `${l.frontendKind} frontend` : "frontend", l.frontend && l.frontend !== l.frontendKind ? l.frontend : null].filter(Boolean).join(" ");
    const hosts = l.hostNames.length
      ? l.hostNames.map((h) => `<div>${dotted(h)}${/[*?]/.test(h) ? ' <span class="muted">wildcard</span>' : ""}</div>`).join("")
      : span("muted", "Any name (basic listener)");
    let cert = span("muted", "–");
    if (https) {
      const [label, cls] = stateOf({ status: l.certStatus });
      const expiry = l.certExpires ? `${esc(l.certExpires)} · ${esc(daysText(l.certDays))}` : "";
      cert = `${esc(l.certificate || "?")}${sec(`${l.certStatus ? span(cls, label) : ""}${expiry ? ` · ${expiry}` : ""}`)}${sec(esc(l.certSource || ""))}${l.certNote ? sec(dotted(l.certNote)) : ""}`;
    }
    let live = span("muted", https ? "No address to check" : "Plain HTTP, no certificate");
    if (https && l.checks.length) {
      live = l.checks.map((c) => {
        const [label, cls] = checkOf(c);
        const how = c.sni ? `as ${c.sni}` : "no SNI";
        const detail = [c.subject && c.subject !== c.sni ? c.subject : null, c.note].filter(Boolean).join(" · ");
        return `<div class="agw-check">${span(cls, label)}${sec(`on ${esc(c.address)} (${esc(c.frontendKind || "")}), ${dotted(how)}`)}${detail ? sec(dotted(detail)) : ""}</div>`;
      }).join("");
    }
    return [
      `<div class="name-cell"><div class="primary">${esc(l.name)}</div>${sec(esc([l.protocol, l.hostNames.length ? "multi-site" : "basic"].filter(Boolean).join(" · ")))}</div>`,
      `${l.ip ? esc(`${l.ip}:${l.port}`) : span("muted", `no address, port ${l.port}`)}${sec(esc(where))}${l.fqdn ? sec(dotted(l.fqdn)) : ""}`,
      hosts,
      cert,
      live,
    ];
  }

  // A listener as a card for narrow screens: name on top, then the same four cells as labelled lines.
  const CARD_LABELS = ["Address", "Host names", "Certificate", "Checked live"];
  function listenerCard(cells) {
    return `<div class="agw-card">${cells[0]}${cells.slice(1).map((c, i) => `<div class="agw-line"><div class="agw-label">${CARD_LABELS[i]}</div><div>${c}</div></div>`).join("")}</div>`;
  }

  // names: subscription names the findings already carry, for a gateway the server could not name.
  function gateways(t, names) {
    const inv = inventory(t);
    if (!inv) return `<div class="empty-state">Loading the gateways…</div>`;
    if (inv.error) return `<div class="empty-state">Could not load the gateways: ${esc(inv.error)}</div>`;
    const d = inv.data;
    const all = d.gateways || [];
    if (!all.length) return `<div class="empty-state">${d.updatedAt ? "No application gateways found, or the gateway check is off. The list is saved by each scan." : "No gateway list yet; it is saved by the next scan."}</div>`;
    const q = t.filters.q;
    const sub = t.filters.sub;
    const text = (g) => [g.name, g.resourceGroup, g.subscriptionName, g.subscriptionId, g.tenantName,
      ...g.frontends.flatMap((f) => [f.name, f.ip, f.fqdn]),
      ...g.listeners.flatMap((l) => [l.name, l.certificate, ...l.hostNames])].join(" ").toLowerCase();
    const list = all.filter((g) => (!sub || g.subscriptionId === sub) && (!q || text(g).includes(q))).sort((a, b) => String(a.name).localeCompare(String(b.name)));

    const listeners = list.flatMap((g) => g.listeners);
    const checks = listeners.flatMap((l) => l.checks);
    const answered = checks.filter((c) => c.status !== "unreachable" && c.status !== "unchecked").length;
    const silent = checks.filter((c) => c.status === "unreachable").length;
    const summary = [
      `${fmt.int(list.length)} gateway${list.length === 1 ? "" : "s"}`,
      `${fmt.int(listeners.length)} listener${listeners.length === 1 ? "" : "s"} (${fmt.int(listeners.filter((l) => l.protocol === "HTTPS").length)} HTTPS)`,
      `${fmt.int(answered)} address check${answered === 1 ? "" : "s"} answered`,
      silent ? `${fmt.int(silent)} not reachable from the dashboard` : null,
    ].filter(Boolean).join(" · ");

    const cols = [{ label: "Listener" }, { label: "Address", cls: "nowrap" }, { label: "Host names" }, { label: "Certificate" }, { label: "Checked live" }];
    const blocks = list.slice(0, t.shown).map((g) => {
      const fronts = g.frontends.map((f) => `<span class="agw-front"><span class="muted">${f.kind === "public" ? "Public" : "Private"}</span> ${esc(f.ip || "no address")}${f.fqdn ? ` <span class="muted">· ${dotted(f.fqdn)}</span>` : ""}</span>`).join("");
      const order = (l) => (l.protocol === "HTTPS" ? 0 : 1);
      const rows = [...g.listeners].sort((a, b) => order(a) - order(b) || String(a.name).localeCompare(String(b.name))).map(listenerRow);
      return `<div class="agw">
        <div class="agw-head">
          <div class="name-cell"><div class="primary">${esc(g.name)}${g.sku ? ` <span class="muted small">${esc(g.sku)}</span>` : ""}</div>${sec(g.resourceGroup ? `rg ${esc(g.resourceGroup)}` : "")}</div>
          ${subCell({ ...g, subscriptionName: g.subscriptionName || names.get(g.subscriptionId) || null })}
        </div>
        <div class="agw-fronts">${fronts || span("muted", "No frontend address")}</div>
        ${rows.length ? `<div class="agw-table">${tableHtml(cols, rows)}</div><div class="agw-cards">${rows.map(listenerCard).join("")}</div>` : `<div class="note">No listeners.</div>`}
      </div>`;
    });
    return `<div class="note">${summary}. Each HTTPS listener is opened on its frontend's address: with its host name, with a made-up name its wildcard matches, or with no name (basic listener, no name check). A private address answers only when the dashboard runs in a network that reaches it.</div>` +
      blocks.join("") +
      moreButton(Math.min(list.length, t.shown), list.length, t);
  }

  function page(all, t) {
    const v = viewOf(t);
    const names = new Map(all.filter((f) => f.subscriptionId && f.subscriptionName).map((f) => [f.subscriptionId, f.subscriptionName]));
    return v === "certs" ? certs(t) : v === "gateways" ? gateways(t, names) : null;
  }

  VIEWS[ID] = { stats: genericStats, extra, page, showKinds: (t) => viewOf(t) === "findings", body: genericBody };
})();
