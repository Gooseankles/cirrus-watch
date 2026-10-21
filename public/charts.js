"use strict";
/* Hand-rolled SVG charts for the dashboard: columns, line/area, stacked columns, sparklines and one shared
   tooltip. Labels are written with textContent, so untrusted API strings never reach innerHTML here. */
const Charts = (() => {
  const NS = "http://www.w3.org/2000/svg";
  const BAR_MAX = 24;
  const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
  const OTHER = "#6b7380";

  function svgEl(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k of Object.keys(attrs)) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    return e;
  }
  function text(parent, x, y, str, cls, anchor) {
    const t = svgEl("text", { x, y, class: cls || "tick", "text-anchor": anchor || "start" });
    t.textContent = str;
    parent.appendChild(t);
    return t;
  }
  function compact(n) {
    n = Number(n) || 0;
    const a = Math.abs(n);
    const trim = (s) => s.replace(/\.0$/, "");
    if (a >= 1e9) return trim((n / 1e9).toFixed(1)) + "B";
    if (a >= 1e6) return trim((n / 1e6).toFixed(1)) + "M";
    if (a >= 1e4) return Math.round(n / 1e3) + "K";
    if (a >= 1e3) return trim((n / 1e3).toFixed(1)) + "K";
    if (a >= 100 || Number.isInteger(n)) return String(Math.round(n));
    return n.toFixed(a >= 10 ? 1 : 2);
  }
  function niceStep(raw) {
    if (!(raw > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / p;
    const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return m * p;
  }
  function ticks(max, count, integer) {
    if (!(max > 0)) return [0, 1];
    let step = niceStep(max / (count || 4));
    if (integer) step = Math.max(1, Math.round(step));
    const top = Math.ceil(max / step - 1e-9) * step;
    const out = [];
    for (let i = 0; i * step <= top + 1e-9; i++) out.push(+(i * step).toFixed(10));
    return out;
  }
  function barPath(x, y, w, h, r) {
    if (!(h > 0)) return "";
    r = Math.min(r, h, w / 2);
    const b = y + h;
    return `M${x},${b} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${b} Z`;
  }

  /* ---- tooltip (one node for the whole page) ---- */
  let tipNode = null;
  function tip() {
    if (!tipNode) {
      tipNode = document.createElement("div");
      tipNode.className = "tooltip";
      document.body.appendChild(tipNode);
    }
    return tipNode;
  }
  function showTip(evt, c) {
    const t = tip();
    t.textContent = "";
    if (c.title) {
      const d = document.createElement("div");
      d.className = "tt-title";
      d.textContent = c.title;
      t.appendChild(d);
    }
    for (const r of c.rows || []) {
      const row = document.createElement("div");
      row.className = "tt-row";
      const k = document.createElement("span");
      k.className = "k";
      if (r.color) {
        const i = document.createElement("i");
        i.style.background = r.color;
        k.appendChild(i);
      }
      k.appendChild(document.createTextNode(r.label));
      const v = document.createElement("span");
      v.className = "v";
      v.textContent = r.value;
      row.appendChild(k);
      row.appendChild(v);
      t.appendChild(row);
    }
    if (c.note) {
      const n = document.createElement("div");
      n.className = "tt-note";
      n.textContent = c.note;
      t.appendChild(n);
    }
    t.style.display = "block";
    moveTip(evt);
  }
  function moveTip(evt) {
    const t = tip();
    const pad = 14;
    let x = evt.clientX + pad;
    let y = evt.clientY + pad;
    const w = t.offsetWidth;
    const h = t.offsetHeight;
    if (x + w > window.innerWidth - 8) x = Math.max(8, evt.clientX - w - pad);
    if (y + h > window.innerHeight - 8) y = Math.max(8, evt.clientY - h - pad);
    t.style.left = x + "px";
    t.style.top = y + "px";
  }
  function hideTip() {
    if (tipNode) tipNode.style.display = "none";
  }

  /* ---- re-render on resize ---- */
  const renders = new WeakMap();
  const ro = typeof ResizeObserver === "function"
    ? new ResizeObserver((entries) => {
        for (const e of entries) {
          const r = renders.get(e.target);
          if (!r) continue;
          const w = e.target.clientWidth;
          if (w !== r.width) {
            r.width = w;
            r.fn();
          }
        }
      })
    : null;
  function mount(container, fn) {
    if (!renders.has(container) && ro) ro.observe(container);
    renders.set(container, { fn, width: container.clientWidth });
    fn();
  }
  function frame(container, opts) {
    container.classList.remove("empty");
    container.textContent = "";
    const W = container.clientWidth;
    const H = container.clientHeight;
    if (W < 20 || H < 20) return null;
    const m = Object.assign({ top: 10, right: 10, bottom: 22, left: 44 }, (opts && opts.margin) || {});
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: "img" });
    if (opts && opts.ariaLabel) svg.setAttribute("aria-label", opts.ariaLabel);
    container.appendChild(svg);
    return { svg, W, H, m, pw: W - m.left - m.right, ph: H - m.top - m.bottom };
  }
  function empty(container, msg) {
    container.textContent = msg || "No data";
    container.classList.add("empty");
  }
  function yAxis(f, tk, fmtTick) {
    const top = tk[tk.length - 1] || 1;
    const y = (v) => f.m.top + f.ph - (v / top) * f.ph;
    for (const t of tk) {
      f.svg.appendChild(svgEl("line", { x1: f.m.left, x2: f.m.left + f.pw, y1: y(t), y2: y(t), class: t === 0 ? "baseline" : "grid-line" }));
      text(f.svg, f.m.left - 6, y(t) + 3.5, fmtTick(t), "tick", "end");
    }
    return y;
  }

  /* ---- column chart: one series, optional selection, click handler ---- */
  function columns(container, opts) {
    mount(container, () => {
      const data = opts.data || [];
      if (!data.length) return empty(container, opts.emptyText);
      const f = frame(container, opts);
      if (!f) return;
      const vals = data.map((d) => Math.max(0, Number(d.value) || 0));
      const tk = ticks(Math.max(...vals), 4, opts.integer);
      const top = tk[tk.length - 1] || 1;
      yAxis(f, tk, opts.yFormat || compact);
      const slot = f.pw / data.length;
      const bw = Math.min(BAR_MAX, Math.max(2, slot * 0.72));
      const every = Math.max(1, Math.ceil(46 / slot));
      const format = opts.format || compact;
      data.forEach((d, i) => {
        const cx = f.m.left + slot * i + slot / 2;
        const h = (vals[i] / top) * f.ph;
        const cls = ["bar", d.partial ? "partial" : "", opts.selected === i ? "sel" : ""].filter(Boolean).join(" ");
        const bar = svgEl("path", { d: barPath(cx - bw / 2, f.m.top + f.ph - h, bw, h, 4), class: cls });
        f.svg.appendChild(bar);
        if (i % every === 0) text(f.svg, cx, f.H - 6, d.label, "tick", "middle");
        const hit = svgEl("rect", { x: f.m.left + slot * i, y: f.m.top, width: slot, height: f.ph, class: "hit" });
        hit.addEventListener("pointerenter", (e) => {
          bar.classList.add("hover");
          showTip(e, opts.tooltip ? opts.tooltip(d, i) : { title: d.label, rows: [{ label: opts.valueLabel || "Value", value: format(vals[i]) }] });
        });
        hit.addEventListener("pointermove", moveTip);
        hit.addEventListener("pointerleave", () => {
          bar.classList.remove("hover");
          hideTip();
        });
        if (opts.onSelect) {
          hit.style.cursor = "pointer";
          hit.addEventListener("click", () => opts.onSelect(i, d));
        }
        f.svg.appendChild(hit);
      });
    });
  }

  /* ---- line + area with crosshair ---- */
  function line(container, opts) {
    mount(container, () => {
      const pts = opts.points || [];
      if (!pts.length) return empty(container, opts.emptyText);
      const f = frame(container, opts);
      if (!f) return;
      const vals = pts.map((p) => Math.max(0, Number(p.value) || 0));
      const tk = ticks(Math.max(...vals), 4, opts.integer);
      const y = yAxis(f, tk, opts.yFormat || compact);
      const n = pts.length;
      const step = n > 1 ? f.pw / (n - 1) : 0;
      const x = (i) => (n > 1 ? f.m.left + i * step : f.m.left + f.pw / 2);
      const base = f.m.top + f.ph;
      const format = opts.format || compact;
      let d = "";
      pts.forEach((p, i) => {
        d += (i ? "L" : "M") + x(i).toFixed(1) + "," + y(vals[i]).toFixed(1);
      });
      if (n > 1) f.svg.appendChild(svgEl("path", { d: `${d}L${x(n - 1).toFixed(1)},${base}L${x(0).toFixed(1)},${base}Z`, class: "area" }));
      f.svg.appendChild(svgEl("path", { d, class: "line" }));
      if (n === 1) f.svg.appendChild(svgEl("circle", { cx: x(0), cy: y(vals[0]), r: 4, class: "marker" }));
      const every = Math.max(1, Math.ceil(56 / Math.max(step, 1)));
      pts.forEach((p, i) => {
        if (i % every === 0 && (n - 1 - i) * step >= 28) text(f.svg, x(i), f.H - 6, p.label, "tick", "middle");
      });
      if (n > 1) text(f.svg, x(n - 1), f.H - 6, pts[n - 1].label, "tick", "end");
      const cross = svgEl("line", { x1: 0, x2: 0, y1: f.m.top, y2: base, class: "crosshair", visibility: "hidden" });
      const dot = svgEl("circle", { r: 4, class: "marker", visibility: "hidden" });
      const hit = svgEl("rect", { x: f.m.left, y: f.m.top, width: f.pw, height: f.ph, class: "hit" });
      hit.addEventListener("pointermove", (e) => {
        const rect = f.svg.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const i = n > 1 ? Math.max(0, Math.min(n - 1, Math.round((px - f.m.left) / step))) : 0;
        cross.setAttribute("x1", x(i));
        cross.setAttribute("x2", x(i));
        cross.setAttribute("visibility", "visible");
        dot.setAttribute("cx", x(i));
        dot.setAttribute("cy", y(vals[i]));
        dot.setAttribute("visibility", "visible");
        showTip(e, opts.tooltip ? opts.tooltip(pts[i], i) : { title: pts[i].label, rows: [{ label: opts.valueLabel || "Value", value: format(vals[i]) }] });
      });
      hit.addEventListener("pointerleave", () => {
        cross.setAttribute("visibility", "hidden");
        dot.setAttribute("visibility", "hidden");
        hideTip();
      });
      f.svg.appendChild(cross);
      f.svg.appendChild(dot);
      f.svg.appendChild(hit);
    });
  }

  /* ---- stacked columns: categories x series, fixed colours per series ---- */
  function stacked(container, opts) {
    mount(container, () => {
      const cats = opts.categories || [];
      const series = opts.series || [];
      if (!cats.length || !series.length) return empty(container, opts.emptyText);
      const f = frame(container, opts);
      if (!f) return;
      const val = (sr, i) => Math.max(0, Number(sr.values[i]) || 0);
      const totals = cats.map((c, i) => series.reduce((s, sr) => s + val(sr, i), 0));
      const tk = ticks(Math.max(...totals), 4);
      const y = yAxis(f, tk, opts.yFormat || compact);
      const slot = f.pw / cats.length;
      const bw = Math.min(BAR_MAX, Math.max(2, slot * 0.72));
      const every = Math.max(1, Math.ceil(46 / slot));
      const format = opts.format || compact;
      cats.forEach((c, i) => {
        const g = svgEl("g");
        const cx = f.m.left + slot * i + slot / 2;
        let acc = 0;
        let lastIdx = -1;
        series.forEach((sr, k) => {
          if (val(sr, i) > 0) lastIdx = k;
        });
        series.forEach((sr, k) => {
          const v = val(sr, i);
          if (v <= 0) return;
          const y0 = y(acc);
          const y1 = y(acc + v);
          acc += v;
          const h = y0 - y1;
          const el = k === lastIdx
            ? svgEl("path", { d: barPath(cx - bw / 2, y1, bw, h, 4), class: "seg-rect", fill: sr.color })
            : svgEl("rect", { x: cx - bw / 2, y: y1, width: bw, height: h, class: "seg-rect", fill: sr.color });
          g.appendChild(el);
        });
        f.svg.appendChild(g);
        if (i % every === 0) text(f.svg, cx, f.H - 6, c, "tick", "middle");
        const hit = svgEl("rect", { x: f.m.left + slot * i, y: f.m.top, width: slot, height: f.ph, class: "hit" });
        hit.addEventListener("pointerenter", (e) => {
          g.classList.add("hover");
          const rows = series.filter((sr) => val(sr, i) > 0).map((sr) => ({ label: sr.name, value: format(val(sr, i)), color: sr.color }));
          rows.push({ label: "Total", value: format(totals[i]) });
          showTip(e, { title: opts.tooltipTitle ? opts.tooltipTitle(c, i) : c, rows });
        });
        hit.addEventListener("pointermove", moveTip);
        hit.addEventListener("pointerleave", () => {
          g.classList.remove("hover");
          hideTip();
        });
        f.svg.appendChild(hit);
      });
    });
  }

  /* ---- sparkline: tiny line + area + end dot, numbers only ---- */
  function sparkline(container, values) {
    mount(container, () => {
      container.textContent = "";
      const W = container.clientWidth;
      const H = container.clientHeight || 36;
      if (W < 10) return;
      const vals = (values || []).map((v) => Math.max(0, Number(v) || 0));
      const n = vals.length;
      const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "spark", "aria-hidden": "true" });
      container.appendChild(svg);
      if (!n) return;
      const pad = 4;
      const max = Math.max(1, ...vals);
      const x = (i) => (n > 1 ? pad + (i * (W - 2 * pad)) / (n - 1) : W - pad);
      const y = (v) => pad + (H - 2 * pad) * (1 - v / max);
      if (n > 1) {
        let d = "";
        vals.forEach((v, i) => {
          d += (i ? "L" : "M") + x(i).toFixed(1) + "," + y(v).toFixed(1);
        });
        svg.appendChild(svgEl("path", { d: `${d}L${x(n - 1).toFixed(1)},${H - pad}L${pad},${H - pad}Z`, class: "sa" }));
        svg.appendChild(svgEl("path", { d, class: "sl" }));
      }
      svg.appendChild(svgEl("circle", { cx: x(n - 1), cy: y(vals[n - 1]), r: 3, class: "sd" }));
    });
  }

  function legend(container, items) {
    container.textContent = "";
    for (const it of items) {
      const s = document.createElement("span");
      s.className = "lg";
      const sw = document.createElement("i");
      sw.className = "sw";
      sw.style.background = it.color;
      s.appendChild(sw);
      s.appendChild(document.createTextNode(it.name));
      container.appendChild(s);
    }
  }

  return { columns, line, stacked, sparkline, legend, compact, showTip, hideTip, moveTip, SERIES, OTHER };
})();
