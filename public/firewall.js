"use strict";
/* Firewall policies scan page: the findings, and a Rules view of one policy at a time: its rule collection groups,
   collections and rules in priority order (a parent policy's rules first), or every rule in the order the firewall
   really checks them. Each rule carries the marks the scan gave it (duplicate, never hit, covered by an earlier rule,
   too wide). The search box finds rules by name, address, FQDN or port, and an IP address finds the rules whose
   source or destination holds it. The rules come from /api/firewall-policies, saved by the last scan. Uses app.js
   helpers. */
(() => {
  const ID = "firewall-policies";
  const VIEW_LABELS = [["findings", "Findings"], ["rules", "Rules"], ["reach", "Reach map"]];
  const viewOf = (t) => (t.filters.view === "rules" || t.filters.view === "reach" ? t.filters.view : "findings");
  const MARKS = [["duplicate", "Duplicates", "warn"], ["never hit", "Never hit", "bad"], ["covered", "Covered", ""], ["wide", "Too wide", "warn"]];
  const TYPE_NAME = { Nat: "DNAT", Network: "Network", Application: "Application" };
  const LETTER = { Nat: "D", Network: "N", Application: "A" };
  const rerender = () => {
    if (state.route === `scan/${ID}`) renderFindings(ID);
  };

  /* data: loaded once per scan run */
  function inventory(t) {
    if (t.fw && t.fw.ranAt === t.data.ranAt) return t.fw;
    if (!t.fwLoading) {
      const ranAt = t.data.ranAt;
      t.fwLoading = apiJson("/api/firewall-policies")
        .then((data) => (t.fw = { ranAt, data }))
        .catch((err) => (t.fw = { ranAt, error: err.message }))
        .finally(() => {
          t.fwLoading = null;
          rerender();
        });
    }
    return null;
  }
  const loading = () => `<div class="empty-state">Loading the rules…</div>`;
  const failed = (msg) => `<div class="empty-state big"><h3>Could not load the rules</h3><p class="muted">${esc(msg)}</p></div>`;
  const noInventory = () =>
    `<div class="empty-state big"><h3>No rules saved yet</h3><p>The rules are saved by each scan. Run the scan once${canRun() ? " (Run now above)" : ""} and the policies show here.</p></div>`;

  /* IP search */
  function ipNum(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(String(s || "").trim());
    if (!m || m.slice(1, 5).some((o) => +o > 255) || (m[5] && +m[5] > 32)) return null;
    const ip = ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4];
    const size = 2 ** (32 - (m[5] === undefined ? 32 : +m[5]));
    const start = Math.floor(ip / size) * size;
    return { start, end: start + size - 1 };
  }
  function rangeOf(entry) {
    const s = String(entry).trim();
    if (s === "*" || /^any$/i.test(s)) return { start: 0, end: 2 ** 32 - 1 };
    const dash = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(s);
    if (dash) {
      const a = ipNum(dash[1]);
      const b = ipNum(dash[2]);
      return a && b ? { start: a.start, end: b.end } : null;
    }
    return ipNum(s);
  }
  // Does this side of the rule (addresses plus IP groups) hold the searched address?
  function sideHolds(q, entries, groups, ipGroups) {
    const all = [...(entries || []), ...(groups || []).flatMap((g) => (ipGroups[g] && ipGroups[g].ips) || [])];
    return all.some((e) => {
      const r = rangeOf(e);
      return r && r.start <= q.end && q.start <= r.end;
    });
  }

  /* stats */
  function stats(all, t) {
    const inv = inventory(t);
    if (!inv || !inv.data || !inv.data.policies.length) return genericStats(all, t);
    const ps = inv.data.policies;
    const sum = (k) => ps.reduce((n, p) => n + ((p.marks && p.marks[k]) || 0), 0);
    const rules = ps.reduce((n, p) => n + (p.ruleCount || 0), 0);
    const classic = ps.filter((p) => p.classic).length;
    return (
      statTile({ label: "Policies", value: fmt.int(ps.length - classic), delta: classic ? `+ ${fmt.int(classic)} classic firewall${classic === 1 ? "" : "s"}` : `${fmt.int(ps.filter((p) => p.firewalls.length).length)} in use` }) +
      statTile({ label: "Rules", value: fmt.int(rules), delta: "not counting inherited" }) +
      statTile({ label: "Duplicates", value: fmt.int(sum("duplicate")), deltaCls: sum("duplicate") ? "bad" : "" }) +
      statTile({ label: "Never used", value: fmt.int(sum("never hit") + sum("covered")), deltaCls: sum("never hit") ? "bad" : "", delta: sum("never hit") ? `${fmt.int(sum("never hit"))} undone by an earlier rule` : "covered by earlier rules" }) +
      statTile({ label: "Too wide", value: fmt.int(sum("wide")), deltaCls: sum("wide") ? "bad" : "" })
    );
  }

  function extra(all, t) {
    const v = viewOf(t);
    for (const sel of ["#scan-sub", "#scan-fw", "#scan-new"]) $(sel).classList.toggle("hidden", v !== "findings");
    $("#scan-q").classList.toggle("hidden", v === "reach");
    $("#scan-q").placeholder = v === "rules" ? "Search rule, address, FQDN, port or an IP address" : "Search name, detail, subscription";
    return `<div class="seg">${VIEW_LABELS.map(([k, label]) => `<button type="button" data-view="${k}" class="${v === k ? "active" : ""}">${label}${k === "findings" ? ` <span class="n">${fmt.int(all.length)}</span>` : ""}</button>`).join("")}</div>`;
  }

  /* cells */
  const tag = (text, cls, title) => `<span class="tag fw-tag${cls ? " " + cls : ""}"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</span>`;
  function addrList(entries, groups, ipGroups, extraAtoms) {
    const parts = [
      ...(entries || []).map((e) => (e === "*" ? `<span class="fw-any">any</span>` : `<span class="mono">${esc(e)}</span>`)),
      ...(extraAtoms || []).map((e) => `<span class="mono">${esc(e)}</span>`),
      ...(groups || []).map((g) => {
        const ig = ipGroups[g];
        return ig ? tag(`${ig.name} · ${fmt.int(ig.count)}`, "fw-ipg", `IP group with ${ig.count} entries`) : tag(`${g.split("/").pop()} (missing)`, "bad", "This IP group could not be found");
      }),
    ];
    return parts.length ? `<div class="fw-list">${parts.join("")}</div>` : `<span class="muted">–</span>`;
  }
  function destCell(r, ipGroups) {
    if (r.type === "Application") {
      const parts = [
        ...(r.targets || []).map((x) => (x === "*" ? `<span class="fw-any">every FQDN</span>` : `<span class="mono">${esc(x)}</span>`)),
        ...(r.urls || []).map((x) => `<span class="mono">${esc(x)}</span>`),
        ...(r.tags || []).map((x) => tag(x, "", "FQDN tag")),
        ...(r.categories || []).map((x) => tag(x, "", "Web category")),
      ];
      const addrs = r.dst || r.dstGroups ? addrList(r.dst, r.dstGroups, ipGroups) : "";
      return (parts.length ? `<div class="fw-list">${parts.join("")}</div>` : "") + addrs || `<span class="muted">–</span>`;
    }
    const to = addrList(r.dst, r.dstGroups, ipGroups, r.fqdns);
    return r.type === "Nat" ? `${to}<div class="fw-nat">→ <span class="mono">${esc(r.translated || "")}</span></div>` : to;
  }
  function portCell(r) {
    if (r.type === "Application") return `<div class="fw-list">${(r.protocols || []).map((p) => `<span class="mono">${esc(p.replace(":", " "))}</span>`).join("")}</div>${r.tls ? tag("TLS inspection", "", "") : ""}`;
    const ports = (r.ports || []).map((p) => (p === "*" ? `<span class="fw-any">all ports</span>` : `<span class="mono">${esc(p)}</span>`)).join("");
    const protos = (r.protocols || []).map((p) => (/^any$/i.test(p) ? "any" : p)).join(", ");
    return `<div class="fw-list">${ports || '<span class="muted">–</span>'}</div><div class="secondary">${esc(protos)}</div>`;
  }
  function marksCell(r) {
    const out = [];
    if (r.mark) {
      const m = MARKS.find(([k]) => k === r.mark.kind) || [r.mark.kind, r.mark.kind, ""];
      out.push(`${tag(m[1] === "Duplicates" ? "Duplicate" : m[1], m[2], r.mark.text)}<div class="fw-why">${esc(r.mark.text)}</div>`);
    }
    for (const w of r.wide || []) out.push(tag(w, w === "matches nothing" ? "" : "warn", ""));
    return out.join(" ");
  }
  const actionTag = (a) => tag(a, a === "Deny" ? "bad" : a === "DNAT" ? "hit" : "good", "");
  function ruleRow(r, ipGroups, extraCol) {
    const name = `<div class="primary">${esc(r.name)}</div>${r.description ? `<div class="secondary">${esc(r.description)}</div>` : ""}`;
    const cells = [
      `<span class="fw-order" title="${esc(TYPE_NAME[r.type])} rule ${r.order}: checked ${ordinal(r.order)} among ${TYPE_NAME[r.type].toLowerCase()} rules">${LETTER[r.type]}${r.order}</span>`,
      name + (extraCol || ""),
      addrList(r.src, r.srcGroups, ipGroups),
      destCell(r, ipGroups),
      portCell(r),
      marksCell(r),
    ];
    const cls = r.mark && r.mark.kind === "never hit" ? " fw-dead" : r.mark ? " fw-dim" : "";
    return `<tr class="fw-rule${cls}">${cells.map((c, i) => `<td class="${["fw-c-order", "fw-c-name", "fw-c-src", "fw-c-dst", "fw-c-port", "fw-c-marks"][i]}">${c}</td>`).join("")}</tr>`;
  }
  const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
  const head = `<thead><tr><th>#</th><th>Rule</th><th>Source</th><th>Destination</th><th>Ports</th><th>Marks</th></tr></thead>`;

  /* filters on the rules */
  function ruleFilter(t, inv) {
    const q = t.filters.q;
    const asIp = ipNum(q);
    const mark = t.filters.fwMark || "";
    const ipGroups = inv.data.ipGroups;
    return (r) => {
      if (mark === "wide" ? !(r.wide && r.wide.length && !(r.wide.length === 1 && r.wide[0] === "matches nothing")) : mark && !(r.mark && r.mark.kind === mark)) return false;
      if (!q) return true;
      if (asIp) return sideHolds(asIp, r.src, r.srcGroups, ipGroups) || sideHolds(asIp, r.dst, r.dstGroups, ipGroups) || (r.translated || "").startsWith(q);
      const groupNames = [...(r.srcGroups || []), ...(r.dstGroups || [])].map((g) => (inv.data.ipGroups[g] || {}).name || g);
      const text = [r.name, r.description, r.type, ...(r.src || []), ...(r.dst || []), ...(r.fqdns || []), ...(r.ports || []), ...(r.protocols || []), ...(r.targets || []), ...(r.urls || []), ...(r.tags || []), ...(r.categories || []), r.translated, ...groupNames].join(" ").toLowerCase();
      return text.includes(q);
    };
  }

  function policyLabel(p) {
    return `${p.name}${p.classic ? " (classic rules)" : ""}`;
  }
  function pickPolicy(t, ps) {
    const cur = ps.find((p) => p.id === t.filters.fwPolicy);
    if (cur) return cur;
    // The busiest policy in use first, so the view opens on something worth reading.
    return [...ps].sort((a, b) => (b.firewalls.length ? 1 : 0) - (a.firewalls.length ? 1 : 0) || (b.findingCount || 0) - (a.findingCount || 0) || b.ruleCount - a.ruleCount)[0];
  }
  function facts(p, ps) {
    const parent = p.base ? ps.find((x) => x.id === p.base) : null;
    const children = (p.children || []).map((c) => (ps.find((x) => x.id === c) || {}).name || c.split("/").pop());
    const items = [
      [p.classic ? "Classic firewall" : `${p.tier || "Standard"} policy`, `${p.resourceGroup ? "rg " + p.resourceGroup : ""}`],
      ["Firewalls", p.firewalls.length ? p.firewalls.join(", ") : "none"],
      ...(p.base ? [["Parent policy", parent ? parent.name : p.base.split("/").pop()]] : []),
      ...(children.length ? [["Child policies", children.join(", ")]] : []),
      ["Threat intelligence", p.threatIntel || "–"],
      ...(p.classic ? [] : [["IDPS", p.idps || (String(p.tier).toLowerCase() === "premium" ? "Off" : "Premium only")], ["DNS proxy", p.dnsProxy ? "On" : "Off"]]),
      ["Rules", `${fmt.int(p.ruleCount || 0)}${p.inheritedCount ? ` + ${fmt.int(p.inheritedCount)} inherited` : ""}`],
    ];
    return `<div class="fw-facts">${items.map(([k, v]) => `<div class="fw-fact"><span class="muted">${esc(k)}</span><b>${esc(v)}</b></div>`).join("")}${p.rulesError ? `<div class="fw-fact bad"><span class="muted">Rules not read</span><b>${esc(p.rulesError)}</b></div>` : ""}</div>`;
  }

  function policySelect(d, ps, p) {
    const multi = d.tenants.length > 1;
    return `<label class="fw-pick">Policy <select class="select" data-filter="fwPolicy">${ps
      .map((x) => `<option value="${esc(x.id)}"${x === p ? " selected" : ""}>${esc(policyLabel(x))}${multi && x.tenantName ? ` · ${esc(x.tenantName)}` : ""} · ${fmt.int(x.ruleCount || 0)} rules${x.findingCount ? ` · ${fmt.int(x.findingCount)} findings` : ""}</option>`)
      .join("")}</select></label>`;
  }

  /* Reach map: one VM or address in the middle, the rules that let traffic in on the left, out on the right */
  function hostOf(d, text) {
    const s = String(text || "").trim();
    if (!s) return null;
    const asIp = ipNum(s);
    if (asIp) return { ip: s, q: asIp, host: asIp.start === asIp.end ? d.hosts.find((h) => h.ip === s) : null };
    const low = s.toLowerCase();
    const h = d.hosts.find((x) => `${x.name} · ${x.ip}`.toLowerCase() === low) || d.hosts.find((x) => x.name.toLowerCase() === low);
    if (h) return { ip: h.ip, q: ipNum(h.ip), host: h };
    // "name · 10.1.2.3" typed or pasted with another separator: the address at the end decides.
    const tail = /(\d{1,3}(?:\.\d{1,3}){3})\s*$/.exec(s);
    if (tail && ipNum(tail[1])) return { ip: tail[1], q: ipNum(tail[1]), host: d.hosts.find((x) => x.ip === tail[1]) || null };
    return { error: `No VM or address called "${s}"` };
  }
  function short(list, n = 3) {
    const xs = list.filter(Boolean);
    return xs.length > n ? `${xs.slice(0, n).join(", ")} +${xs.length - n}` : xs.join(", ");
  }
  function peerText(entries, groups, fqdns, ipGroups) {
    const xs = [...(entries || []).map((e) => (e === "*" ? "any" : e)), ...(fqdns || []), ...(groups || []).map((g) => (ipGroups[g] ? ipGroups[g].name : g.split("/").pop() + " (missing)"))];
    return xs.length ? xs : ["–"];
  }
  function reachCard(r, c, g, dir, ipGroups) {
    const peer = r.type === "Application"
      ? [...(r.targets || []).map((x) => (x === "*" ? "every FQDN" : x)), ...(r.urls || []), ...(r.tags || []), ...(r.categories || [])]
      : dir === "in" ? peerText(r.src, r.srcGroups, null, ipGroups) : peerText(r.dst, r.dstGroups, r.fqdns, ipGroups);
    const ports = r.type === "Application"
      ? (r.protocols || []).map((x) => x.replace(":", " ")).join(", ")
      : `${(r.ports || []).map((x) => (x === "*" ? "all ports" : x)).join(", ")} ${(r.protocols || []).map((x) => (/^any$/i.test(x) ? "any" : x)).join("/")}`;
    const action = c.action;
    const dead = r.mark && ["never hit", "covered", "duplicate"].includes(r.mark.kind);
    const any = peer.includes("any") || peer.includes("every FQDN");
    const title = `${r.name} in ${g.name} › ${c.name}${r.mark ? ": " + r.mark.text : ""}`;
    return `<div class="fw-card ${{ Allow: "fw-allow", Deny: "fw-deny", DNAT: "fw-dnat" }[action] || ""}${dead ? " fw-card-dead" : ""}" title="${esc(title)}">
      <div class="fw-card-peer${any ? " fw-any" : ""}">${esc(short(peer))}</div>
      <div class="fw-card-ports mono">${esc(ports.trim() || "–")}${r.type === "Nat" ? ` → ${esc(r.translated || "")}` : ""}</div>
      <div class="fw-card-rule"><span class="fw-order">${LETTER[r.type]}${r.order}</span> ${esc(r.name)} ${actionTag(action)}${dead ? ` ${tag(r.mark.kind, r.mark.kind === "never hit" ? "bad" : "", r.mark.text)}` : ""}</div>
    </div>`;
  }
  function reachView(t) {
    const inv = inventory(t);
    if (!inv) return loading();
    if (inv.error) return failed(inv.error);
    const d = inv.data;
    if (!d.updatedAt || !d.policies.length) return noInventory();
    d.hosts = d.hosts || [];
    const ps = [...d.policies].sort((a, b) => policyLabel(a).localeCompare(policyLabel(b)));
    const p = pickPolicy(t, ps);
    const pick = hostOf(d, t.filters.fwHost);
    const vms = [...d.hosts].sort((a, b) => a.name.localeCompare(b.name));
    const input = `<label class="fw-pick">VM or IP <input class="input fw-host" list="fw-hosts" data-fw-host value="${esc(t.filters.fwHost || "")}" placeholder="Pick a VM or type 10.20.2.4" autocomplete="off"></label><datalist id="fw-hosts">${vms.slice(0, 5000).map((h) => `<option value="${esc(`${h.name} · ${h.ip}`)}"></option>`).join("")}</datalist>`;
    const top = `<div class="fw-top">${policySelect(d, ps, p)}${input}</div>`;
    if (!pick) return `${top}<div class="empty-state big"><h3>Pick a VM or type an address</h3><p class="muted">The map shows every rule in the policy that lets traffic reach it or lets it reach something, in the order the firewall checks them.${d.hosts.length ? "" : " Run the scan again to get the list of VMs."}</p></div>`;
    if (pick.error) return `${top}<div class="empty-state">${esc(pick.error)}</div>`;
    const rows = p.view.flatMap((g) => g.collections.flatMap((c) => c.rules.map((r) => ({ r, c, g }))));
    const rank = { Nat: 0, Network: 1, Application: 2 };
    rows.sort((a, b) => rank[a.r.type] - rank[b.r.type] || a.r.order - b.r.order);
    const ipGroups = d.ipGroups;
    const holds = (entries, groups) => sideHolds(pick.q, entries, groups, ipGroups);
    const inbound = rows.filter(({ r }) => r.type !== "Application" && (holds(r.dst, r.dstGroups) || (r.type === "Nat" && String(r.translated || "").split(":")[0] === pick.ip)));
    const outbound = rows.filter(({ r }) => r.type !== "Nat" && holds(r.src, r.srcGroups));
    const col = (list, dir, title, empty) => `<div class="fw-col"><div class="fw-col-head">${esc(title)} <span class="muted">${fmt.int(list.length)}</span></div>${list.length ? list.map(({ r, c, g }) => reachCard(r, c, g, dir, ipGroups)).join("") : `<div class="muted small fw-col-empty">${esc(empty)}</div>`}</div>`;
    const h = pick.host;
    const center = `<div class="fw-center"><div class="fw-host-card"><span class="muted small">${h ? (h.kind === "vm" ? "Virtual machine" : "Network interface") : "Address"}</span><b>${esc(h ? h.name : pick.ip)}</b><span class="mono">${esc(pick.ip)}</span>${h && h.resourceGroup ? `<span class="muted small">rg ${esc(h.resourceGroup)}</span>` : ""}</div></div>`;
    const map = `<div class="fw-map">${col(inbound, "in", "Can reach it", "No rule lets traffic in to this address")}${center}${col(outbound, "out", "It can reach", "No rule lets this address out")}</div>`;
    return `${top}${map}<p class="muted small fw-note">Cards are in the order the firewall checks them; the first rule that matches a connection decides it, and anything no rule allows is denied. Struck-out cards never apply (an earlier rule takes all their traffic). Only rules in ${esc(p.name)} are shown, and only traffic a route sends through the firewall meets them.</p>`;
  }

  function rulesView(t) {
    const inv = inventory(t);
    if (!inv) return loading();
    if (inv.error) return failed(inv.error);
    const d = inv.data;
    if (!d.updatedAt || !d.policies.length) return noInventory();
    const ps = [...d.policies].sort((a, b) => policyLabel(a).localeCompare(policyLabel(b)));
    const p = pickPolicy(t, ps);
    const layout = t.filters.fwLayout === "order" ? "order" : "groups";
    const keep = ruleFilter(t, inv);
    const allRules = p.view.flatMap((g) => g.collections.flatMap((c) => c.rules.map((r) => ({ r, g, c }))));
    const shown = allRules.filter((x) => keep(x.r));
    const count = (k) => allRules.filter(({ r }) => (k === "wide" ? r.wide && r.wide.some((w) => w !== "matches nothing") : r.mark && r.mark.kind === k)).length;
    const select = policySelect(d, ps, p);
    const chips = `<div class="fw-chips"><button type="button" class="chip${!t.filters.fwMark ? " active" : ""}" data-fw-mark="">All <span class="n">${fmt.int(allRules.length)}</span></button>${MARKS.map(([k, label]) => {
      const n = count(k);
      return n ? `<button type="button" class="chip${t.filters.fwMark === k ? " active" : ""}" data-fw-mark="${esc(k)}">${esc(label)} <span class="n">${fmt.int(n)}</span></button>` : "";
    }).join("")}</div>`;
    const seg = `<div class="seg"><button type="button" data-fw-layout="groups" class="${layout === "groups" ? "active" : ""}">By group</button><button type="button" data-fw-layout="order" class="${layout === "order" ? "active" : ""}">Processing order</button></div>`;
    const top = `<div class="fw-top">${select}${seg}</div>${facts(p, ps)}${chips}`;
    if (!allRules.length) return `${top}<div class="empty-state">This policy has no rules${p.view.length ? ` (${p.view.length} empty group${p.view.length === 1 ? "" : "s"})` : ""}.</div>`;
    if (!shown.length) return `${top}<div class="empty-state">No rule in this policy matches.</div>`;
    let body;
    if (layout === "order") {
      const rank = { Nat: 0, Network: 1, Application: 2 };
      const flat = [...shown].sort((a, b) => rank[a.r.type] - rank[b.r.type] || a.r.order - b.r.order);
      const sections = ["Nat", "Network", "Application"].map((type) => {
        const part = flat.filter((x) => x.r.type === type);
        if (!part.length) return "";
        const rows = part.map(({ r, g, c }) => ruleRow(r, d.ipGroups, `<div class="secondary">${esc(g.name)} › ${esc(c.name)} ${actionTag(c.action)}${g.inherited ? ` ${tag("from " + g.inherited, "", "Inherited from the parent policy")}` : ""}</div>`));
        return `<tr class="fw-coll"><td colspan="6"><b>${TYPE_NAME[type]} rules</b> <span class="muted">checked ${type === "Nat" ? "first" : type === "Network" ? "after DNAT" : "last, only if no network rule matched"}</span></td></tr>${rows.join("")}`;
      });
      body = `<div class="table-wrap"><table class="data fw-table">${head}<tbody>${sections.join("")}</tbody></table></div>`;
    } else {
      const ids = new Set(shown.map((x) => x.r));
      body = p.view
        .map((g) => {
          const colls = g.collections
            .map((c) => {
              const rows = c.rules.filter((r) => ids.has(r));
              if (!rows.length && (t.filters.q || t.filters.fwMark)) return "";
              return `<tr class="fw-coll"><td colspan="6">${actionTag(c.action)} <b>${esc(c.name)}</b> <span class="muted">priority ${fmt.int(c.priority)} · ${fmt.int(c.rules.length)} rule${c.rules.length === 1 ? "" : "s"}</span></td></tr>${rows.length ? rows.map((r) => ruleRow(r, d.ipGroups)).join("") : `<tr><td colspan="6" class="muted">No rules</td></tr>`}`;
            })
            .join("");
          if (!colls) return "";
          return `<div class="fw-group"><div class="fw-group-head"><b>${esc(g.name)}</b><span class="muted">priority ${fmt.int(g.priority)}</span>${g.inherited ? tag(`inherited from ${g.inherited}`, "hit", "Rules from the parent policy are checked before this policy's own") : ""}</div><div class="table-wrap"><table class="data fw-table">${head}<tbody>${colls}</tbody></table></div></div>`;
        })
        .join("");
    }
    return `${top}${body}<p class="muted small fw-note">D, N and A number the DNAT, network and application rules in the order the firewall checks them: DNAT first, then network, then application rules; a parent policy's rules before its own; then by group and collection priority. An IP address in the search finds the rules whose source or destination holds it, IP groups included.</p>`;
  }

  document.addEventListener("click", (e) => {
    const el = e.target.closest && e.target.closest("[data-fw-mark],[data-fw-layout]");
    if (!el || !el.closest("#page-scan")) return;
    const t = toolState(ID);
    if (el.dataset.fwLayout) t.filters.fwLayout = el.dataset.fwLayout;
    else t.filters.fwMark = t.filters.fwMark === el.dataset.fwMark ? "" : el.dataset.fwMark;
    rerender();
  });

  // The VM or IP box: picking from the list or pressing Enter draws the map.
  document.addEventListener("change", (e) => {
    const el = e.target;
    if (!el.matches || !el.matches("#page-scan [data-fw-host]")) return;
    toolState(ID).filters.fwHost = el.value;
    rerender();
  });

  function page(all, t) {
    const v = viewOf(t);
    return v === "rules" ? rulesView(t) : v === "reach" ? reachView(t) : null;
  }

  VIEWS[ID] = { stats, extra, page, showKinds: (t) => viewOf(t) === "findings", body: genericBody };
})();
