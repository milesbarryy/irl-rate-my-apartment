/* Simplified Davis base map: street tracings, building footprints, and one dot per
   reviewed property. World coordinates are meters from data/davis_map.json's origin
   (see etl/build_map.py); labels, dots and the popup are drawn in screen space so they
   stay a constant size while the map zooms. Requires d3 (zoom + transitions only). */
(function () {
  const LABEL_MIN_ZOOM = { major: 0, mid: 1.6, minor: 3.5 }; // relative to the initial fit
  const STREET_WIDTH = { minor: [1.2, 3.5], mid: [2.2, 6], major: [3.2, 8] };  // px at fit zoom, px when zoomed in

  function pathFromFlat(arr, close) {
    let d = "M" + arr[0] + " " + arr[1];
    for (let i = 2; i < arr.length; i += 2) d += "L" + arr[i] + " " + arr[i + 1];
    return close ? d + "Z" : d;
  }

  // OSM splits one street into many short ways; chain ways that share an endpoint
  // and a name so labels can sit on the whole street.
  function chainStreets(streets) {
    const groups = new Map();
    for (const s of streets) {
      if (!s.n || s.c === "link") continue;
      const key = s.n + "|" + s.c;
      if (!groups.has(key)) groups.set(key, []);
      const pts = [];
      for (let i = 0; i < s.p.length; i += 2) pts.push([s.p[i], s.p[i + 1]]);
      groups.get(key).push(pts);
    }
    const out = [];
    const k = (p) => p[0] + "," + p[1];
    for (const [key, lines] of groups) {
      const [name, cls] = key.split("|");
      const pool = lines.slice();
      while (pool.length) {
        let line = pool.pop();
        let grew = true;
        while (grew) {
          grew = false;
          for (let i = 0; i < pool.length; i++) {
            const o = pool[i];
            const a0 = k(line[0]), a1 = k(line[line.length - 1]), b0 = k(o[0]), b1 = k(o[o.length - 1]);
            let joined = null;
            if (a1 === b0) joined = line.concat(o.slice(1));
            else if (a1 === b1) joined = line.concat(o.slice(0, -1).reverse());
            else if (a0 === b1) joined = o.concat(line.slice(1));
            else if (a0 === b0) joined = o.slice().reverse().concat(line.slice(1));
            if (joined) { line = joined; pool.splice(i, 1); grew = true; break; }
          }
        }
        out.push({ name, cls, pts: line });
      }
    }
    return out;
  }

  function buildLabels(streets) {
    // Anchors at 1/2 (and 1/4, 3/4 on long streets) of each chained street; the greedy
    // collision pass in _draw() decides which ones show at the current zoom.
    const out = [];
    const rank = { major: 0, mid: 1, minor: 2 };
    for (const { name, cls, pts } of chainStreets(streets)) {
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const total = cum[cum.length - 1];
      if (total < 120) continue;
      const at = (d) => {
        let i = 1;
        while (i < cum.length - 1 && cum[i] < d) i++;
        const t = (d - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
        return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
      };
      const stops = total > 2400 ? [0.25, 0.5, 0.75] : [0.5];
      for (const f of stops) {
        const d = total * f, span = Math.min(total * 0.2, 250);
        const [x, y] = at(d), a = at(Math.max(0, d - span / 2)), b = at(Math.min(total, d + span / 2));
        let angle = Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
        if (angle > 90) angle -= 180;
        if (angle < -90) angle += 180;
        out.push({ text: name, cls, x, y, angle, len: Math.min(total, span * 2.5), rank: rank[cls] ?? 3, total });
      }
    }
    out.sort((a, b) => a.rank - b.rank || b.total - a.total);
    return out;
  }

  function DavisMap(container, mapData, handlers) {
    this.el = container;
    this.data = mapData;
    this.handlers = handlers;
    this.props = [];
    this.visible = new Set();
    this.activeId = null;
    this.labels = buildLabels(mapData.streets);
    this.origin = mapData.origin;
    this.k = mapData.k;
    this._init();
  }

  DavisMap.prototype.project = function (lat, lon) {
    return [(lon - this.origin[1]) * this.k[0], -(lat - this.origin[0]) * this.k[1]];
  };

  DavisMap.prototype._init = function () {
    const d = this.data;
    const svg = (this.svg = d3.select(this.el).append("svg").attr("role", "application").attr("aria-label", "Map of Davis. Use the dots to open property details."));
    const world = (this.world = svg.append("g"));

    for (const ring of d.campus) world.append("path").attr("class", "m-campus").attr("d", pathFromFlat(ring, true));
    world.append("path").attr("class", "m-park").attr("d", d.parks.map(r => pathFromFlat(r, true)).join(""));
    world.append("path").attr("class", "m-building").attr("d", d.buildings.map(b => pathFromFlat(b, true)).join(""));
    world.append("path").attr("class", "m-rail").attr("d", d.rail.map(r => pathFromFlat(r)).join(""))
      .attr("vector-effect", "non-scaling-stroke").attr("stroke-width", 1.5);

    const byClass = { minor: [], mid: [], major: [] };
    for (const s of d.streets) (byClass[s.c === "link" ? "major" : s.c] || byClass.minor).push(pathFromFlat(s.p));
    this.streetPaths = {};
    for (const [cls, extra] of [["minor", "case"], ["minor", ""], ["mid", "case"], ["mid", ""], ["major", ""]]) {
      const key = extra ? cls + "-case" : cls;
      this.streetPaths[key] = world.append("path").attr("class", "m-street m-" + key).attr("d", byClass[cls].join(""));
    }

    this.overlay = svg.append("g");
    this.labelLayer = this.overlay.append("g");
    this.campusLayer = this.overlay.append("g");
    this.dotLayer = this.overlay.append("g");

    const [x0, y0, x1, y1] = d.bounds;
    this.worldBounds = { x0, y0, x1, y1 };

    this.zoom = d3.zoom()
      .on("zoom", (ev) => { this.t = ev.transform; this.world.attr("transform", ev.transform); this._schedule(); })
      .on("start", () => this._hideTip());
    svg.call(this.zoom).on("dblclick.zoom", null);
    svg.on("click", (ev) => { if (ev.target === svg.node() || ev.target.closest("g") === this.world.node()) this.closePopup(); });

    this.popup = document.getElementById("map-popup");
    this.tip = document.getElementById("map-tip");

    this._resizeObserver = new ResizeObserver(() => this._fit(false));
    this._resizeObserver.observe(this.el);
    this._fit(true);
  };

  DavisMap.prototype._fit = function (reset) {
    const w = this.el.clientWidth, h = this.el.clientHeight;
    if (!w || !h) return;
    this.w = w; this.h = h;
    // Fit to the reviewed properties (plus campus) rather than the whole street
    // download, so the first view is the part of town students actually live in.
    const pts = this.props.filter(p => p.xy).map(p => p.xy);
    let [x0, y0, x1, y1] = [-2600, -2600, 2600, 2600];
    if (pts.length) {
      x0 = Math.min(...pts.map(p => p[0])); x1 = Math.max(...pts.map(p => p[0]));
      y0 = Math.min(...pts.map(p => p[1])); y1 = Math.max(...pts.map(p => p[1]));
    }
    const pad = 60;
    const k = Math.min((w - pad * 2) / (x1 - x0), (h - pad * 2) / (y1 - y0));
    this.k0 = k;
    const B = this.worldBounds;
    this.zoom
      .scaleExtent([k * 0.6, k * 40])
      .translateExtent([[B.x0 - 400, B.y0 - 400], [B.x1 + 400, B.y1 + 400]])
      .extent([[0, 0], [w, h]]);
    this.home = d3.zoomIdentity.translate(w / 2 - k * (x0 + x1) / 2, h / 2 - k * (y0 + y1) / 2).scale(k);
    if (reset || !this.t) this.svg.call(this.zoom.transform, this.home);
    else this._schedule();
  };

  DavisMap.prototype.setProperties = function (props) {
    this.props = props.map(p => ({ ...p, xy: p.lat == null ? null : this.project(p.lat, p.lon) }));
    this.byId = new Map(this.props.map(p => [p.id, p]));
    const self = this;
    this.dots = this.dotLayer.selectAll("circle").data(this.props.filter(p => p.xy), p => p.id).join("circle")
      .attr("class", "m-dot").attr("r", 7).attr("tabindex", 0).attr("role", "button")
      .attr("aria-label", p => `${p.name}, overall ${p.overall ?? "not rated"}. Open details`)
      .on("click", function (ev, p) { ev.stopPropagation(); self.openPopup(p.id); })
      .on("keydown", function (ev, p) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); self.openPopup(p.id); } })
      .on("mouseenter focus", function (ev, p) { self._showTip(p); })
      .on("mouseleave blur", () => this._hideTip());
    this._fit(true);
  };

  DavisMap.prototype.setVisible = function (ids) {
    this.visible = new Set(ids);
    if (this.dots) this.dots.attr("display", p => (this.visible.has(p.id) ? null : "none"));
    if (this.activeId && !this.visible.has(this.activeId)) this.closePopup();
  };

  DavisMap.prototype._schedule = function () {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = null; this._draw(); });
  };

  DavisMap.prototype._draw = function () {
    const t = this.t;
    if (!t) return;
    const rel = t.k / this.k0; // zoom relative to the initial fit
    const g = Math.max(0, Math.min(1, Math.log2(rel) / 4));
    for (const [cls, [a, b]] of Object.entries(STREET_WIDTH)) {
      const w = a + (b - a) * g;
      this.streetPaths[cls].attr("stroke-width", w);
      if (this.streetPaths[cls + "-case"]) this.streetPaths[cls + "-case"].attr("stroke-width", w + 1.6);
    }

    // Street labels: greedy placement with a coarse screen-space collision grid.
    const W = this.w, H = this.h, cell = 24, taken = new Set(), shown = [], seenNames = new Map();
    for (const L of this.labels) {
      if (rel < LABEL_MIN_ZOOM[L.cls]) continue;
      const sx = t.applyX(L.x), sy = t.applyY(L.y);
      if (sx < -50 || sy < -20 || sx > W + 50 || sy > H + 20) continue;
      const fs = L.cls === "major" ? 12 : 11;
      const tw = L.text.length * fs * 0.6 + 8;
      if (L.len * t.k < tw) continue;
      // Keep repeats of the same street name at least ~360px apart.
      const prev = seenNames.get(L.text);
      if (prev && prev.some(([px, py]) => Math.hypot(px - sx, py - sy) < 360)) continue;
      const rad = L.angle * Math.PI / 180, cos = Math.abs(Math.cos(rad)), sin = Math.abs(Math.sin(rad));
      const hw = (tw * cos + fs * sin) / 2, hh = (tw * sin + fs * cos) / 2;
      const cells = [];
      let clash = false;
      for (let cx = Math.floor((sx - hw) / cell); cx <= Math.floor((sx + hw) / cell) && !clash; cx++)
        for (let cy = Math.floor((sy - hh) / cell); cy <= Math.floor((sy + hh) / cell); cy++) {
          const key = cx + "," + cy;
          if (taken.has(key)) { clash = true; break; }
          cells.push(key);
        }
      if (clash) continue;
      cells.forEach(c => taken.add(c));
      if (!seenNames.has(L.text)) seenNames.set(L.text, []);
      seenNames.get(L.text).push([sx, sy]);
      shown.push({ ...L, sx, sy });
      if (shown.length > 260) break;
    }
    this.labelLayer.selectAll("text").data(shown).join("text")
      .attr("class", d => "m-label" + (d.cls === "major" ? " major" : ""))
      .attr("text-anchor", "middle").attr("dy", "0.35em")
      .attr("transform", d => `translate(${d.sx.toFixed(1)},${d.sy.toFixed(1)}) rotate(${d.angle.toFixed(1)})`)
      .text(d => d.text);

    const mu = this.project(this.handlers.campus.lat, this.handlers.campus.lon);
    const mx = t.applyX(mu[0]), my = t.applyY(mu[1]);
    this.campusLayer.selectAll("*").remove();
    this.campusLayer.append("rect").attr("class", "m-mu").attr("x", mx - 5).attr("y", my - 5).attr("width", 10).attr("height", 10).attr("rx", 2);
    this.campusLayer.append("text").attr("class", "m-campus-label").attr("x", mx).attr("y", my + 22).attr("text-anchor", "middle").text("UC Davis");

    if (this.dots) this.dots.attr("cx", p => t.applyX(p.xy[0])).attr("cy", p => t.applyY(p.xy[1]));
    this._placePopup();
  };

  DavisMap.prototype._showTip = function (p) {
    if (!this.t || !p.xy) return;
    this.tip.textContent = `${p.name} · ${p.overall != null ? p.overall.toFixed(1) : "–"}`;
    this.tip.style.left = this.t.applyX(p.xy[0]) + "px";
    this.tip.style.top = this.t.applyY(p.xy[1]) + "px";
    this.tip.hidden = false;
  };
  DavisMap.prototype._hideTip = function () { this.tip.hidden = true; };

  DavisMap.prototype.openPopup = function (id) {
    const p = this.byId.get(id);
    if (!p) return;
    this.activeId = id;
    this._hideTip();
    this.dots.classed("active", d => d.id === id).filter(d => d.id === id).raise();
    this.popup.innerHTML = this.handlers.popupHTML(p);
    this.popup.hidden = false;
    this.handlers.bindPopup(this.popup, p);
    this._placePopup();
  };

  DavisMap.prototype.closePopup = function () {
    this.activeId = null;
    this.popup.hidden = true;
    if (this.dots) this.dots.classed("active", false);
  };

  DavisMap.prototype._placePopup = function () {
    if (!this.activeId || this.popup.hidden) return;
    const p = this.byId.get(this.activeId);
    const x = this.t.applyX(p.xy[0]), y = this.t.applyY(p.xy[1]);
    const pw = this.popup.offsetWidth, ph = this.popup.offsetHeight, m = 12;
    let left = x + 16, top = y - ph / 2;
    if (left + pw > this.w - m) left = x - pw - 16;
    if (left < m) left = Math.max(m, Math.min(this.w - pw - m, x - pw / 2));
    top = Math.max(m, Math.min(this.h - ph - m, top));
    this.popup.style.left = left + "px";
    this.popup.style.top = top + "px";
  };

  DavisMap.prototype.focus = function (id) {
    const p = this.byId.get(id);
    if (!p || !p.xy) return false;
    const k = Math.max(this.t.k, this.k0 * 9);
    const target = d3.zoomIdentity.translate(this.w / 2 - k * p.xy[0], this.h / 2 - k * p.xy[1]).scale(k);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const sel = reduce ? this.svg : this.svg.transition().duration(900).ease(d3.easeCubicInOut);
    sel.call(this.zoom.transform, target);
    if (reduce) this.openPopup(id);
    else sel.on("end", () => this.openPopup(id));
    return true;
  };

  DavisMap.prototype.zoomBy = function (f) { this.svg.transition().duration(250).call(this.zoom.scaleBy, f); };
  DavisMap.prototype.reset = function () { this.closePopup(); this.svg.transition().duration(500).call(this.zoom.transform, this.home); };

  window.DavisMap = DavisMap;
})();
