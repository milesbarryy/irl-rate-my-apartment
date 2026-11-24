/* RateMyApartment Davis: filters, grid, search, reviews and the review form. */
(function () {
  "use strict";

  const CATS = [
    ["maintenance", "Maintenance"],
    ["location", "Location"],
    ["livability", "Livability"],
    ["value", "Value"],
  ];
  const DISTANCES = [0.25, 0.5, 1, 3];
  // IRL diverging blue-red scale: satisfaction has a natural neutral midpoint (3).
  const SCORE_BINS = [
    { max: 1.75, bg: "#8B1E2F", fg: "#ffffff" },
    { max: 2.25, bg: "#D0606F", fg: "#ffffff" },
    { max: 2.75, bg: "#F0B0B8", fg: "#022851" },
    { max: 3.25, bg: "#F0E8E5", fg: "#022851" },
    { max: 3.75, bg: "#6FCFEB", fg: "#022851" },
    { max: 4.25, bg: "#008EAA", fg: "#ffffff" },
    { max: 9, bg: "#022851", fg: "#ffffff" },
  ];
  const RENT_LO = 200, RENT_HI = 2600, RENT_STEP = 50, BIN = 100;
  const LIMITED = 5;
  const WRITE_ITEMS = [
    ["maintenance", "Maintenance & management"],
    ["grocery", "Access to grocery stores"],
    ["bus", "Access to bus stops"],
    ["campus", "Access to campus"],
    ["entertainment", "Access to entertainment"],
    ["quiet", "Quietness"],
    ["safety", "Safety"],
    ["privacy", "Privacy"],
  ];
  const ISSUES = ["Mold", "Broken Appliance", "Plumbing", "AC/Heating", "Lighting/Electricity",
    "Lack of Communication", "Trash/Waste Disposal", "Issue with deposit returns", "Other"];
  const STORE_KEY = "rma-davis-my-reviews";
  const USER_KEY = "rma-davis-demo-user";

  const $ = (sel, root = document) => root.querySelector(sel);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n) => "$" + Math.round(n).toLocaleString("en-US");
  const norm = (s) => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

  const store = {
    get(key, fallback, session) {
      try { const v = (session ? sessionStorage : localStorage).getItem(key); return v ? JSON.parse(v) : fallback; }
      catch { return fallback; }
    },
    set(key, value, session) {
      try { (session ? sessionStorage : localStorage).setItem(key, JSON.stringify(value)); return true; }
      catch { return false; }
    },
  };

  const state = {
    view: "grid",
    query: "",
    distance: null,
    min: { maintenance: 0, location: 0, livability: 0, value: 0 },
    rent: [RENT_LO, RENT_HI],
    sort: "reviews",
  };

  let DATA, PROPS, BY_ID, REVIEWS_BY_PROP, map, mapDataPromise;
  let myReviews = store.get(STORE_KEY, []);
  let user = store.get(USER_KEY, null, true);

  function scoreStyle(v) {
    if (v == null) return "background:var(--surface-2);color:var(--ink-3)";
    const b = SCORE_BINS.find((b) => v < b.max);
    return `background:${b.bg};color:${b.fg}`;
  }
  const fmt = (v) => (v == null ? "–" : v.toFixed(1));

  function starsHTML(v, label) {
    const pct = v == null ? 0 : Math.max(0, Math.min(100, (v / 5) * 100));
    return `<span class="stars" style="--pct:${pct.toFixed(1)}%" role="img" aria-label="${esc(label)}: ${v == null ? "no data" : v.toFixed(1) + " out of 5"}"></span>`;
  }

  function ratingsHTML(p) {
    return CATS.map(([k, name]) => `
      <div class="rating">
        <span class="name">${name}</span>${starsHTML(p.scores[k], name)}
        <span class="val ${p.scores[k] == null ? "na" : ""}">${fmt(p.scores[k])}</span>
      </div>`).join("");
  }

  function scoreRowHTML(p, caption) {
    const limited = p.n < LIMITED;
    return `<div class="score-row">
      <div class="score-tile" style="${scoreStyle(p.overall)}" aria-label="Overall rating ${fmt(p.overall)} out of 5">${fmt(p.overall)}</div>
      <div class="score-cap">${caption || "Overall"}<span>out of 5</span></div>
    </div>${limited ? `<span class="chip warn" title="Fewer than ${LIMITED} survey responses">Limited data</span>` : ""}`;
  }

  // ---------- Filtering ----------
  function passes(p, skip) {
    if (skip !== "query" && state.view === "grid" && state.query) {
      const q = norm(state.query);
      if (!norm(p.name).includes(q) && !norm(p.address).includes(q) && !norm(p.zone).includes(q)) return false;
    }
    if (skip !== "distance" && state.distance != null && !(p.distance != null && p.distance < state.distance)) return false;
    for (const [k] of CATS) if (state.min[k] && !(p.scores[k] != null && p.scores[k] >= state.min[k])) return false;
    const fullRange = state.rent[0] <= RENT_LO && state.rent[1] >= RENT_HI;
    if (!fullRange) {
      const r = p.rent.median;
      if (r == null || r < state.rent[0] || (state.rent[1] < RENT_HI && r > state.rent[1])) return false;
    }
    return true;
  }

  const SORTS = {
    reviews: (a, b) => b.n - a.n || a.name.localeCompare(b.name),
    // Shrink toward the citywide mean so one glowing response doesn't top the list.
    rating: (a, b) => adjusted(b) - adjusted(a) || b.n - a.n,
    distance: (a, b) => (a.distance ?? 99) - (b.distance ?? 99),
    rent: (a, b) => (a.rent.median ?? 1e9) - (b.rent.median ?? 1e9),
  };

  let CITY_MEAN = 3.5;
  const PRIOR_N = 5;
  function adjusted(p) {
    return p.overall == null ? -1 : (p.overall * p.n + CITY_MEAN * PRIOR_N) / (p.n + PRIOR_N);
  }

  function activeFilterCount() {
    let n = 0;
    if (state.distance != null) n++;
    n += CATS.filter(([k]) => state.min[k]).length;
    if (state.rent[0] > RENT_LO || state.rent[1] < RENT_HI) n++;
    return n;
  }

  function update() {
    const list = PROPS.filter((p) => passes(p)).sort(SORTS[state.sort]);
    const total = PROPS.length;
    const where = state.view === "map" ? `${list.filter((p) => p.lat != null).length} on the map` : "";
    $("#results-count").innerHTML = `Showing <strong>${list.length}</strong> of ${total} properties${where ? " · " + where : ""}`;
    $("#empty-state").hidden = list.length > 0;
    if (state.view === "grid") renderCards(list);
    if (map) map.setVisible(list.map((p) => p.id));
    // Distance counts reflect all other active filters.
    for (const d of DISTANCES) {
      const c = PROPS.filter((p) => passes(p, "distance") && p.distance != null && p.distance < d).length;
      const el = document.querySelector(`[data-count="${d}"]`);
      if (el) el.textContent = c;
    }
    const fc = activeFilterCount();
    const badge = $("#filter-count");
    badge.hidden = !fc;
    badge.textContent = fc;
    drawHistogram();
  }

  // ---------- Cards ----------
  function renderCards(list) {
    $("#grid-view").innerHTML = list.map((p) => {
      const bed = p.rent.byBed;
      const costLine = (k, label) => bed[k]
        ? `<div class="line"><span class="k">${label}</span><span class="v">${money(bed[k].median)}</span></div>`
        : "";
      const lines = costLine("Single", "Single room") + costLine("Double", "Shared room") + (!bed.Single || !bed.Double ? costLine("Triple", "Triple room") + costLine("Studio", "Studio") : "");
      return `<article class="card" id="card-${p.id}" aria-labelledby="t-${p.id}">
        <div class="c-id">
          <div>
            <h3 id="t-${p.id}">${esc(p.name)}</h3>
            <p class="meta">${esc(p.zone)}${p.street ? " · " + esc(p.street) : ""}</p>
          </div>
          ${scoreRowHTML(p)}
        </div>
        <div class="c-general">
          <p class="col-label">General</p>
          <div class="stat"><span class="k">Distance to campus</span><span class="v">${p.distance != null ? p.distance.toFixed(1) + " <small>mi</small>" : "–"}</span></div>
          <div class="stat"><span class="k">Survey responses</span><span class="v">${p.n}</span></div>
        </div>
        <div class="c-ratings">
          <p class="col-label">Ratings</p>
          <div class="ratings">${ratingsHTML(p)}</div>
        </div>
        <div class="cost">
          <p class="col-label">Rent per person</p>
          <div class="lines">${lines || `<p class="na">No rent reported</p>`}</div>
          ${lines ? `<p class="foot">Median monthly rent</p>` : ""}
        </div>
        <div class="actions">
          <button type="button" class="btn btn-secondary" data-read="${p.id}">Read reviews</button>
          <button type="button" class="btn btn-primary" data-write="${p.id}">Write a review</button>
        </div>
      </article>`;
    }).join("");
  }

  // ---------- Filters UI ----------
  function buildFilters() {
    $("#distance-filters").innerHTML = DISTANCES.map((d) => `
      <label class="check">
        <input type="checkbox" value="${d}" id="dist-${String(d).replace(".", "")}">
        <span class="box" aria-hidden="true"></span>
        <span>&lt; ${d} mi</span><span class="count" data-count="${d}"></span>
      </label>`).join("");
    $("#distance-filters").addEventListener("change", (e) => {
      const cb = e.target;
      // Mutually exclusive: checking one clears the others; unchecking clears the filter.
      document.querySelectorAll("#distance-filters input").forEach((x) => { if (x !== cb) x.checked = false; });
      state.distance = cb.checked ? Number(cb.value) : null;
      update();
    });

    $("#rating-filters").innerHTML = CATS.map(([k, name]) => starInputHTML("f-" + k, name, 0)).join("");
    bindStarInputs($("#rating-filters"), (key, v) => {
      state.min[key.slice(2)] = v;
      update();
    }, true);

    const minR = $("#rent-min"), maxR = $("#rent-max"), minN = $("#rent-min-num"), maxN = $("#rent-max-num");
    for (const r of [minR, maxR]) Object.assign(r, { min: RENT_LO, max: RENT_HI, step: RENT_STEP });
    for (const n of [minN, maxN]) Object.assign(n, { min: RENT_LO, max: RENT_HI });
    const fill = document.createElement("span");
    fill.className = "fill";
    $(".dual-range").appendChild(fill);
    const sync = () => {
      minR.value = state.rent[0]; maxR.value = state.rent[1];
      minN.value = state.rent[0]; maxN.value = state.rent[1];
      maxN.placeholder = "";
      const a = ((state.rent[0] - RENT_LO) / (RENT_HI - RENT_LO)) * 100, b = ((state.rent[1] - RENT_LO) / (RENT_HI - RENT_LO)) * 100;
      fill.style.left = a + "%"; fill.style.width = b - a + "%";
      minR.setAttribute("aria-valuetext", money(state.rent[0]));
      maxR.setAttribute("aria-valuetext", state.rent[1] >= RENT_HI ? money(RENT_HI) + " or more" : money(state.rent[1]));
    };
    const setRent = (lo, hi, from) => {
      lo = Math.max(RENT_LO, Math.min(lo, RENT_HI)); hi = Math.max(RENT_LO, Math.min(hi, RENT_HI));
      if (lo > hi) { if (from === "min") hi = lo; else lo = hi; }
      state.rent = [lo, hi];
      sync(); update();
    };
    minR.addEventListener("input", () => setRent(+minR.value, state.rent[1], "min"));
    maxR.addEventListener("input", () => setRent(state.rent[0], +maxR.value, "max"));
    minN.addEventListener("change", () => setRent(+minN.value || RENT_LO, state.rent[1], "min"));
    maxN.addEventListener("change", () => setRent(state.rent[0], +maxN.value || RENT_HI, "max"));
    buildFilters.syncRent = sync;
    sync();

    $("#sort-select").addEventListener("change", (e) => { state.sort = e.target.value; update(); });
    const clear = () => {
      state.distance = null;
      CATS.forEach(([k]) => (state.min[k] = 0));
      state.rent = [RENT_LO, RENT_HI];
      document.querySelectorAll("#distance-filters input").forEach((x) => (x.checked = false));
      resetStarInputs($("#rating-filters"));
      sync(); update();
    };
    $("#clear-filters").addEventListener("click", clear);
    $("#empty-clear").addEventListener("click", () => { clear(); setQuery(""); });

    $("#filters-toggle").addEventListener("click", (e) => {
      const open = $("#filters-panel").classList.toggle("open");
      e.currentTarget.setAttribute("aria-expanded", open);
    });

    $("#score-legend").innerHTML = `<b>1</b>${SCORE_BINS.map((b) => `<i style="background:${b.bg}"></i>`).join("")}<b>5</b>`;
  }

  // Star radio groups, shared by the filters (min rating) and the review form.
  function starInputHTML(key, name, value, required) {
    return `<div class="rate-row" role="radiogroup" aria-labelledby="${key}-lbl" data-key="${key}">
      <span class="rate-name" id="${key}-lbl">${esc(name)}</span>
      <div class="star-input">
        ${[1, 2, 3, 4, 5].map((i) => `<input type="radio" name="${key}" id="${key}-${i}" value="${i}"${i === value ? " checked" : ""}${required && i === 1 ? " required" : ""}>
        <label for="${key}-${i}" title="${i} star${i > 1 ? "s" : ""}${key.startsWith("f-") ? " or more" : ""}" class="${i <= value ? "on" : ""}"><svg aria-hidden="true"><use href="#i-star"/></svg><span class="sr-only">${i} star${i > 1 ? "s" : ""}${key.startsWith("f-") ? " or more" : ""}</span></label>`).join("")}
      </div>
      <span class="rate-val" aria-hidden="true">${key.startsWith("f-") ? "Any" : "–"}</span>
    </div>`;
  }
  function paintStars(row, v, preview) {
    row.querySelectorAll("label").forEach((l, i) => l.classList.toggle("on", i < v));
    if (preview) return;
    const out = row.querySelector(".rate-val");
    const isFilter = row.dataset.key.startsWith("f-");
    out.textContent = v ? (isFilter ? v + "+" : v + " / 5") : isFilter ? "Any" : "–";
    out.classList.toggle("set", !!v);
  }
  function bindStarInputs(root, onChange, toggleOff) {
    root.querySelectorAll(".rate-row").forEach((row) => {
      const key = row.dataset.key;
      const current = () => +(row.querySelector("input:checked")?.value || 0);
      row.querySelectorAll("label").forEach((l, i) => {
        l.addEventListener("mouseenter", () => paintStars(row, i + 1, true));
        // Clicking the selected star again clears it (a radio can't do that natively).
        l.addEventListener("click", (e) => {
          const input = document.getElementById(l.htmlFor);
          if (toggleOff && input.checked) {
            e.preventDefault();
            input.checked = false;
            paintStars(row, 0);
            onChange(key, 0);
          }
        });
      });
      row.addEventListener("mouseleave", () => paintStars(row, current(), true));
      row.addEventListener("change", () => { const v = current(); paintStars(row, v); onChange(key, v); });
    });
  }
  function resetStarInputs(root) {
    root.querySelectorAll(".rate-row").forEach((row) => {
      row.querySelectorAll("input").forEach((i) => (i.checked = false));
      paintStars(row, 0);
    });
  }

  // Rent histogram: all per-person rents, darkest IRL primary, bars outside the range muted.
  function drawHistogram() {
    const svg = $("#rent-hist");
    const bins = [];
    for (let lo = RENT_LO; lo < RENT_HI; lo += BIN) bins.push({ lo, n: 0 });
    for (const r of DATA.rents) {
      const i = Math.min(bins.length - 1, Math.max(0, Math.floor((r - RENT_LO) / BIN)));
      bins[i].n++;
    }
    const W = 260, H = 64, bw = W / bins.length, max = Math.max(...bins.map((b) => b.n));
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    svg.innerHTML = bins.map((b, i) => {
      const h = Math.max(b.n ? 2 : 0, (b.n / max) * (H - 2));
      const inRange = b.lo + BIN > state.rent[0] && (b.lo < state.rent[1] || state.rent[1] >= RENT_HI);
      return `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" class="${inRange ? "" : "off"}"><title>${money(b.lo)}–${money(b.lo + BIN)}${i === bins.length - 1 ? "+" : ""}: ${b.n} responses</title></rect>`;
    }).join("");
  }

  // ---------- Search ----------
  let suggestions = [], activeIdx = -1;
  function setQuery(q) {
    $("#search-input").value = q;
    state.query = q;
    update();
  }
  function matches(q) {
    const n = norm(q).trim();
    if (!n) return [];
    const scored = [];
    for (const p of PROPS) {
      const name = norm(p.name), addr = norm(p.address), zone = norm(p.zone);
      let s = name.startsWith(n) ? 0 : name.split(/\s+/).some((w) => w.startsWith(n)) ? 1 : name.includes(n) ? 2 : addr.includes(n) ? 3 : zone.includes(n) ? 4 : -1;
      if (s >= 0) scored.push([s, p]);
    }
    return scored.sort((a, b) => a[0] - b[0] || b[1].n - a[1].n).slice(0, 8).map((x) => x[1]);
  }
  function renderSuggestions() {
    const input = $("#search-input"), list = $("#search-list");
    const q = input.value.trim();
    suggestions = matches(q);
    activeIdx = -1;
    if (!q || document.activeElement !== input) { list.hidden = true; input.setAttribute("aria-expanded", "false"); return; }
    list.innerHTML = suggestions.length
      ? suggestions.map((p, i) => `<li role="option" id="opt-${i}" data-id="${p.id}" aria-selected="false"><span class="s-name">${esc(p.name)}</span><span class="s-meta">${esc(p.street ? p.street + " · " + p.zone : p.zone)}</span></li>`).join("")
      : `<li class="s-empty" role="option" aria-disabled="true">No properties match “${esc(q)}”</li>`;
    list.hidden = false;
    input.setAttribute("aria-expanded", "true");
  }
  function highlight(i) {
    const items = [...document.querySelectorAll("#search-list li[data-id]")];
    if (!items.length) return;
    activeIdx = (i + items.length) % items.length;
    items.forEach((li, j) => li.setAttribute("aria-selected", j === activeIdx));
    $("#search-input").setAttribute("aria-activedescendant", "opt-" + activeIdx);
    items[activeIdx].scrollIntoView({ block: "nearest" });
  }
  function choose(p) {
    const input = $("#search-input");
    $("#search-list").hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    if (state.view === "map") {
      input.value = p.name;
      state.query = p.name;
      update();
      ensureMap().then(() => {
        if (!map.focus(p.id)) toast(`${p.name} doesn’t have map coordinates yet.`);
      });
    } else {
      setQuery(p.name);
      const card = document.getElementById("card-" + p.id);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "start" });
        card.classList.remove("flash"); void card.offsetWidth; card.classList.add("flash");
      }
    }
  }
  function bindSearch() {
    const input = $("#search-input"), list = $("#search-list");
    input.addEventListener("input", () => { state.query = input.value; renderSuggestions(); update(); });
    input.addEventListener("focus", renderSuggestions);
    input.addEventListener("blur", () => setTimeout(() => { list.hidden = true; input.setAttribute("aria-expanded", "false"); }, 120));
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden) renderSuggestions(); highlight(activeIdx + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); highlight(activeIdx - 1); }
      else if (e.key === "Enter") {
        e.preventDefault();
        const p = suggestions[activeIdx >= 0 ? activeIdx : 0];
        if (p) choose(p);
      } else if (e.key === "Escape") { list.hidden = true; input.setAttribute("aria-expanded", "false"); }
    });
    list.addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-id]");
      if (li) { e.preventDefault(); choose(BY_ID.get(li.dataset.id)); }
    });
  }

  // ---------- View toggle + map ----------
  function ensureMap() {
    if (map) return Promise.resolve(map);
    if (!mapDataPromise) mapDataPromise = fetch("data/davis_map.json").then((r) => r.json());
    return mapDataPromise.then((mapData) => {
      if (map) return map;
      map = new DavisMap($("#map"), mapData, {
        campus: DATA.campus,
        popupHTML: (p) => `
          <div class="pop-head">
            <div><h3>${esc(p.name)}</h3><p class="meta">${esc(p.street || p.zone)} · ${p.n} response${p.n === 1 ? "" : "s"}</p></div>
            <button type="button" class="icon-btn" data-pop-close aria-label="Close"><svg><use href="#i-close"/></svg></button>
          </div>
          ${scoreRowHTML(p)}
          <div class="ratings">${ratingsHTML(p)}</div>
          <div class="btn-row">
            <button type="button" class="btn btn-secondary" data-read="${p.id}">Read reviews</button>
            <button type="button" class="btn btn-primary" data-write="${p.id}">Write a review</button>
          </div>`,
        bindPopup: (el) => el.querySelector("[data-pop-close]").addEventListener("click", () => map.closePopup()),
      });
      map.setProperties(PROPS);
      update();
      $("#zoom-in").addEventListener("click", () => map.zoomBy(1.6));
      $("#zoom-out").addEventListener("click", () => map.zoomBy(1 / 1.6));
      $("#zoom-reset").addEventListener("click", () => map.reset());
      return map;
    });
  }
  function setView(v) {
    state.view = v;
    document.querySelectorAll(".view-toggle button").forEach((b) => b.setAttribute("aria-checked", b.dataset.view === v));
    $("#grid-view").hidden = v !== "grid";
    $("#map-view").hidden = v !== "map";
    try { history.replaceState(null, "", v === "map" ? "#map" : location.pathname + location.search); } catch {}
    update();
    if (v === "map") {
      ensureMap().then(() => {
        const hit = PROPS.find((p) => norm(p.name) === norm(state.query));
        if (hit) map.focus(hit.id);
      }).catch(() => toast("The map couldn’t load. Check your connection and try again."));
    }
  }
  function bindViewToggle() {
    const btns = [...document.querySelectorAll(".view-toggle button")];
    btns.forEach((b, i) => {
      b.addEventListener("click", () => setView(b.dataset.view));
      b.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
          e.preventDefault();
          const next = btns[(i + (e.key === "ArrowRight" ? 1 : -1) + btns.length) % btns.length];
          next.focus(); setView(next.dataset.view);
        }
      });
    });
  }

  // ---------- Dialogs ----------
  function openDialog(d) {
    if (!d.open) d.showModal();
  }
  function bindDialogs() {
    document.querySelectorAll("dialog").forEach((d) => {
      d.addEventListener("click", (e) => {
        if (e.target.closest("[data-close]")) d.close();
        else if (e.target === d) {
          const r = d.getBoundingClientRect();
          if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
        }
      });
    });
    document.addEventListener("click", (e) => {
      const read = e.target.closest("[data-read]");
      const write = e.target.closest("[data-write]");
      if (read) openReviews(read.dataset.read);
      if (write) startReview(write.dataset.write);
    });
  }

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => (t.hidden = true), 4200);
  }

  // ---------- Reviews dialog ----------
  const REVIEW_PAGE = 12;
  function openReviews(id) {
    const p = BY_ID.get(id);
    const all = (REVIEWS_BY_PROP.get(id) || []).slice().sort((a, b) => b.surveyYear - a.surveyYear);
    const mine = myReviews.filter((r) => r.property === p.name);
    $("#reviews-title").textContent = p.name;
    $("#reviews-sub").textContent = [p.zone, p.street, p.distance != null ? `${p.distance.toFixed(1)} mi to campus` : null].filter(Boolean).join(" · ");

    const issuesHTML = p.topIssues.length && p.issueResponses
      ? `<div class="hbars">${p.topIssues.map((x) => {
          const pct = Math.round((100 * x.n) / p.issueResponses);
          return `<div class="hbar"><span>${esc(x.issue)}</span><span class="track"><span class="fill" style="width:${pct}%"></span></span><span class="pct">${pct}%</span></div>`;
        }).join("")}</div>`
      : `<p class="hint">No maintenance issues reported.</p>`;

    const bedRows = Object.entries(p.rent.byBed).map(([k, v]) => `<tr><td>${k === "Double" ? "Shared (double)" : k}</td><td>${money(v.median)}</td><td>${v.n}</td></tr>`).join("");

    $("#reviews-body").innerHTML = `
      <div class="summary">
        <section>
          <h3>Ratings</h3>
          ${scoreRowHTML(p, `Overall from ${p.n} response${p.n === 1 ? "" : "s"}`)}
          <div class="ratings">${ratingsHTML(p)}</div>
        </section>
        <section>
          <h3>What students reported</h3>
          <div class="facts">
            <div><div class="k">Say it’s worth the cost</div><div class="v">${p.worthPct != null ? p.worthPct + "%" : "–"}</div></div>
            <div><div class="k">Had a maintenance issue</div><div class="v">${p.issuePct != null ? p.issuePct + "%" : "–"}</div></div>
            <div><div class="k">Typical commute</div><div class="v">${esc(p.commute || "–")}</div></div>
            <div><div class="k">Bus lines used</div><div class="v">${p.buses.length ? esc(p.buses.join(", ")) : "–"}</div></div>
          </div>
        </section>
      </div>
      <div class="summary">
        <section>
          <h3>Most common issues</h3>
          ${issuesHTML}
          ${p.issueResponses ? `<p class="hint" style="margin-top:8px">Share of ${p.issueResponses} respondents in 2025–2026 (the years this was asked)</p>` : ""}
        </section>
        <section>
          <h3>Rent per person</h3>
          ${bedRows ? `<table class="rent-table"><thead><tr><th>Room</th><th>Median / month</th><th>Responses</th></tr></thead><tbody>${bedRows}</tbody></table>` : `<p class="hint">No rent reported.</p>`}
        </section>
      </div>
      <div class="review-tools">
        <h3 class="section-title" style="margin:0">Individual responses</h3>
        <div class="seg" role="group" aria-label="Filter by survey year">
          ${["All", ...p.years.slice().reverse()].map((y, i) => `<button type="button" data-year="${y}" aria-pressed="${i === 0}">${y}</button>`).join("")}
        </div>
      </div>
      <div class="review-list" id="review-list"></div>
      <div class="more"><button type="button" class="btn btn-secondary" id="more-reviews">Show more</button></div>
      <div class="more"><button type="button" class="btn btn-primary" data-write="${p.id}">Write a review</button></div>`;

    let year = "All", shown = REVIEW_PAGE;
    const draw = () => {
      const list = all.filter((r) => year === "All" || r.surveyYear === +year);
      const mineHTML = year === "All" ? mine.map((r) => reviewHTML(r, true)).join("") : "";
      $("#review-list").innerHTML = mineHTML + list.slice(0, shown).map((r) => reviewHTML(r)).join("");
      $("#more-reviews").hidden = shown >= list.length;
      $("#more-reviews").textContent = `Show more (${list.length - shown} left)`;
    };
    $("#reviews-body").querySelector(".seg").addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      year = b.dataset.year; shown = REVIEW_PAGE;
      b.parentElement.querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", x === b));
      draw();
    });
    $("#more-reviews").addEventListener("click", () => { shown += REVIEW_PAGE; draw(); });
    draw();
    const dlg = $("#reviews-dialog");
    openDialog(dlg);
    $("#reviews-body").scrollTop = 0;
  }

  function reviewHTML(r, mine) {
    const bits = [];
    if (r.bed) bits.push(r.bed === "Double" ? "Shared room" : r.bed === "Single" ? "Single room" : r.bed);
    if (r.rent) bits.push(money(r.rent) + "/mo");
    if (r.moveIn) bits.push("moved in " + r.moveIn);
    const scores = CATS.filter(([k]) => r.scores[k] != null)
      .map(([k, n]) => `<span>${n} <b>${k === "value" ? (r.worth === "Yes" ? "Worth it" : "Not worth it") : r.scores[k].toFixed(1)}</b></span>`).join("");
    const tags = [
      ...(r.issues || []).map((i) => `<span class="tag issue">${esc(i)}</span>`),
      ...(r.improve || []).map((i) => `<span class="tag">Wants better: ${esc(i)}</span>`),
      r.transit ? `<span class="tag good">Gets to campus by ${esc(r.transit.toLowerCase())}</span>` : "",
      r.commute ? `<span class="tag">${esc(r.commute)} commute</span>` : "",
    ].join("");
    return `<article class="review${mine ? " mine" : ""}">
      <div class="review-head">
        <strong>${mine ? "Your review · saved in this browser" : r.surveyYear + " housing survey"}</strong>
        <span class="meta">${esc(bits.join(" · "))}</span>
      </div>
      <div class="review-scores">${scores || `<span>No ratings given</span>`}</div>
      ${tags ? `<div class="review-tags">${tags}</div>` : ""}
      ${mine && r.comment ? `<p class="review-text">${esc(r.comment)}</p>` : ""}
    </article>`;
  }

  // ---------- Sign in + write a review ----------
  let pendingWrite = null;
  function renderUser() {
    $("#signin-label").textContent = user ? `${user} · Sign out` : "Sign in (SSO)";
  }
  function bindSignin() {
    renderUser();
    $("#signin-btn").addEventListener("click", () => {
      if (user) { user = null; store.set(USER_KEY, null, true); renderUser(); toast("Signed out."); return; }
      openDialog($("#signin-dialog"));
    });
    $("#demo-signin").addEventListener("click", () => {
      user = "Demo student";
      store.set(USER_KEY, user, true);
      renderUser();
      $("#signin-dialog").close();
      toast("Signed in to demo mode.");
      if (pendingWrite) { const id = pendingWrite; pendingWrite = null; startReview(id); }
    });
    $("#signin-dialog").addEventListener("close", () => { if (!user) pendingWrite = null; });
  }

  function startReview(id) {
    if (!user) { pendingWrite = id; openDialog($("#signin-dialog")); return; }
    if ($("#reviews-dialog").open) $("#reviews-dialog").close();
    const p = BY_ID.get(id);
    const years = [];
    for (let y = new Date().getFullYear(); y >= 2019; y--) years.push(y);
    $("#write-sub").textContent = "Rate what it’s actually like to live here. 1 = very dissatisfied, 5 = very satisfied.";
    $("#write-body").innerHTML = `
      <div class="form-grid">
        <label class="field full" for="w-prop">Property
          <select id="w-prop" name="property">${PROPS.slice().sort((a, b) => a.name.localeCompare(b.name)).map((x) => `<option value="${x.id}"${x.id === id ? " selected" : ""}>${esc(x.name)}</option>`).join("")}</select>
        </label>
        <label class="field" for="w-year">Year you moved in
          <select id="w-year" name="moveIn">${years.map((y) => `<option>${y}</option>`).join("")}</select>
        </label>
        <label class="field" for="w-bed">Room type
          <select id="w-bed" name="bed">
            <option value="Single">Single room</option><option value="Double">Shared room (double)</option>
            <option value="Triple">Triple</option><option value="Studio">Studio</option><option value="Other">Other</option>
          </select>
        </label>
        <label class="field full" for="w-rent">Your monthly rent (your share, before utilities)
          <span class="money"><span aria-hidden="true">$</span><input id="w-rent" name="rent" type="number" inputmode="numeric" min="0" max="10000" step="1" placeholder="e.g. 1100"></span>
        </label>
      </div>
      <fieldset class="field-set">
        <legend>How satisfied are you with…</legend>
        <div class="write-ratings">${WRITE_ITEMS.map(([k, n]) => starInputHTML("w-" + k, n, 0)).join("")}</div>
        <p class="field"><span class="err" id="w-rate-err" hidden>Rate at least one item.</span></p>
      </fieldset>
      <fieldset class="field-set">
        <legend>Is your housing worth the cost?</legend>
        <div class="pill-choices">
          <label><input type="radio" name="worth" value="Yes" id="w-worth-yes"><span>Yes</span></label>
          <label><input type="radio" name="worth" value="No" id="w-worth-no"><span>No</span></label>
        </div>
        <p class="field"><span class="err" id="w-worth-err" hidden>Choose Yes or No.</span></p>
      </fieldset>
      <fieldset class="field-set">
        <legend>Maintenance issues you’ve had (optional)</legend>
        <div class="pill-choices">${ISSUES.map((x, i) => `<label><input type="checkbox" name="issues" value="${esc(x)}" id="w-issue-${i}"><span>${esc(x)}</span></label>`).join("")}</div>
      </fieldset>
      <label class="field" for="w-comment">Anything else students should know? (optional)
        <textarea id="w-comment" name="comment" maxlength="600" placeholder="Leasing, landlord communication, noise, what you'd tell a friend…"></textarea>
      </label>`;
    bindStarInputs($("#write-body"), () => ($("#w-rate-err").hidden = true), false);
    $("#write-body").addEventListener("change", (e) => { if (e.target.name === "worth") $("#w-worth-err").hidden = true; });
    openDialog($("#write-dialog"));
    $("#write-body").scrollTop = 0;
  }

  function bindWriteForm() {
    $("#write-form").addEventListener("submit", (e) => {
      e.preventDefault();
      const f = e.target;
      const items = {};
      for (const [k] of WRITE_ITEMS) {
        const v = f.querySelector(`input[name="w-${k}"]:checked`);
        if (v) items[k] = +v.value;
      }
      const worth = f.querySelector('input[name="worth"]:checked')?.value;
      $("#w-rate-err").hidden = Object.keys(items).length > 0;
      $("#w-worth-err").hidden = !!worth;
      if (!Object.keys(items).length || !worth) {
        (Object.keys(items).length ? $("#w-worth-yes") : f.querySelector(".write-ratings input")).focus();
        return;
      }
      const avg = (ks) => { const xs = ks.map((k) => items[k]).filter((x) => x != null); return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; };
      const p = BY_ID.get($("#w-prop").value);
      const rent = +$("#w-rent").value || null;
      const review = {
        property: p.name,
        surveyYear: new Date().getFullYear(),
        moveIn: $("#w-year").value,
        bed: $("#w-bed").value,
        rent,
        items,
        scores: {
          maintenance: avg(["maintenance"]),
          location: avg(["grocery", "bus", "campus", "entertainment"]),
          livability: avg(["quiet", "safety", "privacy"]),
          value: worth === "Yes" ? 5 : 1,
        },
        worth,
        issues: [...f.querySelectorAll('input[name="issues"]:checked')].map((x) => x.value),
        comment: $("#w-comment").value.trim(),
        savedAt: new Date().toISOString(),
      };
      myReviews = myReviews.filter((r) => r.property !== p.name).concat(review);
      const ok = store.set(STORE_KEY, myReviews);
      $("#write-dialog").close();
      toast(ok ? `Review for ${p.name} saved in this browser.` : "Review saved for this visit only — this browser is blocking storage.");
    });
  }

  // ---------- Boot ----------
  function boot(data) {
    DATA = data;
    PROPS = data.properties;
    const rated = PROPS.filter((p) => p.overall != null);
    CITY_MEAN = rated.reduce((s, p) => s + p.overall * p.n, 0) / rated.reduce((s, p) => s + p.n, 0);
    BY_ID = new Map(PROPS.map((p) => [p.id, p]));
    const byName = new Map(PROPS.map((p) => [p.name, p.id]));
    REVIEWS_BY_PROP = new Map();
    for (const r of data.reviews) {
      const id = byName.get(r.property);
      if (!REVIEWS_BY_PROP.has(id)) REVIEWS_BY_PROP.set(id, []);
      REVIEWS_BY_PROP.get(id).push(r);
    }
    $("#data-source").textContent = `Based on ${data.surveyResponses.toLocaleString()} responses from IRL’s 2024–2026 housing surveys that named a Davis apartment complex. Updated ${data.generated}.`;
    buildFilters();
    bindSearch();
    bindViewToggle();
    bindDialogs();
    bindSignin();
    bindWriteForm();
    setView(location.hash === "#map" ? "map" : "grid");
    // Warm the map download once the grid is up.
    (window.requestIdleCallback || setTimeout)(() => { if (!mapDataPromise) mapDataPromise = fetch("data/davis_map.json").then((r) => r.json()); });
  }

  fetch("data/properties.json")
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(boot)
    .catch(() => { $("#results-count").textContent = "Survey results couldn’t load. Refresh the page to try again."; });
})();
