"use strict";
/* IP addresses (IPAM) scan page: the findings, every network's address space and subnets with how full they are
   (Networks), and free blocks for a new VNet or subnet (Free ranges). The inventory comes from /api/ipam, saved by
   the last scan; free blocks are worked out by the server (/api/ipam/free). Uses app.js helpers. */
(() => {
  const ID = "ipam";
  const VIEW_LABELS = [["findings", "Findings"], ["networks", "Networks"], ["free", "Free ranges"]];
  const viewOf = (t) => (t.filters.view === "networks" || t.filters.view === "free" ? t.filters.view : "findings");
  const rerender = () => {
    if (state.route === `scan/${ID}`) renderFindings(ID);
  };

  /* data: loaded once per scan run (and again after a tenant tab change, which clears the tool state) */
  function inventory(t) {
    if (t.ipam && t.ipam.ranAt === t.data.ranAt) return t.ipam;
    if (!t.ipamLoading) {
      const ranAt = t.data.ranAt;
      t.ipamLoading = apiJson("/api/ipam")
        .then((data) => (t.ipam = { ranAt, data }))
        .catch((err) => (t.ipam = { ranAt, error: err.message }))
        .finally(() => {
          t.ipamLoading = null;
          rerender();
        });
    }
    return null;
  }
  function freeResult(t, q) {
    const key = `${t.data.ranAt}|${q.pool}|${q.size}|${q.vnet || ""}`;
    if (t.ipFree && t.ipFree.key === key) return t.ipFree;
    if (t.ipFreeLoading !== key) {
      t.ipFreeLoading = key;
      const qs = new URLSearchParams({ pool: q.pool, size: String(q.size), ...(q.vnet && { vnet: q.vnet }) });
      apiJson(`/api/ipam/free?${qs}`)
        .then((data) => (t.ipFree = { key, data }))
        .catch((err) => (t.ipFree = { key, error: err.message }))
        .finally(() => {
          if (t.ipFreeLoading === key) t.ipFreeLoading = null;
          rerender();
        });
    }
    return null;
  }

  /* small parts */
  function ipNum(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(String(s || "").trim());
    if (!m || m.slice(1, 5).some((o) => +o > 255) || (m[5] && +m[5] > 32)) return null;
    const ip = ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4];
    const size = 2 ** (32 - (m[5] === undefined ? 32 : +m[5]));
    const start = Math.floor(ip / size) * size;
    return { start, end: start + size - 1 };
  }
  const overlapsAny = (q, prefixes) => prefixes.some((p) => {
    const r = ipNum(p);
    return r && r.start <= q.end && q.start <= r.end;
  });
  function bar(used, usable) {
    if (!(usable > 0)) return `<span class="muted small">no usage data</span>`;
    const pct = Math.min(100, (used / usable) * 100);
    const cls = pct >= 95 ? " crit" : pct >= 80 ? " warn" : "";
    return `<div class="ip-use"><div class="ip-bar${cls}"><span style="width:${pct.toFixed(1)}%"></span></div><span class="small"><b>${fmt.int(used)}</b> of ${fmt.int(usable)} <span class="muted">(${Math.round(pct)}%)</span></span></div>`;
  }
  const mono = (list) => (list || []).map((p) => `<span class="mono">${esc(p)}</span>`).join("<br>");
  const loading = (what) => `<div class="empty-state">Loading ${esc(what)}…</div>`;
  const failed = (msg) => `<div class="empty-state big"><h3>Could not load the address inventory</h3><p class="muted">${esc(msg)}</p></div>`;
  const noInventory = () =>
    `<div class="empty-state big"><h3>No address inventory yet</h3><p>The inventory is saved by each scan. Run the scan once${canRun() ? " (Run now above)" : ""} and the networks show here.</p></div>`;

  /* stats: the address picture when the inventory is in, else the usual counts */
  function stats(all, t) {
    const inv = inventory(t);
    if (!inv || !inv.data || !inv.data.vnets.length) return genericStats(all, t);
    const v = inv.data.vnets;
    const addresses = v.reduce((n, x) => n + (x.addresses || 0), 0);
    const used = v.reduce((n, x) => n + (x.used || 0), 0);
    const usable = v.reduce((n, x) => n + (x.usable || 0), 0);
    const subnets = v.reduce((n, x) => n + x.subnets.length, 0);
    const n = (k) => all.filter((f) => f.kind === k).length;
    const full = n("subnet-full") + n("subnet-near-full");
    const overlaps = n("ip-overlap") + n("ip-overlap-onprem");
    return (
      statTile({ label: "Virtual networks", value: fmt.int(v.length), delta: `${fmt.int(subnets)} subnets` }) +
      statTile({ label: "Address space", value: fmt.compact(addresses), delta: "addresses in VNets" }) +
      statTile({ label: "In use", value: usable ? `${Math.round((used / usable) * 100)}%` : "–", delta: usable ? `${fmt.int(used)} of ${fmt.int(usable)} subnet addresses` : "" }) +
      statTile({ label: "Subnets filling up", value: fmt.int(full), deltaCls: n("subnet-full") ? "bad" : "", delta: n("subnet-full") ? `${fmt.int(n("subnet-full"))} full` : "" }) +
      statTile({ label: "Overlapping VNets", value: fmt.int(overlaps), deltaCls: overlaps ? "bad" : "" })
    );
  }

  function extra(all, t) {
    const v = viewOf(t);
    // The findings filters mean nothing on the other two views.
    for (const sel of ["#scan-sub", "#scan-fw", "#scan-new"]) $(sel).classList.toggle("hidden", v !== "findings");
    $("#scan-q").placeholder = v === "networks" ? "Search name, range or an IP address" : "Search name, detail, subscription";
    return `<div class="seg">${VIEW_LABELS.map(([k, label]) => `<button type="button" data-view="${k}" class="${v === k ? "active" : ""}">${label}${k === "findings" ? ` <span class="n">${fmt.int(all.length)}</span>` : ""}</button>`).join("")}</div>`;
  }

  /* Networks: one row per VNet, opened to show its subnets and peerings; hubs and on-premises sites below */
  function networks(t) {
    const inv = inventory(t);
    if (!inv) return loading("the address inventory");
    if (inv.error) return failed(inv.error);
    const d = inv.data;
    if (!d.updatedAt) return noInventory();
    const q = t.filters.q;
    const asIp = ipNum(q);
    const match = (x) => {
      if (!q) return true;
      if (asIp) return overlapsAny(asIp, [...x.prefixes, ...(x.subnets || []).flatMap((s) => s.prefixes)]);
      const text = [x.name, x.resourceGroup, x.subscriptionName, x.subscriptionId, x.tenantName, x.location, ...x.prefixes, ...(x.subnets || []).flatMap((s) => [s.name, ...s.prefixes])].join(" ").toLowerCase();
      return text.includes(q);
    };
    const vnets = d.vnets.filter(match).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const sites = d.sites.filter(match);
    const slice = vnets.slice(0, t.shown);
    const rows = slice.map((v) => {
      const key = `ip:${v.id}`;
      const open = t.open.has(key);
      const room = v.largestFree ? `<span class="mono">${esc(v.largestFree)}</span><div class="secondary">${fmt.int(v.unallocated)} addresses unallocated</div>` : `<span class="muted">none</span>`;
      const toggle = `<button type="button" class="chip${open ? " active" : ""}" data-toggle="${esc(key)}">${icon("chevron")} ${fmt.int(v.subnets.length)} subnet${v.subnets.length === 1 ? "" : "s"}</button>`;
      const main = `<tr>${[nameCell(v, null, `${v.location || ""}${v.resourceGroup ? " · rg " + v.resourceGroup : ""}`), subCell(v), mono(v.prefixes), bar(v.used, v.usable), room, toggle].map((c) => `<td>${c}</td>`).join("")}</tr>`;
      return main + `<tr class="ar-members-row${open ? "" : " hidden"}" data-members="${esc(key)}"><td colspan="6">${detail(v, asIp)}</td></tr>`;
    });
    const head = ["Network", "Subscription", "Address space", "Subnet addresses in use", "Largest free block", ""];
    const table = vnets.length
      ? `<div class="table-wrap"><table class="data"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` + moreButton(slice.length, vnets.length, t)
      : `<div class="empty-state">${d.vnets.length ? "No networks match the search." : "No virtual networks found."}</div>`;
    const siteTable = sites.length
      ? `<h3 class="ip-h3">Hubs and on-premises sites <span class="muted small">address space a VNet must not reuse</span></h3>` +
        tableHtml([{ label: "Name" }, { label: "Kind" }, { label: "Subscription" }, { label: "Address space" }], sites.map((s) => [nameCell(s, null), esc(s.kind === "hub" ? "Virtual WAN hub" : "On-premises (VPN site)"), subCell(s), mono(s.prefixes)]))
      : "";
    const note = `<div class="note">Saved by the scan ${esc(fmt.rel(d.updatedAt))}. IPv4 only. Azure keeps 5 addresses in every subnet; they are not counted as usable.</div>`;
    return table + siteTable + note;
  }
  function detail(v, asIp) {
    const subs = [...v.subnets].sort((a, b) => (ipNum(a.prefixes[0]) || { start: 0 }).start - (ipNum(b.prefixes[0]) || { start: 0 }).start);
    const subTable = subs.length
      ? tableHtml(
          [{ label: "Subnet" }, { label: "Range" }, { label: "In use" }, { label: "Delegated to" }],
          subs.map((s) => {
            const hit = asIp && overlapsAny(asIp, s.prefixes);
            return { attrs: hit ? 'class="ip-hit"' : "", cells: [esc(s.name), mono(s.prefixes), bar(s.used, s.usable), s.delegation ? esc(s.delegation) : '<span class="muted">–</span>'] };
          })
        )
      : `<div class="muted small">No subnets.</div>`;
    const peer = v.peerings.length
      ? `<div class="ip-peers"><b class="small">Peerings</b> ${v.peerings
          .map((p) => {
            const bad = p.state !== "Connected" || (p.sync && p.sync !== "FullyInSync");
            return `<span class="tag${bad ? " bad" : ""}" title="${esc(p.remoteId || "")}">${esc(String(p.remoteId || p.name).split("/").pop())} · ${esc(p.state || "?")}${p.sync && p.sync !== "FullyInSync" ? " · " + esc(p.sync) : ""}</span>`;
          })
          .join(" ")}</div>`
      : "";
    return subTable + peer;
  }

  /* Free ranges: pick a pool (an address-plan range, a VNet's address space or any range typed in) and a size */
  function poolOptions(d) {
    const out = [];
    for (const p of d.pools || []) out.push({ value: `pool|${p}`, label: `${p} · address plan` });
    for (const v of [...d.vnets].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      for (const p of v.prefixes) if (ipNum(p)) out.push({ value: `vnet|${v.id}|${p}`, label: `${p} · ${v.name} (new subnet)` });
    }
    return out;
  }
  function freeQuery(t) {
    const sel = t.filters.ipPool || "";
    const size = Number(t.filters.ipSize) || 24;
    if (sel === "custom") return t.filters.ipCustom ? { pool: t.filters.ipCustom.trim(), size } : null;
    const [kind, a, b] = sel.split("|");
    if (kind === "pool") return { pool: a, size };
    if (kind === "vnet") return { pool: b, size, vnet: a };
    return null;
  }
  function free(t) {
    const inv = inventory(t);
    if (!inv) return loading("the address inventory");
    if (inv.error) return failed(inv.error);
    const d = inv.data;
    if (!d.updatedAt) return noInventory();
    const opts = poolOptions(d);
    if (!t.filters.ipPool) t.filters.ipPool = opts.length ? opts[0].value : "custom";
    // Sizes from the chosen range's own size down to /29 (Azure's smallest subnet).
    const q = freeQuery(t);
    const poolBits = q && /\/(\d{1,2})$/.test(q.pool) ? Math.min(29, Number(/\/(\d{1,2})$/.exec(q.pool)[1])) : 8;
    const sizes = Array.from({ length: 29 - poolBits + 1 }, (_, i) => poolBits + i);
    const cur = Math.max(poolBits, Number(t.filters.ipSize) || 24);
    if (q) q.size = cur;
    const form = `
      <div class="ip-form">
        <label>Look in <select class="select" data-filter="ipPool">
          ${opts.map((o) => `<option value="${esc(o.value)}"${t.filters.ipPool === o.value ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
          <option value="custom"${t.filters.ipPool === "custom" ? " selected" : ""}>A range I type…</option>
        </select></label>
        ${t.filters.ipPool === "custom" ? `<label>Range <input class="input mono" data-filter="ipCustom" placeholder="10.0.0.0/8" value="${esc(t.filters.ipCustom || "")}" /></label>` : ""}
        <label>Size <select class="select" data-filter="ipSize">${sizes.map((s) => `<option value="${s}"${s === cur ? " selected" : ""}>/${s} (${fmt.int(2 ** (32 - s))} addresses${q && q.vnet ? `, ${fmt.int(2 ** (32 - s) - 5)} usable` : ""})</option>`).join("")}</select></label>
      </div>`;
    if (!q) return form + `<div class="empty-state">Type a range (like 10.0.0.0/8) and press Enter. ${d.pools && d.pools.length ? "" : "Set your address plan in Settings (IP addresses) to have it offered here."}</div>`;
    const r = freeResult(t, q);
    if (!r) return form + loading("free blocks");
    if (r.error) return form + `<div class="status-msg error">${esc(r.error)}</div>`;
    const x = r.data;
    const what = q.vnet ? "subnets in this VNet" : "VNets, hubs and on-premises sites seen in the scan";
    const summary = `<p class="ip-sum"><b>${fmt.int(x.count)}</b> free /${x.size} block${x.count === 1 ? "" : "s"} in <span class="mono">${esc(x.pool)}</span> · ${fmt.int(x.freeAddresses)} of ${fmt.int(x.addresses)} addresses not used by ${esc(what)}.</p>`;
    const list = x.free.length
      ? `<div class="ip-free">${x.free.map((c) => `<span class="tag mono">${esc(c)}</span>`).join("")}</div>${x.count > x.free.length ? `<div class="note">First ${fmt.int(x.free.length)} shown, lowest first.</div>` : ""}`
      : `<div class="empty-state">No free /${x.size} left in this range.</div>`;
    const taken = x.taken.length
      ? `<h3 class="ip-h3">Already used in this range</h3>` +
        tableHtml([{ label: "Range" }, { label: "Used by" }], x.taken.map((u) => [`<span class="mono">${esc(u.cidr)}</span>`, `${u.tenantName ? `<span class="tenant-badge">${esc(u.tenantName)}</span>` : ""}${esc(u.owner)}`]), { scroll: true })
      : "";
    const caveat = q.vnet
      ? `<div class="note">Azure keeps 5 addresses in every subnet (the first four and the last), so a /${x.size} subnet gives ${fmt.int(2 ** (32 - x.size) - 5)} usable addresses.</div>`
      : `<div class="note">Only ranges this dashboard can see are avoided. Check other tenants, other clouds and on-premises networks not set up as VPN sites before using one.</div>`;
    return form + summary + list + taken + caveat;
  }

  function page(all, t) {
    const v = viewOf(t);
    if (v === "networks") return networks(t);
    if (v === "free") return free(t);
    return null;
  }

  VIEWS[ID] = { stats, extra, page, showKinds: (t) => viewOf(t) === "findings", body: genericBody };
})();
