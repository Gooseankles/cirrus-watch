"use strict";
/* Upcoming group: the Azure news and Microsoft 365 roadmap pages. Both are lists from Microsoft's public release
   feed that the server fetches once a day (/api/azure-updates, /api/m365-roadmap); the browser never calls Microsoft.
   Chips pick a kind or status, the product list and the search box narrow the rows, and each row links to Microsoft's
   own page for the item. Titles and summaries are plain text from the server and escaped here. Uses app.js helpers. */
(() => {
  const HIDE = ["#scan-sub", "#scan-fw", "#scan-new", "#scan-csv", "#scan-accepted"];

  // One feed per tool, loaded once per run of the scan (a new run may have fetched a new copy).
  function feedOf(id, url, t) {
    const key = `feed_${id}`;
    if (t[key] && t[key].ranAt === t.data.ranAt) return t[key];
    if (!t[`${key}Loading`]) {
      const ranAt = t.data.ranAt;
      t[`${key}Loading`] = apiJson(url)
        .then((data) => (t[key] = { ranAt, data }))
        .catch((err) => (t[key] = { ranAt, error: err.message }))
        .finally(() => {
          t[`${key}Loading`] = null;
          if (state.route === `scan/${id}`) renderFindings(id);
        });
    }
    return null;
  }

  const month = (ym) => (ym ? fmt.month(ym) : "");
  const badge = (cls, text) => `<span class="kind ${cls}">${esc(text)}</span>`;
  const chip = (view, label, n, active) => `<button type="button" class="chip${active ? " active" : ""}" data-view="${esc(view)}">${esc(label)} <span class="n">${fmt.int(n)}</span></button>`;
  const products = (list) => {
    const shown = list.slice(0, 3).map(esc).join(", ");
    return list.length > 3 ? `${shown} <span class="muted">+${list.length - 3}</span>` : shown || '<span class="muted">–</span>';
  };
  const productOptions = (items, picked) => {
    const counts = new Map();
    for (const it of items) for (const p of it.products) counts.set(p, (counts.get(p) || 0) + 1);
    const list = [...counts.keys()].sort((a, b) => a.localeCompare(b));
    if (picked && !counts.has(picked)) list.unshift(picked);
    return `<select class="select feed-product" data-filter="product" title="Only items about this product"><option value="">All products</option>${list.map((p) => `<option value="${esc(p)}"${p === picked ? " selected" : ""}>${esc(p)} (${fmt.int(counts.get(p) || 0)})</option>`).join("")}</select>`;
  };
  const searchText = (it) => [it.title, it.summary, ...it.products, ...(it.tags || []), ...(it.categories || []), ...(it.platforms || []), it.status, String(it.id)].join(" ").toLowerCase();
  function fetchedNote(d, extra) {
    const when = d.fetchedAt ? `Fetched from Microsoft ${esc(fmt.rel(d.fetchedAt))} (${esc(fmt.dateTime(d.fetchedAt))}).` : "Not fetched yet.";
    return `<div class="note feed-note">${when}${d.note ? ` <span class="warn">${esc(d.note)}</span>` : ""}${extra || ""}</div>`;
  }
  function header(t, placeholder) {
    for (const sel of HIDE) $(sel).classList.add("hidden");
    $("#scan-q").placeholder = placeholder;
    const h2 = $("#scan-count").parentElement;
    if (h2 && h2.firstChild && h2.firstChild.nodeType === 3) h2.firstChild.textContent = "Items ";
  }
  const loading = (f, what) => (!f ? `<div class="empty-state">Loading ${what}…</div>` : f.error ? `<div class="empty-state">Could not load ${what}: ${esc(f.error)}</div>` : "");

  /* ---------- Azure news ---------- */
  {
    const ID = "azure-updates";
    const KINDS = { new: ["New & GA", "k-good"], preview: ["Preview", "k-info"], retiring: ["Retiring", "k-warn"] };
    const VIEWS_ = [["all", "All"], ["new", "New & GA"], ["preview", "Preview"], ["retiring", "Retiring"], ["inuse", "In use"]];
    const viewOf = (t) => (VIEWS_.some(([k]) => k === t.filters.view) ? t.filters.view : "all");
    const feed = (t) => feedOf(ID, "/api/azure-updates", t);
    const inView = (it, v) => v === "all" || (v === "inuse" ? Boolean(it.inUse) : it.kind === v);
    // The date that matters for the row: the retirement, the preview or the general availability.
    const keyDate = (it) =>
      it.kind === "retiring" && it.retirement ? ["Retires", it.retirement] : it.kind === "preview" && it.preview ? ["Preview", it.preview] : it.ga ? ["Available", it.ga] : it.preview ? ["Preview", it.preview] : ["", ""];

    function stats(all, t) {
      const f = feed(t);
      if (!f || !f.data) return "";
      const items = f.data.items;
      const n = (k) => items.filter((it) => it.kind === k).length;
      const used = items.filter((it) => it.inUse);
      const usedRetiring = used.filter((it) => it.kind === "retiring").length;
      const checked = f.data.inUseChecked > 0;
      return (
        statTile({ label: "Updates", value: fmt.int(items.length), delta: `last ${f.data.days} days and dates ahead` }) +
        statTile({ label: "New & GA", value: fmt.int(n("new")) }) +
        statTile({ label: "Preview", value: fmt.int(n("preview")) }) +
        statTile({ label: "Retiring", value: fmt.int(n("retiring")) }) +
        statTile({ label: "In use", value: checked ? fmt.int(used.length) : "–", delta: checked ? `${fmt.int(usedRetiring)} retiring` : "needs the Architecture scan", deltaCls: usedRetiring ? "bad" : "" })
      );
    }

    function extra(all, t) {
      header(t, "Search title, product, summary");
      const f = feed(t);
      return f && f.data ? productOptions(f.data.items, t.filters.product || "") : "";
    }

    function page(all, t) {
      const f = feed(t);
      const wait = loading(f, "the Azure news");
      if (wait) return wait;
      const d = f.data;
      const v = viewOf(t);
      const q = t.filters.q;
      const prod = t.filters.product || "";
      const base = d.items.filter((it) => (!prod || it.products.includes(prod)) && (!q || searchText(it).includes(q)));
      const chips = `<div class="inline-list feed-chips">${VIEWS_.map(([k, label]) => chip(k, label, base.filter((it) => inView(it, k)).length, v === k)).join("")}</div>`;
      const unknown = d.inUseUnknown && d.inUseUnknown.length ? ` In use is not known for ${esc(d.inUseUnknown.join(", "))} yet: it needs the Architecture scan's resource list, then this scan.` : "";
      const list = base.filter((it) => inView(it, v));
      if (!d.items.length) return chips + fetchedNote(d, unknown) + `<div class="empty-state">No Azure news kept yet. They are fetched by the next run.</div>`;
      if (!list.length) return chips + fetchedNote(d, unknown) + `<div class="empty-state">No updates match these filters.</div>`;
      const rows = list.slice(0, t.shown).map((it) => {
        const [label, ym] = keyDate(it);
        const [kindLabel, cls] = KINDS[it.kind] || KINDS.new;
        const used = it.inUse ? `<div class="feed-inuse">${badge("k-info", "In use")} <span class="muted">${esc(it.inUse.join(", "))}${it.inUseTenants ? ` · ${esc(it.inUseTenants.join(", "))}` : ""}</span></div>` : "";
        return [
          `<div class="feed-title"><a href="https://azure.microsoft.com/updates?id=${encodeURIComponent(it.id)}" target="_blank" rel="noopener">${esc(it.title)}</a>${it.summary ? `<div class="secondary">${esc(it.summary)}</div>` : ""}${used}<a class="feed-link" href="https://azure.microsoft.com/updates?id=${encodeURIComponent(it.id)}" target="_blank" rel="noopener">Read on Microsoft ↗</a></div>`,
          products(it.products),
          `${badge(cls, kindLabel)}${it.status ? `<div class="secondary">${esc(it.status)}</div>` : ""}`,
          ym ? `${esc(month(ym))}<div class="secondary">${esc(label)}</div>` : '<span class="muted">–</span>',
          it.modified ? esc(fmt.date(it.modified)) : "",
        ];
      });
      return (
        chips +
        fetchedNote(d, unknown) +
        tableHtml([{ label: "Update" }, { label: "Products", cls: "feed-products" }, { label: "Type" }, { label: "Date", cls: "nowrap" }, { label: "Changed", cls: "nowrap" }], rows) +
        moreButton(Math.min(list.length, t.shown), list.length, t)
      );
    }

    VIEWS[ID] = { stats, extra, page, showKinds: () => false, body: genericBody };
  }

  /* ---------- Microsoft 365 roadmap ---------- */
  {
    const ID = "m365-roadmap";
    const STATUS = { "In development": "k-info", "Rolling out": "k-warn", Launched: "k-good" };
    const VIEWS_ = [["all", "All"], ["In development", "In development"], ["Rolling out", "Rolling out"], ["Launched", "Launched"]];
    const viewOf = (t) => (VIEWS_.some(([k]) => k === t.filters.view) ? t.filters.view : "all");
    const feed = (t) => feedOf(ID, "/api/m365-roadmap", t);

    function stats(all, t) {
      const f = feed(t);
      if (!f || !f.data) return "";
      const items = f.data.items;
      const n = (s) => items.filter((it) => it.status === s).length;
      return (
        statTile({ label: "Roadmap items", value: fmt.int(items.length) }) +
        statTile({ label: "In development", value: fmt.int(n("In development")) }) +
        statTile({ label: "Rolling out", value: fmt.int(n("Rolling out")) }) +
        statTile({ label: "Launched", value: fmt.int(n("Launched")), delta: `last ${f.data.days} days` })
      );
    }

    function extra(all, t) {
      header(t, "Search title, product, summary, ID");
      const f = feed(t);
      return f && f.data ? productOptions(f.data.items, t.filters.product || "") : "";
    }

    function page(all, t) {
      const f = feed(t);
      const wait = loading(f, "the Microsoft 365 roadmap");
      if (wait) return wait;
      const d = f.data;
      const v = viewOf(t);
      const q = t.filters.q;
      const prod = t.filters.product || "";
      const base = d.items.filter((it) => (!prod || it.products.includes(prod)) && (!q || searchText(it).includes(q)));
      const chips = `<div class="inline-list feed-chips">${VIEWS_.map(([k, label]) => chip(k, label, base.filter((it) => k === "all" || it.status === k).length, v === k)).join("")}</div>`;
      const list = base.filter((it) => v === "all" || it.status === v);
      if (!d.items.length) return chips + fetchedNote(d) + `<div class="empty-state">No roadmap items kept yet. They are fetched by the next run.</div>`;
      if (!list.length) return chips + fetchedNote(d) + `<div class="empty-state">No roadmap items match these filters.</div>`;
      const rows = list.slice(0, t.shown).map((it) => {
        const when = it.ga ? [it.ga, "General availability"] : it.preview ? [it.preview, "Preview"] : null;
        const meta = [it.rings.join(", "), it.platforms.join(", ")].filter(Boolean).join(" · ");
        return [
          `<div class="feed-title"><a href="https://www.microsoft.com/microsoft-365/roadmap?id=${encodeURIComponent(it.id)}" target="_blank" rel="noopener">${esc(it.title)}</a>${it.summary ? `<div class="secondary">${esc(it.summary)}</div>` : ""}<div class="secondary feed-meta">ID ${esc(String(it.id))}${meta ? ` · ${esc(meta)}` : ""}</div><a class="feed-link" href="https://www.microsoft.com/microsoft-365/roadmap?id=${encodeURIComponent(it.id)}" target="_blank" rel="noopener">Read on Microsoft ↗</a></div>`,
          products(it.products),
          badge(STATUS[it.status] || "", it.status || "Unknown"),
          when ? `${esc(month(when[0]))}<div class="secondary">${esc(when[1])}</div>` : '<span class="muted">–</span>',
          it.modified ? esc(fmt.date(it.modified)) : "",
        ];
      });
      return (
        chips +
        fetchedNote(d) +
        tableHtml([{ label: "Feature" }, { label: "Products", cls: "feed-products" }, { label: "Status" }, { label: "Expected", cls: "nowrap" }, { label: "Changed", cls: "nowrap" }], rows) +
        moreButton(Math.min(list.length, t.shown), list.length, t)
      );
    }

    VIEWS[ID] = { stats, extra, page, showKinds: () => false, body: genericBody };
  }
})();
