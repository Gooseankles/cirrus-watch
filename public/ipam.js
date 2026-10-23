"use strict";
/* IP addresses (IPAM) scan page: the findings, every network's address space and subnets with how full they are
   (Networks), the firewall IP groups with their entries and a compare against a pasted list (IP groups), and free
   blocks for a new VNet or subnet (Free ranges). The inventory comes from /api/ipam, saved by the last scan; free
   blocks are worked out by the server (/api/ipam/free). The compare runs in the browser on a button press and
   changes nothing in Azure: it hands back the az command to run. Uses app.js helpers. */
(() => {
  const ID = "ipam";
  const VIEW_LABELS = [["findings", "Findings"], ["networks", "Networks"], ["ipgroups", "IP groups"], ["free", "Free ranges"]];
  const viewOf = (t) => (VIEW_LABELS.some(([k]) => k !== "findings" && k === t.filters.view) ? t.filters.view : "findings");
  const IPGROUP_LIMIT = 5000;
  const CMD_MAX = 8000; // a Windows command line holds 8191 characters
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
      statTile({ label: "Overlapping VNets", value: fmt.int(overlaps), deltaCls: overlaps ? "bad" : "" }) +
      (inv.data.ipGroups
        ? statTile({ label: "IP groups", value: fmt.int(inv.data.ipGroups.length), delta: `${fmt.int(inv.data.ipGroups.reduce((n, g) => n + g.entries.length, 0))} entries` })
        : "")
    );
  }

  function extra(all, t) {
    const v = viewOf(t);
    // The findings filters mean nothing on the other two views.
    for (const sel of ["#scan-sub", "#scan-fw", "#scan-new"]) $(sel).classList.toggle("hidden", v !== "findings");
    $("#scan-q").placeholder = v === "networks" || v === "ipgroups" ? "Search name, range or an IP address" : "Search name, detail, subscription";
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

  /* IP groups: one row per group, opened to show its entries, its last change and the compare box */
  const IPV4 = String.raw`(\d{1,3}(?:\.\d{1,3}){3})`;
  function ipVal(s) {
    const o = String(s).split(".").map(Number);
    return o.length === 4 && o.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) ? ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3] : null;
  }
  const toIp = (n) => [24, 16, 8, 0].map((s) => Math.floor(n / 2 ** s) % 256).join(".");
  function cidrEntry(start, bits) {
    const size = 2 ** (32 - bits);
    const net = Math.floor(start / size) * size;
    return { text: bits === 32 ? toIp(net) : `${toIp(net)}/${bits}`, start: net, end: net + size - 1 };
  }
  // A netmask (255.255.255.0) or a wildcard mask (0.0.0.255) -> prefix bits, else null.
  function maskBits(s) {
    const n = ipVal(s);
    if (n === null) return null;
    for (let bits = 1; bits <= 32; bits++) if (n === 2 ** 32 - 2 ** (32 - bits)) return bits;
    for (let bits = 1; bits <= 31; bits++) if (n === 2 ** (32 - bits) - 1) return bits;
    return null;
  }
  // An IP group entry as Azure holds it: address, CIDR or "a-b" range.
  function entryOf(text) {
    const s = String(text || "").trim();
    const dash = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(s);
    if (dash) {
      const a = ipVal(dash[1]);
      const b = ipVal(dash[2]);
      return a !== null && b !== null && b >= a ? { text: s, start: a, end: b } : null;
    }
    const m = /^([\d.]+)(?:\/(\d{1,2}))?$/.exec(s);
    const a = m && ipVal(m[1]);
    if (a === null || !m || (m[2] && +m[2] > 32)) return null;
    return { ...cidrEntry(a, m[2] ? +m[2] : 32), text: s };
  }
  // Every address, CIDR, range ("a - b") and address with a netmask or wildcard mask in any pasted text (a VLAN
  // list, a switch config, a spreadsheet column). Host bits are cleared: 10.1.2.3/24 becomes 10.1.2.0/24.
  function extract(text) {
    const tokens = [];
    const re = new RegExp(String.raw`(?<![\d.])${IPV4}(?:\s*\/\s*(\d{1,2})(?![\d.]))?(?!\d|\.\d)`, "g");
    for (let m; (m = re.exec(text)); ) tokens.push({ ip: m[1], bits: m[2], at: m.index, end: re.lastIndex });
    const entries = [];
    const skipped = [];
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      const next = tokens[i + 1];
      const gap = next ? text.slice(tok.end, next.at) : null;
      const start = ipVal(tok.ip);
      if (start === null || (tok.bits && +tok.bits > 32)) {
        skipped.push(tok.ip + (tok.bits ? `/${tok.bits}` : ""));
        continue;
      }
      if (!tok.bits && next && !next.bits && /^\s*-\s*$/.test(gap)) {
        const end = ipVal(next.ip);
        if (end !== null && end >= start) {
          entries.push({ text: `${tok.ip}-${next.ip}`, start, end });
          i++;
          continue;
        }
      }
      if (!tok.bits && next && !next.bits && /^[ \t]*\/?[ \t]*$/.test(gap) && maskBits(next.ip) !== null && next.ip !== "0.0.0.0") {
        entries.push(cidrEntry(start, maskBits(next.ip)));
        i++;
        continue;
      }
      entries.push(cidrEntry(start, tok.bits ? +tok.bits : 32));
    }
    // Drop repeats and entries another entry already covers (a host inside a listed /24).
    const covered = new Set();
    let widest = null;
    for (const e of [...entries].sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (widest && e.end <= widest.end) covered.add(e);
      else widest = e;
    }
    return { entries: entries.filter((e) => !covered.has(e)), skipped };
  }
  function spans(entries) {
    const out = [];
    for (const e of [...entries].sort((a, b) => a.start - b.start)) {
      const last = out[out.length - 1];
      if (last && e.start <= last.end + 1) last.end = Math.max(last.end, e.end);
      else out.push({ start: e.start, end: e.end });
    }
    return out;
  }
  const coveredBy = (e, sp) => sp.some((s) => s.start <= e.start && e.end <= s.end);

  // Compares by addresses, not by text: 10.0.0.0/31 in the list matches 10.0.0.0-10.0.0.1 in Azure.
  function compare(g, text) {
    const list = extract(text);
    const have = g.entries.map(entryOf).filter(Boolean);
    const haveSp = spans(have);
    const listSp = spans(list.entries);
    const missing = list.entries.filter((e) => !coveredBy(e, haveSp));
    const extra = have.filter((e) => !coveredBy(e, listSp));
    return { list: list.entries, skipped: list.skipped, missing, extra, same: list.entries.length - missing.length };
  }
  function azCommand(g, entries) {
    return `az network ip-group update --subscription "${g.subscriptionId}" --resource-group "${g.resourceGroup}" --name "${g.name}" --ip-addresses ${entries.join(" ")}`;
  }
  const cmpState = (t, id) => ((t.ipCmp || (t.ipCmp = {}))[id] || (t.ipCmp[id] = { text: "", mode: "add", result: null }));
  const tags = (list, cls, hit) => list.map((e) => `<span class="tag mono${cls ? " " + cls : ""}${hit && hit(e) ? " hit" : ""}">${esc(e.text || e)}</span>`).join("");

  function compareHtml(g, t) {
    const c = cmpState(t, g.id);
    const form = `
      <h3 class="ip-h3">Compare with a list <span class="muted small">paste the on-premises VLANs or any text with addresses, CIDRs or ranges</span></h3>
      <textarea class="input" data-ipcmp-text="${esc(g.id)}" placeholder="10.20.0.0/24&#10;10.20.1.0 255.255.255.0&#10;10.20.5.10 - 10.20.5.40">${esc(c.text)}</textarea>
      <div class="row"><button type="button" class="btn small primary" data-ipcmp="${esc(g.id)}">Compare</button><span class="muted small">Nothing is changed in Azure.</span></div>`;
    const r = c.result;
    if (!r) return `<div class="ip-cmp">${form}</div>`;
    if (!r.list.length) return `<div class="ip-cmp">${form}<div class="status-msg error">No IPv4 addresses found in that text.</div></div>`;
    const skipped = r.skipped.length ? `<div class="note">Skipped (not valid IPv4): ${esc(r.skipped.slice(0, 20).join(", "))}${r.skipped.length > 20 ? " …" : ""}</div>` : "";
    const summary = `<p class="ip-sum"><b>${fmt.int(r.list.length)}</b> entr${r.list.length === 1 ? "y" : "ies"} in your list: <b>${fmt.int(r.same)}</b> already in the group, <b>${fmt.int(r.missing.length)}</b> missing. <b>${fmt.int(r.extra.length)}</b> group entr${r.extra.length === 1 ? "y is" : "ies are"} not in your list.</p>`;
    if (!r.missing.length && !r.extra.length) return `<div class="ip-cmp">${form}${summary}<div class="status-msg ok">The group holds exactly the addresses in your list.</div>${skipped}</div>`;
    const missing = r.missing.length ? `<div><b class="small">Missing in Azure</b><div class="ip-entries">${tags(r.missing, "good")}</div></div>` : "";
    const extra = r.extra.length ? `<div><b class="small">In Azure, not in your list</b><div class="ip-entries">${tags(r.extra, "bad")}</div></div>` : "";
    const next = c.mode === "replace" ? r.list.map((e) => e.text) : [...g.entries, ...r.missing.map((e) => e.text)];
    const modes = `<div class="seg"><button type="button" data-ipcmp-mode="add" class="${c.mode !== "replace" ? "active" : ""}">Add the missing ones</button><button type="button" data-ipcmp-mode="replace" class="${c.mode === "replace" ? "active" : ""}">Replace with my list</button></div>`;
    const cmd = azCommand(g, next);
    const warn = [
      c.mode === "replace" && r.extra.length ? `Replacing removes the ${fmt.int(r.extra.length)} entr${r.extra.length === 1 ? "y" : "ies"} not in your list from every rule using this group.` : "",
      next.length > IPGROUP_LIMIT ? `${fmt.int(next.length)} entries is over the ${fmt.int(IPGROUP_LIMIT)} Azure allows in one group.` : "",
      cmd.length > CMD_MAX ? "The command is too long for one Windows command line; run it in Cloud Shell (bash) or paste the list in the portal." : "",
    ].filter(Boolean).map((w) => `<div class="status-msg error">${esc(w)}</div>`).join("");
    return `<div class="ip-cmp">${form}${summary}${missing}${extra}${skipped}
      <div class="row">${modes}<span class="muted small">${fmt.int(next.length)} entries after the change</span></div>${warn}
      <div class="row"><b class="small">Azure CLI</b><button type="button" class="btn small" data-ipcopy="cmd">Copy</button></div><pre data-ipcopy-src="cmd">${esc(cmd)}</pre>
      <div class="row"><b class="small">New list, one per line</b><button type="button" class="btn small" data-ipcopy="list">Copy</button></div><pre data-ipcopy-src="list">${esc(next.join("\n"))}</pre>
    </div>`;
  }

  const shortId = (id) => String(id).split("/").pop();
  function usedBy(g) {
    const names = [...g.firewalls.map((id) => `${shortId(id)} (firewall)`), ...g.policies.map((id) => `${shortId(id)} (policy)`)];
    return names.length ? names.map(esc).join("<br>") : `<span class="muted">nothing</span>`;
  }
  function changed(g) {
    if (g.changedAt) {
      const delta = [g.addedCount ? `+${fmt.int(g.addedCount)}` : "", g.removedCount ? `−${fmt.int(g.removedCount)}` : ""].filter(Boolean).join(" ");
      return `<span title="${esc(g.changedAt)}">${esc(fmt.rel(g.changedAt))}</span><div class="secondary">${esc(delta)}</div>`;
    }
    return g.firstSeen ? `<span class="muted">no change since ${esc(fmt.date(g.firstSeen))}</span>` : `<span class="muted">–</span>`;
  }
  function ipGroupDetail(g, t, asIp) {
    const sorted = g.entries.map((text) => entryOf(text) || { text, start: Infinity, end: Infinity }).sort((a, b) => a.start - b.start);
    const hit = asIp ? (e) => e.start <= asIp.end && asIp.start <= e.end : null;
    const entries = sorted.length ? `<div class="ip-entries">${tags(sorted, "", hit)}</div>` : `<div class="muted small">No entries.</div>`;
    const last = g.changedAt
      ? `<h3 class="ip-h3">Last change <span class="muted small">${esc(fmt.rel(g.changedAt))}, seen by the scan</span></h3>` +
        (g.added && g.added.length ? `<div><b class="small">Added</b> <div class="ip-entries">${tags(g.added, "good")}${g.addedCount > g.added.length ? ` <span class="muted small">and ${fmt.int(g.addedCount - g.added.length)} more</span>` : ""}</div></div>` : "") +
        (g.removed && g.removed.length ? `<div><b class="small">Removed</b> <div class="ip-entries">${tags(g.removed, "bad")}${g.removedCount > g.removed.length ? ` <span class="muted small">and ${fmt.int(g.removedCount - g.removed.length)} more</span>` : ""}</div></div>` : "")
      : "";
    return entries + last + compareHtml(g, t);
  }
  function ipGroups(t) {
    const inv = inventory(t);
    if (!inv) return loading("the address inventory");
    if (inv.error) return failed(inv.error);
    const d = inv.data;
    if (!d.updatedAt) return noInventory();
    if (!d.ipGroups) return `<div class="empty-state big"><h3>No IP groups read yet</h3><p>The scan reads IP groups from this version on. Run it once${canRun() ? " (Run now above)" : ""}.</p></div>`;
    const q = t.filters.q;
    const asIp = ipNum(q);
    const contains = (g) => g.entries.map(entryOf).filter(Boolean).filter((e) => e.start <= asIp.end && asIp.start <= e.end);
    const match = (g) => {
      if (!q) return true;
      if (asIp) return contains(g).length > 0;
      return [g.name, g.resourceGroup, g.subscriptionName, g.subscriptionId, g.tenantName, g.location, ...g.entries, ...g.firewalls.map(shortId), ...g.policies.map(shortId)].join(" ").toLowerCase().includes(q);
    };
    const groups = d.ipGroups.filter(match).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    const slice = groups.slice(0, t.shown);
    const rows = slice.map((g) => {
      const key = `ipg:${g.id}`;
      const open = t.open.has(key);
      const pct = Math.round((g.entries.length / IPGROUP_LIMIT) * 100);
      const via = asIp ? `<div class="secondary">contains it via ${contains(g).slice(0, 3).map((e) => `<span class="mono">${esc(e.text)}</span>`).join(", ")}</div>` : "";
      const count = `<b>${fmt.int(g.entries.length)}</b>${pct >= 50 ? ` <span class="muted small">(${pct}% of limit)</span>` : ""}${g.state && g.state !== "Succeeded" ? ` <span class="tag bad">${esc(g.state)}</span>` : ""}${via}`;
      const toggle = `<button type="button" class="chip${open ? " active" : ""}" data-toggle="${esc(key)}">${icon("chevron")} Entries and compare</button>`;
      const main = `<tr>${[nameCell(g, null, `${g.location || ""}${g.resourceGroup ? " · rg " + g.resourceGroup : ""}`), subCell(g), count, usedBy(g), changed(g), toggle].map((c) => `<td>${c}</td>`).join("")}</tr>`;
      return main + `<tr class="ar-members-row${open ? "" : " hidden"}" data-members="${esc(key)}"><td colspan="6">${ipGroupDetail(g, t, asIp)}</td></tr>`;
    });
    const head = ["IP group", "Subscription", "Entries", "Used by", "Last changed", ""];
    const table = groups.length
      ? `<div class="table-wrap"><table class="data"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>` + moreButton(slice.length, groups.length, t)
      : `<div class="empty-state">${d.ipGroups.length ? (asIp ? "No IP group contains that address." : "No IP groups match the search.") : "No IP groups found."}</div>`;
    const note = `<div class="note">Saved by the scan ${esc(fmt.rel(d.updatedAt))}. Last changed is when a scan first saw different entries, so it is accurate to a day. IPv4 only.</div>`;
    return table + note;
  }
  // The compare box: typing only saves the text; Compare works it out (no requests either way).
  document.addEventListener("input", (e) => {
    const id = e.target.dataset && e.target.dataset.ipcmpText;
    if (id) cmpState(toolState(ID), id).text = e.target.value;
  });
  document.addEventListener("click", (e) => {
    const el = e.target.closest("[data-ipcmp],[data-ipcmp-mode],[data-ipcopy]");
    if (!el || !el.closest("#page-scan")) return;
    const t = toolState(ID);
    if (el.dataset.ipcopy) {
      const src = el.closest(".ip-cmp").querySelector(`[data-ipcopy-src="${el.dataset.ipcopy}"]`);
      navigator.clipboard.writeText(src.textContent).then(() => {
        el.textContent = "Copied";
        setTimeout(() => (el.textContent = "Copy"), 1500);
      }, () => (el.textContent = "Copy failed"));
      return;
    }
    const id = el.dataset.ipcmp || el.closest(".ip-cmp").querySelector("[data-ipcmp]").dataset.ipcmp;
    const g = t.ipam && t.ipam.data && (t.ipam.data.ipGroups || []).find((x) => x.id === id);
    if (!g) return;
    const c = cmpState(t, id);
    if (el.dataset.ipcmpMode) c.mode = el.dataset.ipcmpMode;
    else c.result = compare(g, c.text);
    rerender();
  });

  function page(all, t) {
    const v = viewOf(t);
    if (v === "networks") return networks(t);
    if (v === "ipgroups") return ipGroups(t);
    if (v === "free") return free(t);
    return null;
  }

  VIEWS[ID] = { stats, extra, page, showKinds: (t) => viewOf(t) === "findings", body: genericBody };
})();
