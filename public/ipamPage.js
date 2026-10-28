"use strict";
/* IPAM page: where there are free addresses. Every virtual network with its subnets, how many addresses each subnet
   has left and the next free ones; a subnet opens to an address map (who holds which address, what is free) from
   /api/ipam/subnet. A second view finds free blocks for a new VNet or subnet (/api/ipam/free). Everything comes from
   the address inventory the IP addresses scan saves (/api/ipam); the findings stay on that scan's page.
   Uses esc(), fmt, icon, statTile, subCell, nameCell, tableHtml, apiJson, canRun and $ from app.js. */
const Ipam = (() => {
  const MAP_MAX = 1024; // subnets up to a /22 get the address map
  const st = { gen: 0, data: null, loading: null, error: null, built: false, q: "", view: "subnets", open: new Set(), openSub: new Set(), details: new Map(), free: { pool: "", size: 24, custom: "" }, freeResult: null, freeLoading: null };

  /* addresses */
  function ipNum(s) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(String(s || "").trim());
    if (!m || m.slice(1, 5).some((o) => +o > 255) || (m[5] && +m[5] > 32)) return null;
    const ip = ((+m[1] * 256 + +m[2]) * 256 + +m[3]) * 256 + +m[4];
    const size = 2 ** (32 - (m[5] === undefined ? 32 : +m[5]));
    const start = Math.floor(ip / size) * size;
    return { start, end: start + size - 1, size, single: m[5] === undefined };
  }
  const toIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
  const hits = (q, prefixes) => prefixes.some((p) => {
    const r = ipNum(p);
    return r && r.start <= q.end && q.start <= r.end;
  });
  const firstStart = (prefixes) => (ipNum(prefixes[0]) || { start: 0 }).start;
  const subKey = (v, s) => `${v.id}|${s.name}`;
  const mono = (list) => (list || []).map((p) => `<span class="mono">${esc(p)}</span>`).join("<br>");
  const freeOf = (s) => (s.usable > 0 ? Math.max(0, s.usable - s.used) : null);

  /* data */
  function load() {
    if (st.loading) return st.loading;
    const gen = st.gen;
    st.loading = apiJson("/api/ipam")
      .then((d) => {
        if (gen !== st.gen) return;
        st.data = d;
        st.error = null;
      })
      .catch((err) => gen === st.gen && (st.error = err.message))
      .finally(() => {
        if (gen !== st.gen) return;
        st.loading = null;
        if (state.route === "ipam") render();
      });
    return st.loading;
  }
  function detail(v, s) {
    const key = subKey(v, s);
    const d = st.details.get(key);
    if (d) return d;
    const entry = { loading: true };
    st.details.set(key, entry);
    apiJson(`/api/ipam/subnet?${new URLSearchParams({ vnet: v.id, subnet: s.name })}`)
      .then((x) => (entry.data = x))
      .catch((err) => (entry.error = err.message))
      .finally(() => {
        entry.loading = false;
        if (state.route === "ipam") renderBody();
      });
    return entry;
  }

  /* page */
  function show() {
    const page = $("#page-ipam");
    if (!st.built) {
      page.innerHTML = `
        <div class="page-head">
          <div><h1>IPAM</h1><p class="page-sub">Free addresses in every virtual network: how many each subnet has left, which ones, and room for new subnets and VNets.</p></div>
          <div class="page-actions"><div class="last-run" id="ipam-updated"></div></div>
        </div>
        <div class="stat-row" id="ipam-stats"></div>
        <div class="card">
          <div class="card-head">
            <div class="seg" id="ipam-view"><button type="button" data-view="subnets" class="active">Networks</button><button type="button" data-view="free">Find a free range</button></div>
            <div class="card-tools"><input class="input search" id="ipam-q" type="search" placeholder="Search a name, range or IP address" /></div>
          </div>
          <div id="ipam-body"></div>
        </div>`;
      page.addEventListener("click", onClick);
      page.addEventListener("change", onChange);
      let timer = null;
      $("#ipam-q").addEventListener("input", (e) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          st.q = e.target.value.trim().toLowerCase();
          renderBody();
        }, 150);
      });
      st.built = true;
    }
    render();
    if (!st.data && !st.error) load();
  }

  function render() {
    $$("#ipam-view [data-view]").forEach((b) => b.classList.toggle("active", b.dataset.view === st.view));
    $("#ipam-q").classList.toggle("hidden", st.view !== "subnets");
    const d = st.data;
    $("#ipam-updated").textContent = d && d.updatedAt ? `Saved by the IP addresses scan ${fmt.rel(d.updatedAt)}` : "";
    $("#ipam-stats").innerHTML = d && d.vnets && d.vnets.length ? stats(d) : "";
    renderBody();
  }
  function renderBody() {
    const el = $("#ipam-body");
    if (st.error) el.innerHTML = `<div class="empty-state big"><h3>Could not load the address inventory</h3><p class="muted">${esc(st.error)}</p></div>`;
    else if (!st.data) el.innerHTML = `<div class="empty-state">Loading the address inventory…</div>`;
    else if (!st.data.updatedAt) el.innerHTML = `<div class="empty-state big"><h3>No address inventory yet</h3><p>The IP addresses scan saves it. <a href="#/scan/ipam">Run that scan</a>${canRun("ipam") ? "" : " (or ask someone who may)"} and the networks show here.</p></div>`;
    else el.innerHTML = st.view === "free" ? freeView() : networks();
  }

  function stats(d) {
    const subnets = d.vnets.flatMap((v) => v.subnets);
    const counted = subnets.filter((s) => s.usable > 0);
    const free = counted.reduce((n, s) => n + freeOf(s), 0);
    const usable = counted.reduce((n, s) => n + s.usable, 0);
    const tight = counted.filter((s) => freeOf(s) / s.usable < 0.2).length;
    const unallocated = d.vnets.reduce((n, v) => n + (v.unallocated || 0), 0);
    return (
      statTile({ label: "Virtual networks", value: fmt.int(d.vnets.length), delta: `${fmt.int(subnets.length)} subnets` }) +
      statTile({ label: "Free in subnets", value: fmt.int(free), delta: usable ? `of ${fmt.int(usable)} usable addresses` : "" }) +
      statTile({ label: "Subnets under 20% free", value: fmt.int(tight), deltaCls: tight ? "bad" : "" }) +
      statTile({ label: "Not in any subnet", value: fmt.compact(unallocated), delta: "addresses for new subnets" })
    );
  }

  /* Networks: a row per VNet, opened to its subnets and the room left for new ones */
  function networks() {
    const d = st.data;
    const q = st.q;
    const asIp = ipNum(q);
    const text = (v) => [v.name, v.resourceGroup, v.subscriptionName, v.subscriptionId, v.tenantName, v.location, ...v.prefixes, ...v.subnets.flatMap((s) => [s.name, ...s.prefixes])].join(" ").toLowerCase();
    const match = (v) => !q || (asIp ? hits(asIp, [...v.prefixes, ...v.subnets.flatMap((s) => s.prefixes)]) : text(v).includes(q));
    const vnets = d.vnets.filter(match).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    if (!vnets.length) return `<div class="empty-state">${d.vnets.length ? (asIp ? "No virtual network holds that address." : "No networks match the search.") : "No virtual networks found."}</div>`;
    // A search, or only a few networks: open them all.
    const openAll = Boolean(q) || d.vnets.length <= 3;
    const rows = vnets.map((v) => {
      const open = openAll || st.open.has(v.id);
      const counted = v.subnets.filter((s) => s.usable > 0);
      const free = counted.reduce((n, s) => n + freeOf(s), 0);
      const usable = counted.reduce((n, s) => n + s.usable, 0);
      const room = v.largestFree ? `<b>${fmt.int(v.unallocated)}</b><div class="secondary">largest block <span class="mono">${esc(v.largestFree)}</span></div>` : `<span class="muted">none</span>`;
      const cells = [
        `<button type="button" class="ipam-vnet" data-vnet="${esc(v.id)}" aria-expanded="${open}">${icon("chevron")}<span>${nameCell(v, null, `${v.location || ""}${v.resourceGroup ? " · rg " + v.resourceGroup : ""}`)}</span></button>`,
        subCell(v),
        mono(v.prefixes),
        usable ? `<b>${fmt.int(free)}</b> <span class="muted small">of ${fmt.int(usable)}</span><div class="secondary">${fmt.int(v.subnets.length)} subnet${v.subnets.length === 1 ? "" : "s"}</div>` : `<span class="muted">${fmt.int(v.subnets.length)} subnets</span>`,
        room,
      ];
      const main = `<tr class="ipam-vnet-row${open ? " open" : ""}">${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
      return main + (open ? `<tr class="ipam-sub-row"><td colspan="5">${subnetTable(v, asIp)}</td></tr>` : "");
    });
    const head = ["Network", "Subscription", "Address space", "Free in subnets", "Not in any subnet"];
    return (
      `<div class="table-wrap"><table class="data ipam-table"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` +
      sites(d, q, asIp) +
      `<div class="note">IPv4. Azure keeps 5 addresses in every subnet (the first four and the last); they are not counted as free.</div>`
    );
  }

  function subnetTable(v, asIp) {
    const subs = [...v.subnets].sort((a, b) => firstStart(a.prefixes) - firstStart(b.prefixes));
    const room = v.freeBlocks && v.freeBlocks.length
      ? `<div class="ipam-room"><b class="small">Room for new subnets</b> ${v.freeBlocks.slice(0, 12).map((b) => `<span class="tag mono">${esc(b)}</span>`).join("")}${v.freeBlocks.length > 12 ? ` <span class="muted small">and ${fmt.int(v.freeBlocks.length - 12)} more</span>` : ""}</div>`
      : `<div class="ipam-room muted small">The address space is fully divided into subnets.</div>`;
    if (!subs.length) return `<div class="muted small">No subnets.</div>` + room;
    const rows = subs.map((s) => {
      const key = subKey(v, s);
      const hit = asIp && hits(asIp, s.prefixes);
      // Searching one address opens the subnet that holds it.
      const open = st.openSub.has(key) || (hit && asIp.single);
      const free = freeOf(s);
      const pct = s.usable > 0 ? (s.used / s.usable) * 100 : 0;
      const cls = pct >= 95 ? " crit" : pct >= 80 ? " warn" : "";
      const freeCell = free == null
        ? `<span class="muted">no usage data</span>`
        : `<div class="ipam-free"><b>${fmt.int(free)}</b><span class="muted small">free of ${fmt.int(s.usable)}</span></div><div class="ip-bar${cls}"><span style="width:${Math.min(100, pct).toFixed(1)}%"></span></div>`;
      const next = s.nextFree && s.nextFree.length
        ? s.nextFree.map((f) => `<span class="mono">${esc(f.count > 1 ? `${f.from} – ${f.to}` : f.from)}</span>`).join("<br>")
        : `<span class="muted">${s.listKnown ? "none" : "–"}</span>`;
      const btn = `<button type="button" class="chip${open ? " active" : ""}" data-sub="${esc(key)}">${icon("grid")} Addresses</button>`;
      const main = `<tr${hit ? ' class="ip-hit"' : ""}><td>${esc(s.name)}${s.delegation ? `<div class="secondary">delegated to ${esc(s.delegation)}</div>` : ""}</td><td>${mono(s.prefixes)}</td><td>${freeCell}</td><td>${next}</td><td>${btn}</td></tr>`;
      return main + (open ? `<tr class="ipam-addr-row"><td colspan="5">${addresses(v, s, asIp)}</td></tr>` : "");
    });
    return `<table class="data ipam-subs"><thead><tr><th>Subnet</th><th>Range</th><th>Free</th><th>Next free</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>` + room;
  }

  /* One subnet: a map of its addresses (small subnets), the free runs and who holds the rest */
  function addresses(v, s, asIp) {
    const e = detail(v, s);
    if (e.loading) return `<div class="muted small">Loading addresses…</div>`;
    if (e.error) return `<div class="status-msg error">${esc(e.error)}</div>`;
    const x = e.data;
    if (!x.subnet.listKnown) return `<div class="muted small">The last scan did not list addresses. They show after the IP addresses scan runs again.</div>`;
    const owner = new Map(x.taken.map((t) => [ipNum(t.ip).start, t]));
    const warn = x.unlisted
      ? `<div class="status-msg warn ipam-warn">Azure counts ${fmt.int(x.unlisted)} more address${x.unlisted === 1 ? "" : "es"} in use than are listed here (scale sets such as AKS nodes, App Service or other services Resource Graph does not show). Some addresses shown as free may be taken.</div>`
      : "";
    const map = x.ranges.filter((r) => r.size <= MAP_MAX).map((r) => {
      const start = ipNum(r.start).start;
      const cells = [];
      for (let i = 0; i < r.size; i++) {
        const n = start + i;
        const ip = toIp(n);
        const reserved = r.size >= 8 && (i < 4 || i === r.size - 1);
        const t = owner.get(n);
        const cls = reserved ? "res" : t ? "used" : "free";
        const tip = reserved ? `${ip} · kept by Azure` : t ? `${ip} · ${t.name} (${t.kind}${t.static ? ", static" : ""})` : `${ip} · free`;
        const hit = asIp && asIp.single && asIp.start === n ? " hit" : "";
        cells.push(`<span class="ipam-cell ${cls}${hit}" title="${esc(tip)}"></span>`);
      }
      return `<div class="ipam-map-head mono small">${esc(r.cidr)}</div><div class="ipam-map">${cells.join("")}</div>`;
    }).join("");
    const legend = map ? `<div class="ipam-legend small"><span><i class="ipam-cell free"></i> free</span><span><i class="ipam-cell used"></i> in use</span><span><i class="ipam-cell res"></i> kept by Azure</span><span class="muted">Hover a square for the address.</span></div>` : "";
    const free = x.free.length
      ? `<div class="ip-free">${x.free.map((f) => `<span class="tag mono">${esc(f.count > 1 ? `${f.from} – ${f.to}` : f.from)}${f.count > 1 ? ` <span class="muted">${fmt.int(f.count)}</span>` : ""}</span>`).join("")}</div>${x.freeRuns > x.free.length ? `<div class="note">First ${fmt.int(x.free.length)} of ${fmt.int(x.freeRuns)} free runs.</div>` : ""}`
      : `<div class="muted small">No free addresses.</div>`;
    const hit = asIp && asIp.single ? (t) => ipNum(t.ip).start === asIp.start : () => false;
    const taken = x.taken.length
      ? tableHtml(
          [{ label: "Address" }, { label: "Used by" }, { label: "Kind" }, { label: "Assignment" }],
          x.taken.map((t) => ({ attrs: hit(t) ? 'class="ip-hit"' : "", cells: [`<span class="mono">${esc(t.ip)}</span>`, esc(t.name), esc(t.kind), t.static ? "Static" : '<span class="muted">Dynamic</span>'] })),
          { scroll: true }
        )
      : `<div class="muted small">Nothing listed in this subnet.</div>`;
    let found = "";
    if (asIp && asIp.single) {
      const t = x.taken.find(hit);
      const r = x.ranges.map((g) => ({ g, s: ipNum(g.start).start })).find((g) => asIp.start >= g.s && asIp.start < g.s + g.g.size);
      const kept = r && r.g.size >= 8 && (asIp.start - r.s < 4 || asIp.start === r.s + r.g.size - 1);
      found = `<div class="ipam-found">${icon("search")} <span class="mono">${esc(toIp(asIp.start))}</span> ${
        t ? `is used by <b>${esc(t.name)}</b> (${esc(t.kind)}, ${t.static ? "static" : "dynamic"})` : kept ? "is kept by Azure" : x.unlisted ? "looks free (but see the note below)" : "is free"
      }</div>`;
    }
    return `<div class="ipam-addr">${found}
      <p class="ip-sum"><b>${fmt.int(x.freeCount)}</b> free address${x.freeCount === 1 ? "" : "es"} by the list${x.subnet.usable ? `, <b>${fmt.int(Math.max(0, x.subnet.usable - x.subnet.used))}</b> by Azure's count` : ""} · ${fmt.int(x.taken.length)} listed in use.</p>
      ${warn}${map}${legend}
      <h3 class="ip-h3">Free addresses</h3>${free}
      <h3 class="ip-h3">In use</h3>${taken}
    </div>`;
  }

  function sites(d, q, asIp) {
    const list = d.sites.filter((s) => !q || (asIp ? hits(asIp, s.prefixes) : [s.name, s.subscriptionName, s.tenantName, ...s.prefixes].join(" ").toLowerCase().includes(q)));
    if (!list.length) return "";
    return (
      `<h3 class="ip-h3">Hubs and on-premises sites <span class="muted small">address space a VNet must not reuse</span></h3>` +
      tableHtml([{ label: "Name" }, { label: "Kind" }, { label: "Subscription" }, { label: "Address space" }], list.map((s) => [nameCell(s, null), esc(s.kind === "hub" ? "Virtual WAN hub" : "On-premises (VPN site)"), subCell(s), mono(s.prefixes)]))
    );
  }

  /* Find a free range: a pool (an address-plan range, a VNet's address space or any range typed in) and a size */
  function poolOptions(d) {
    const out = [];
    for (const p of d.pools || []) out.push({ value: `pool|${p}`, label: `${p} · address plan (new VNet)` });
    for (const v of [...d.vnets].sort((a, b) => String(a.name).localeCompare(String(b.name)))) {
      for (const p of v.prefixes) if (ipNum(p)) out.push({ value: `vnet|${v.id}|${p}`, label: `${p} · ${v.name} (new subnet)` });
    }
    return out;
  }
  function freeQuery() {
    const f = st.free;
    if (f.pool === "custom") return f.custom ? { pool: f.custom.trim(), size: f.size } : null;
    const [kind, a, b] = f.pool.split("|");
    if (kind === "pool") return { pool: a, size: f.size };
    if (kind === "vnet") return { pool: b, size: f.size, vnet: a };
    return null;
  }
  function freeResult(q) {
    const key = `${st.data.updatedAt}|${q.pool}|${q.size}|${q.vnet || ""}`;
    if (st.freeResult && st.freeResult.key === key) return st.freeResult;
    if (st.freeLoading !== key) {
      st.freeLoading = key;
      apiJson(`/api/ipam/free?${new URLSearchParams({ pool: q.pool, size: String(q.size), ...(q.vnet && { vnet: q.vnet }) })}`)
        .then((data) => (st.freeResult = { key, data }))
        .catch((err) => (st.freeResult = { key, error: err.message }))
        .finally(() => {
          if (st.freeLoading === key) st.freeLoading = null;
          if (state.route === "ipam") renderBody();
        });
    }
    return null;
  }
  function freeView() {
    const d = st.data;
    const opts = poolOptions(d);
    if (!st.free.pool) st.free.pool = opts.length ? opts[0].value : "custom";
    const q0 = freeQuery();
    // Sizes from the chosen range's own size down to /29 (Azure's smallest subnet).
    const poolBits = q0 && /\/(\d{1,2})$/.test(q0.pool) ? Math.min(29, Number(/\/(\d{1,2})$/.exec(q0.pool)[1])) : 8;
    const sizes = Array.from({ length: 29 - poolBits + 1 }, (_, i) => poolBits + i);
    st.free.size = Math.max(poolBits, st.free.size);
    const q = freeQuery();
    const form = `
      <div class="ip-form">
        <label>Look in <select class="select" data-free="pool">
          ${opts.map((o) => `<option value="${esc(o.value)}"${st.free.pool === o.value ? " selected" : ""}>${esc(o.label)}</option>`).join("")}
          <option value="custom"${st.free.pool === "custom" ? " selected" : ""}>A range I type…</option>
        </select></label>
        ${st.free.pool === "custom" ? `<label>Range <input class="input mono" data-free="custom" placeholder="10.0.0.0/8" value="${esc(st.free.custom)}" /></label>` : ""}
        <label>Size <select class="select" data-free="size">${sizes.map((s) => `<option value="${s}"${s === st.free.size ? " selected" : ""}>/${s} (${fmt.int(2 ** (32 - s))} addresses${q && q.vnet ? `, ${fmt.int(2 ** (32 - s) - 5)} usable` : ""})</option>`).join("")}</select></label>
      </div>`;
    if (!q) return form + `<div class="empty-state">Type a range (like 10.0.0.0/8) and press Enter. ${d.pools && d.pools.length ? "" : "Set your address plan in Settings (IP addresses) to have it offered here."}</div>`;
    const r = freeResult(q);
    if (!r) return form + `<div class="empty-state">Looking for free blocks…</div>`;
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

  /* events */
  function onClick(e) {
    const el = e.target.closest("[data-view],[data-vnet],[data-sub]");
    if (!el) return;
    if (el.dataset.view) {
      st.view = el.dataset.view;
      return render();
    }
    const set = el.dataset.vnet ? st.open : st.openSub;
    const key = el.dataset.vnet || el.dataset.sub;
    if (set.has(key)) set.delete(key);
    else set.add(key);
    renderBody();
  }
  function onChange(e) {
    const k = e.target.dataset && e.target.dataset.free;
    if (!k) return;
    if (k === "size") st.free.size = Number(e.target.value) || 24;
    else st.free[k] = e.target.value;
    renderBody();
  }

  // A tenant tab change: everything shown was for the other tab.
  function reset() {
    Object.assign(st, { gen: st.gen + 1, data: null, loading: null, error: null, open: new Set(), openSub: new Set(), details: new Map(), freeResult: null, freeLoading: null });
    st.free.pool = "";
  }

  return { show, reset };
})();
