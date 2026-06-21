/* ============================================================
   PageMapper web UI — vanilla JS + Cytoscape.js (+ fcose)
   ============================================================ */
(function () {
  "use strict";

  // ---- Register layout extension (graceful fallback) --------------------
  var LAYOUT_NAME = "cose"; // safe default
  try {
    if (window.cytoscape && window.cytoscapeFcose) {
      window.cytoscape.use(window.cytoscapeFcose);
      LAYOUT_NAME = "fcose";
    }
  } catch (e) {
    console.warn("fcose registration failed, falling back to cose:", e);
    LAYOUT_NAME = "cose";
  }

  // ---- View definitions --------------------------------------------------
  var VIEWS = {
    page: { kinds: ["page"], edges: ["navigate"], desc: "page nodes · navigate edges" },
    file: { kinds: ["file", "page"], edges: ["import"], desc: "file nodes · import edges" },
    uses: { kinds: ["file", "page"], edges: ["uses"], desc: "component usage · uses edges" },
    api:  { kinds: ["file", "page"], edges: ["api"], desc: "service & datasource · api edges" }
  };

  var LAYER_VAR = {
    presentation: "--layer-presentation",
    domain: "--layer-domain",
    data: "--layer-data",
    other: "--layer-other"
  };
  var EDGE_VAR = {
    import: "--edge-import",
    navigate: "--edge-navigate",
    uses: "--edge-uses",
    api: "--edge-api"
  };

  // Which view best surfaces each insight category's edges/nodes.
  var INSIGHT_VIEW = {
    "layer-violation": "file",
    "cross-feature-import": "file",
    "circular-dep": "file",
    "god-file": "file",
    "dead-page": "page",
    "orphan-file": "file",
    "nav-depth": "page"
  };
  var SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---- State -------------------------------------------------------------
  var state = {
    data: null,
    cy: null,
    view: "page",
    activePackages: new Set(),   // empty => all
    activeFeatures: new Set(),   // empty => all
    groupByPackage: false,
    edgeLabels: true,
    selectedId: null,
    canSource: false,  // server can serve file source (set from /capabilities)
    canPreview: false, // server can generate UI mockups
    catalogUrl: null,  // base URL of a Flutter-Web component catalog, if any
    appUrl: null,      // base URL of the real app on Flutter Web (route deep-link)
    codePath: null,    // file currently open in the code modal
    codeRoute: null,   // routePath of the node open in the code modal (if a page)
    focusInsight: null // Set of node ids force-kept on the graph for an insight
  };

  // ---- Shareable URL state ----------------------------------------------
  // Persist view + filters + toggles in the location hash so a graph is
  // bookmarkable/linkable. Format (empty keys omitted):
  //   #view=file&pkg=core,auth&feat=todo&groups=1&labels=0
  // Theme stays in localStorage (intentionally not in the URL); selection is
  // transient and also not encoded.
  // A Set is not array-like, so Array.prototype.slice.call(set) yields [].
  // Materialize it the ES5-safe way (no Array.from / spread) for serialization.
  function setToArray(set) {
    var out = [];
    set.forEach(function (v) { out.push(v); });
    return out;
  }

  function syncUrl() {
    var parts = [];
    if (state.view && state.view !== "page") parts.push("view=" + encodeURIComponent(state.view));
    if (state.activePackages.size) {
      parts.push("pkg=" + setToArray(state.activePackages).map(encodeURIComponent).join(","));
    }
    if (state.activeFeatures.size) {
      parts.push("feat=" + setToArray(state.activeFeatures).map(encodeURIComponent).join(","));
    }
    if (state.groupByPackage) parts.push("groups=1");
    if (!state.edgeLabels) parts.push("labels=0");
    var hash = parts.length ? "#" + parts.join("&") : "";
    try {
      // replaceState (not pushState) so filter clicks don't spam Back history.
      history.replaceState(null, "", location.pathname + location.search + hash);
    } catch (e) {
      location.hash = hash; // fallback for environments without history API
    }
  }

  // Parse the location hash into state BEFORE the first render. Values are
  // validated: view must be a known VIEWS key; packages/features are free
  // strings (pruneFilters/renderFilters tolerate unknowns gracefully).
  function applyHashToState() {
    var raw = (location.hash || "").replace(/^#/, "");
    if (!raw) return;
    var params = {};
    raw.split("&").forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf("=");
      var k = i === -1 ? kv : kv.slice(0, i);
      var v = i === -1 ? "" : kv.slice(i + 1);
      params[decodeURIComponent(k)] = v;
    });
    if (params.view && VIEWS[decodeURIComponent(params.view)]) {
      state.view = decodeURIComponent(params.view);
    }
    if (params.pkg) {
      params.pkg.split(",").forEach(function (p) {
        if (p) state.activePackages.add(decodeURIComponent(p));
      });
    }
    if (params.feat) {
      params.feat.split(",").forEach(function (f) {
        if (f) state.activeFeatures.add(decodeURIComponent(f));
      });
    }
    if (params.groups === "1") state.groupByPackage = true;
    if (params.labels === "0") state.edgeLabels = false;
  }

  // ---- Data load with fallback ------------------------------------------
  function loadData() {
    // Standalone export embeds the graph; use it and skip the network.
    if (window.__PM_GRAPH__) return Promise.resolve(window.__PM_GRAPH__);
    return fetch("/graph.json")
      .then(function (r) { if (!r.ok) throw new Error("graph.json " + r.status); return r.json(); })
      .catch(function () {
        return fetch("sample-graph.json").then(function (r) {
          if (!r.ok) throw new Error("sample-graph.json " + r.status);
          return r.json();
        });
      });
  }

  // ---- Build cytoscape elements for current view & filters --------------
  function buildElements() {
    var data = state.data;
    var view = VIEWS[state.view];
    var nodes = data.nodes;
    var edges = data.edges;

    // package / feature filter sets
    var pkgSet = state.activePackages;
    var featSet = state.activeFeatures;

    function passesFilter(n) {
      if (pkgSet.size && !pkgSet.has(n.package)) return false;
      if (featSet.size && !featSet.has(n.feature || "")) return false;
      return true;
    }

    // 1. candidate nodes by kind + filter
    var nodeById = {};
    nodes.forEach(function (n) { nodeById[n.id] = n; });

    var allowedKinds = view.kinds;
    var visibleNodeIds = new Set();
    nodes.forEach(function (n) {
      if (allowedKinds.indexOf(n.kind) === -1) return;
      if (!passesFilter(n)) return;
      visibleNodeIds.add(n.id);
    });

    // 2. edges of the right type whose endpoints are visible
    var elEdges = [];
    var seenPair = {};
    edges.forEach(function (e) {
      if (view.edges.indexOf(e.type) === -1) return;
      if (!visibleNodeIds.has(e.source) || !visibleNodeIds.has(e.target)) return;
      elEdges.push({
        data: {
          id: e.id, source: e.source, target: e.target,
          etype: e.type, label: e.label || ""
        }
      });
    });

    // 3. only keep nodes that participate (avoid orphan clutter) — but keep
    //    page nodes always in page view so isolated pages still appear.
    var connected = new Set();
    elEdges.forEach(function (e) { connected.add(e.data.source); connected.add(e.data.target); });

    var elNodes = [];
    var parents = {}; // package -> compound node
    var hiddenIsolated = 0;
    visibleNodeIds.forEach(function (id) {
      var n = nodeById[id];
      // Only show nodes that participate in an edge of this view. Isolated
      // nodes (e.g. a page never navigated to/from) are clutter and make the
      // layout unreadable, so we drop them and report the count instead.
      // Exception: nodes pinned by an active insight (dead pages / orphan
      // files are isolated by definition — keep them so they can be located).
      var keep = connected.has(id) || (state.focusInsight && state.focusInsight.has(id));
      if (!keep) { hiddenIsolated++; return; }

      var parentId = null;
      if (state.groupByPackage && n.package) {
        parentId = "pkg::" + n.package;
        if (!parents[parentId]) {
          parents[parentId] = { data: { id: parentId, label: n.package, isParent: true } };
        }
      }
      elNodes.push({
        data: {
          id: n.id,
          label: n.label,
          kind: n.kind,
          layer: n.layer || "other",
          pkg: n.package || "",
          feature: n.feature || "",
          route: n.routePath || "",
          parent: parentId
        }
      });
    });

    state.hiddenIsolated = hiddenIsolated;
    var elParents = Object.keys(parents).map(function (k) { return parents[k]; });
    return elParents.concat(elNodes).concat(elEdges);
  }

  // ---- Cytoscape stylesheet ---------------------------------------------
  function buildStyle() {
    var layerColor = {};
    Object.keys(LAYER_VAR).forEach(function (k) { layerColor[k] = cssVar(LAYER_VAR[k]); });
    var edgeColor = {};
    Object.keys(EDGE_VAR).forEach(function (k) { edgeColor[k] = cssVar(EDGE_VAR[k]); });

    var ink = cssVar("--ink");
    var surface = cssVar("--surface");
    var surface2 = cssVar("--surface-2");
    var canvas = cssVar("--canvas");
    var line = cssVar("--line-strong");
    var faint = cssVar("--ink-faint");
    var accent = cssVar("--accent");

    return [
      {
        selector: "node",
        style: {
          "label": "data(label)",
          "font-family": "Hanken Grotesk, Segoe UI, sans-serif",
          "font-size": "11px",
          "font-weight": 600,
          "color": ink,
          // outline keeps labels legible over edges on the dark canvas
          "text-outline-color": canvas,
          "text-outline-width": 2.4,
          "text-outline-opacity": 1,
          "text-valign": "bottom",
          "text-margin-y": 7,
          "text-wrap": "wrap",
          "text-max-width": "120px",
          "min-zoomed-font-size": 7,
          "width": 30, "height": 30,
          "border-width": 1.5,
          "background-color": surface2,
          "transition-property": "opacity, border-width, width, height, underlay-opacity, background-opacity",
          "transition-duration": "200ms"
        }
      },
      // file = round, neutral fill + thin layer ring + soft layer-tinted halo
      {
        selector: 'node[kind = "file"]',
        style: {
          "shape": "ellipse",
          "background-color": surface2,
          "background-opacity": 1,
          "border-color": function (n) { return layerColor[n.data("layer")] || layerColor.other; },
          "border-opacity": 0.85,
          "underlay-color": function (n) { return layerColor[n.data("layer")] || layerColor.other; },
          "underlay-opacity": 0.09,
          "underlay-padding": 3,
          "underlay-shape": "ellipse"
        }
      },
      // page = rounded square, neutral fill + layer ring + glowing halo
      {
        selector: 'node[kind = "page"]',
        style: {
          "shape": "round-rectangle",
          "width": 46, "height": 40,
          "background-color": surface,
          "background-opacity": 1,
          "border-width": 2,
          "border-color": function (n) { return layerColor[n.data("layer")] || layerColor.other; },
          "border-opacity": 0.95,
          "font-weight": "bold",
          "underlay-color": function (n) { return layerColor[n.data("layer")] || layerColor.other; },
          "underlay-opacity": 0.15,
          "underlay-padding": 6,
          "underlay-shape": "round-rectangle"
        }
      },
      // compound package parent
      {
        selector: "node[?isParent]",
        style: {
          "label": "data(label)",
          "shape": "round-rectangle",
          "background-color": cssVar("--surface-2"),
          "background-opacity": 0.55,
          "border-width": 1.5,
          "border-color": line,
          "border-style": "dashed",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": -4,
          "font-size": "11px",
          "font-weight": "bold",
          "color": faint,
          "padding": 18
        }
      },
      // edges
      {
        selector: "edge",
        style: {
          "width": 1.3,
          "line-color": function (e) { return edgeColor[e.data("etype")] || faint; },
          "line-opacity": 0.5,
          "line-cap": "round",
          "target-arrow-color": function (e) { return edgeColor[e.data("etype")] || faint; },
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.85,
          "curve-style": "bezier",
          "opacity": 0.6,
          "font-family": "Cascadia Code, Consolas, monospace",
          "font-size": "9px",
          "color": ink,
          "text-outline-color": canvas,
          "text-outline-width": 2,
          "text-rotation": "autorotate",
          "text-background-color": surface,
          "text-background-opacity": 0.85,
          "text-background-padding": "3px",
          "text-background-shape": "round-rectangle",
          "transition-property": "opacity, width, line-color",
          "transition-duration": "180ms"
        }
      },
      { selector: 'edge[etype = "uses"]', style: { "line-style": "dashed" } },
      { selector: 'edge[etype = "api"]', style: { "line-style": "dotted", "width": 2 } },
      { selector: 'edge[etype = "navigate"]', style: { "width": 2.4, "target-arrow-shape": "triangle-backcurve", "opacity": 0.92 } },
      // edge labels toggle
      { selector: "edge.show-label", style: { "label": "data(label)" } },
      // hover affordance (class toggled by mouseover/mouseout in init)
      {
        selector: "node.cyhover",
        style: { "border-color": accent, "border-width": 2.5, "underlay-color": accent, "underlay-opacity": 0.18, "underlay-padding": 5, "z-index": 15 }
      },
      // highlight states
      { selector: ".faded", style: { "opacity": 0.07, "text-opacity": 0, "underlay-opacity": 0 } },
      {
        selector: "node.highlight",
        style: { "border-width": 3, "opacity": 1, "underlay-color": accent, "underlay-opacity": 0.26, "underlay-padding": 7, "z-index": 20 }
      },
      {
        selector: "node.focus",
        style: {
          "border-width": 3.5,
          "border-color": accent,
          "underlay-color": accent,
          "underlay-opacity": 0.36,
          "underlay-padding": 11,
          "underlay-shape": "ellipse",
          "z-index": 25
        }
      },
      { selector: "edge.highlight", style: { "opacity": 1, "line-opacity": 1, "width": 2.6, "z-index": 18, "label": "data(label)" } }
    ];
  }

  function layoutOptions() {
    if (LAYOUT_NAME === "fcose") {
      return {
        name: "fcose",
        quality: "default",
        animate: false,
        randomize: true,
        fit: true,
        padding: 50,
        nodeSeparation: 90,
        idealEdgeLength: 95,
        nodeRepulsion: 7000,
        gravity: 0.25,
        gravityRange: 3.0,
        packComponents: true
      };
    }
    return {
      name: "cose",
      animate: false,
      fit: true,
      padding: 50,
      nodeRepulsion: 9000,
      idealEdgeLength: 95,
      nestingFactor: 1.1,
      gravity: 0.4
    };
  }

  function runLayout() {
    if (!state.cy) return;
    var l = state.cy.layout(layoutOptions());
    l.run();
  }

  // ---- Edge label visibility by zoom + selection ------------------------
  function applyEdgeLabels() {
    var cy = state.cy;
    if (!cy) return;
    var big = cy.edges().length > 60;
    var zoom = cy.zoom();
    cy.edges().forEach(function (e) {
      if (!state.edgeLabels) { e.removeClass("show-label"); return; }
      // For large graphs, only show labels when zoomed in or highlighted
      var show = !big || zoom > 1.1 || e.hasClass("highlight");
      if (show && e.data("label")) e.addClass("show-label");
      else e.removeClass("show-label");
    });
  }

  // ---- Render the graph for current state -------------------------------
  function render(relayout) {
    var els = buildElements();
    var cy = state.cy;
    cy.startBatch();
    cy.elements().remove();
    cy.add(els);
    cy.endBatch();

    document.getElementById("empty-state").hidden = cy.nodes('[!isParent]').length > 0;

    // Append a "(N isolated hidden)" note to the view description.
    var descEl = document.getElementById("view-desc");
    var base = VIEWS[state.view].desc;
    descEl.textContent = state.hiddenIsolated
      ? base + " · " + state.hiddenIsolated + " isolated hidden"
      : base;

    if (relayout !== false) runLayout();
    applyEdgeLabels();

    // restore selection highlight if still present
    if (state.selectedId && cy.getElementById(state.selectedId).nonempty()) {
      highlightNode(state.selectedId, false);
    } else {
      clearHighlight();
    }
  }

  // Re-render after a filter change WITHOUT a fresh global layout. A full
  // fcose pass on ~1000 nodes is expensive and runs on every chip toggle, so
  // we snapshot existing node positions, rebuild the element set, restore the
  // positions for nodes that survived, and only run layout for genuinely new
  // (unpositioned) nodes — same approach liveReload() uses for SSE updates.
  function renderKeepFilters() {
    var cy = state.cy;
    if (!cy) { render(true); return; }

    var savedPos = {};
    cy.nodes().forEach(function (n) { var p = n.position(); savedPos[n.id()] = { x: p.x, y: p.y }; });
    var savedZoom = cy.zoom();
    var savedPan = { x: cy.pan().x, y: cy.pan().y };

    var els = buildElements();
    cy.startBatch();
    cy.elements().remove();
    cy.add(els);
    cy.endBatch();

    document.getElementById("empty-state").hidden = cy.nodes('[!isParent]').length > 0;
    var descEl = document.getElementById("view-desc");
    var base = VIEWS[state.view].desc;
    descEl.textContent = state.hiddenIsolated ? base + " · " + state.hiddenIsolated + " isolated hidden" : base;

    // Reuse prior positions; only newly-appeared nodes need placing.
    var newNodes = [];
    cy.nodes('[!isParent]').forEach(function (n) {
      var sp = savedPos[n.id()];
      if (sp) n.position(sp); else newNodes.push(n);
    });

    if (newNodes.length) {
      // Some nodes have no prior position → lay out from current positions
      // (no randomize, no global re-fit) so existing nodes stay put.
      var l = cy.layout(Object.assign({}, layoutOptions(), { fit: false, randomize: false, animate: false }));
      l.run();
      cy.zoom(savedZoom);
      cy.pan(savedPan);
    } else {
      // No new nodes (filter only removed nodes/edges) → keep camera exactly.
      cy.zoom(savedZoom);
      cy.pan(savedPan);
    }

    applyEdgeLabels();
    if (state.selectedId && cy.getElementById(state.selectedId).nonempty()) highlightNode(state.selectedId, false);
    else clearHighlight();
  }

  // ---- Live updates (SSE, watch mode) -----------------------------------
  // The server emits a `graph` event whenever it re-analyzes the project.
  // We re-fetch and re-render in place, preserving the current view, filters,
  // selection, and camera so the user isn't yanked around on every save.
  function setupLiveUpdates() {
    if (!window.EventSource) return;
    var es;
    try { es = new EventSource("/events"); } catch (e) { return; }
    var firstEvent = true;
    es.addEventListener("graph", function () {
      // The server sends one event immediately on connect; ignore that so we
      // only reload on genuine changes.
      if (firstEvent) { firstEvent = false; return; }
      liveReload();
    });
    // Catalog was rebuilt (watch + --catalog-build): refresh the Live iframe.
    es.addEventListener("catalog", function () {
      var f = document.querySelector("#code-live iframe");
      if (!f) return;
      f.src = f.src.split("&_ts=")[0] + "&_ts=" + Date.now();
      toast("Catalog rebuilt — Live preview refreshed");
    });
  }

  // Export: PNG (client-side snapshot of the current view) + standalone HTML
  // (server-generated, one portable interactive file). PNG always works; the
  // HTML button only appears when served (a standalone export has no server).
  function setupExport() {
    var png = document.getElementById("btn-png");
    if (png) png.addEventListener("click", exportPng);

    var html = document.getElementById("btn-export");
    if (!html) return;
    if (window.__PM_GRAPH__) { html.hidden = true; return; }
    fetch("/capabilities").then(function (r) { return r.json(); }).then(function (c) {
      if (c && c.export) html.hidden = false;
    }).catch(function () { /* leave hidden */ });
    html.addEventListener("click", function () {
      toast("Building standalone HTML…");
      window.location.href = "/export.html";
    });
  }

  function exportPng() {
    var cy = state.cy;
    if (!cy) return;
    var png = cy.png({ full: true, scale: 2, bg: cssVar("--canvas") });
    var a = document.createElement("a");
    a.href = png;
    a.download = "pagemapper-" + state.view + ".png";
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("PNG exported");
  }

  // Source code viewer: when served, the detail panel offers a "View source"
  // button that fetches the file's text from the server and shows it in a modal.
  function setupSource() {
    if (window.__PM_GRAPH__) return; // standalone export has no server
    fetch("/capabilities").then(function (r) { return r.json(); }).then(function (c) {
      if (c && c.source) state.canSource = true;
      if (c && c.preview) state.canPreview = true;
      if (c && c.catalog) state.catalogUrl = c.catalog;
      if (c && c.appUrl) state.appUrl = c.appUrl;
    }).catch(function () { /* leave disabled */ });

    var modal = document.getElementById("code-modal");
    var close = document.getElementById("code-close");
    if (close) close.addEventListener("click", closeCode);
    if (modal) modal.addEventListener("click", function (e) { if (e.target === modal) closeCode(); });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && modal && !modal.hidden) closeCode();
    });
    [["tab-source", "source"], ["tab-preview", "preview"], ["tab-live", "live"]].forEach(function (t) {
      var el = document.getElementById(t[0]);
      if (el) el.addEventListener("click", function () { showCodeTab(t[1]); });
    });
  }

  function closeCode() {
    var modal = document.getElementById("code-modal");
    if (modal) modal.hidden = true;
  }

  // Scale the fixed-size (412×892 logical) phone frame down to fit the modal —
  // the app still lays out for a real phone width, so nothing gets squished; we
  // just shrink the whole mockup visually (transform), compensating the layout
  // box height with a negative margin so it stays centered without a scrollbar.
  function fitDeviceFrame() {
    var LW = 412, LH = 892;
    var frames = document.querySelectorAll(".code-preview:not([hidden]) .preview-frame");
    Array.prototype.forEach.call(frames, function (frame) {
      var host = frame.closest(".code-preview");
      if (!host || !host.clientHeight) return;
      var note = host.querySelector(".preview-note");
      var availH = host.clientHeight - (note ? note.offsetHeight : 0) - 34;
      var availW = host.clientWidth - 30;
      var s = Math.min(availW / LW, availH / LH, 1);
      if (!isFinite(s) || s <= 0) s = 0.5;
      frame.style.transform = "scale(" + s.toFixed(3) + ")";
      frame.style.marginBottom = Math.round(-LH * (1 - s)) + "px";
    });
  }

  function showCodeTab(tab) {
    document.getElementById("tab-source").classList.toggle("active", tab === "source");
    document.getElementById("tab-preview").classList.toggle("active", tab === "preview");
    var tabLive = document.getElementById("tab-live");
    if (tabLive) tabLive.classList.toggle("active", tab === "live");
    document.getElementById("code-body").hidden = tab !== "source";
    document.getElementById("code-preview").hidden = tab !== "preview";
    document.getElementById("code-live").hidden = tab !== "live";
    if (tab === "preview") loadPreview(state.codePath);
    if (tab === "live") loadLive(state.codePath);
    if (tab !== "source") { requestAnimationFrame(fitDeviceFrame); setTimeout(fitDeviceFrame, 320); }
  }

  // Derive the Dart class name from a file path (venio convention:
  // snake_case file == PascalCase class). e.g. ven_primary_button.dart →
  // VenPrimaryButton, login_page.dart → LoginPage.
  function classFromPath(relPath) {
    var base = relPath.split("/").pop().replace(/\.dart$/, "");
    return base.split("_").map(function (s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }).join("");
  }

  // "Live" tab: embed the real Flutter-Web component catalog, deep-linked to
  // this node's class. Unknown classes fall back to the catalog index.
  function loadLive(relPath) {
    var host = document.getElementById("code-live");
    if (!host || !relPath) return;
    var useApp = state.appUrl && state.codeRoute;
    if (!useApp && !state.catalogUrl) return;
    var key = useApp ? "app:" + state.codeRoute : "cat:" + relPath;
    if (host.getAttribute("data-key") === key && host.querySelector("iframe")) return;
    host.setAttribute("data-key", key);

    var src, note;
    if (useApp) {
      // Deep-link the real running app to this page's route — the actual page.
      src = state.appUrl.replace(/\/$/, "") + "/#" + state.codeRoute;
      note = "Real app · route " + esc(state.codeRoute) +
        " (the actual page, auth bypassed for preview)";
    } else {
      var cls = classFromPath(relPath);
      src = state.catalogUrl.replace(/\/$/, "") + "/?widget=" + encodeURIComponent(cls);
      note = "Real Flutter render · " + esc(cls) +
        " (component catalog; falls back to index if no entry yet)";
    }
    var frame = document.createElement("iframe");
    frame.className = "preview-frame";
    frame.setAttribute("title", "Live render");
    frame.src = src;
    host.innerHTML = '<div class="preview-note">' + note + '</div>';
    var stage = document.createElement("div");
    stage.className = "preview-stage";
    stage.appendChild(frame);
    host.appendChild(stage);
  }

  function openCode(relPath) {
    var modal = document.getElementById("code-modal");
    var body = document.getElementById("code-body");
    if (!modal || !body) return;
    state.codePath = relPath;
    document.getElementById("code-path").textContent = relPath;
    // Reset to the Source tab each open; show optional tabs when available.
    document.getElementById("tab-preview").hidden = !state.canPreview;
    // Live is available when we can deep-link the real app to this page's route,
    // or when a component catalog is configured.
    var liveAvailable = (state.appUrl && state.codeRoute) || state.catalogUrl;
    document.getElementById("tab-live").hidden = !liveAvailable;
    document.getElementById("code-preview").innerHTML = "";
    document.getElementById("code-live").innerHTML = "";
    document.getElementById("code-live").removeAttribute("data-path");
    showCodeTab("source");
    body.innerHTML = '<div class="code-status">Loading…</div>';
    modal.hidden = false;
    fetch("/source?path=" + encodeURIComponent(relPath)).then(function (r) {
      if (!r.ok) throw new Error("source " + r.status);
      return r.text();
    }).then(function (text) {
      var lines = text.split("\n");
      var rows = "";
      for (var i = 0; i < lines.length; i++) {
        rows += '<div class="code-row"><span class="ln">' + (i + 1) + '</span>' +
          '<code>' + (esc(lines[i]) || "&nbsp;") + '</code></div>';
      }
      body.innerHTML = '<div class="code-lines">' + rows + '</div>';
      body.scrollTop = 0;
    }).catch(function () {
      body.innerHTML = '<div class="code-status">Source unavailable.</div>';
    });
  }

  // Render the AI-generated UI mockup for the current file inside a phone frame.
  // Generation can take ~10-30s, so we show a loading state and cache per path.
  function loadPreview(relPath) {
    var host = document.getElementById("code-preview");
    if (!host || !relPath) return;
    if (host.getAttribute("data-path") === relPath && host.querySelector("iframe")) return; // already loaded
    host.innerHTML = '<div class="code-status">Generating UI mockup with Claude…<br><span class="code-status-sub">reading the widget tree — this can take a moment</span></div>';
    fetch("/preview?path=" + encodeURIComponent(relPath)).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || ("preview " + r.status)); });
      return r.text();
    }).then(function (html) {
      host.setAttribute("data-path", relPath);
      var frame = document.createElement("iframe");
      frame.className = "preview-frame";
      frame.setAttribute("sandbox", ""); // static mockup: no scripts, fully isolated
      frame.setAttribute("title", "UI preview");
      frame.srcdoc = html;
      host.innerHTML = '<div class="preview-note">Approximate mockup generated from the code — not the live app.</div>';
      var stage = document.createElement("div");
      stage.className = "preview-stage";
      stage.appendChild(frame);
      host.appendChild(stage);
    }).catch(function (err) {
      host.removeAttribute("data-path");
      host.innerHTML = '<div class="code-status">Couldn’t generate preview.<br><span class="code-status-sub">' + esc((err && err.message) || "") + '</span></div>';
    });
  }

  // The "Re-run LSP" button: trigger an accurate re-analysis on the server.
  // The resulting graph arrives via the SSE `graph` event (liveReload), so we
  // only manage the button's busy state and a confirmation toast here.
  function setupRefine() {
    var btn = document.getElementById("btn-refine");
    if (!btn) return;
    fetch("/capabilities").then(function (r) { return r.json(); }).then(function (c) {
      if (c && c.refine) btn.hidden = false;
    }).catch(function () { /* no capabilities endpoint → leave hidden */ });

    btn.addEventListener("click", function () {
      if (btn.classList.contains("spinning")) return;
      btn.classList.add("spinning");
      btn.disabled = true;
      toast("Running Dart LSP analysis…");
      fetch("/refine", { method: "POST" }).then(function (r) { return r.json(); }).then(function (res) {
        if (res && res.ok) toast("LSP refine applied · " + (res.uses != null ? res.uses + " uses" : "updated"));
        else if (res && res.reason === "busy") toast("A refine is already running…");
        else toast("LSP unavailable — need the Dart SDK on PATH");
      }).catch(function () {
        toast("Refine failed");
      }).then(function () {
        btn.classList.remove("spinning");
        btn.disabled = false;
      });
    });
  }

  // Drop filter selections that no longer exist after a rebuild.
  function pruneFilters() {
    var pkgs = {}, feats = {};
    state.data.nodes.forEach(function (n) {
      if (n.package) pkgs[n.package] = 1;
      if (n.feature) feats[n.feature] = 1;
    });
    Array.prototype.slice.call(state.activePackages).forEach(function (p) { if (!pkgs[p]) state.activePackages.delete(p); });
    Array.prototype.slice.call(state.activeFeatures).forEach(function (f) { if (!feats[f]) state.activeFeatures.delete(f); });
  }

  function liveReload() {
    loadData().then(function (newData) {
      var cy = state.cy;
      // snapshot positions + camera
      var savedPos = {};
      cy.nodes().forEach(function (n) { var p = n.position(); savedPos[n.id()] = { x: p.x, y: p.y }; });
      var savedZoom = cy.zoom();
      var savedPan = { x: cy.pan().x, y: cy.pan().y };

      state.data = newData;
      renderHeader();
      pruneFilters();
      renderFilters();
      renderInsights();
      renderCoupling();

      var els = buildElements();
      cy.startBatch();
      cy.elements().remove();
      cy.add(els);
      cy.endBatch();

      document.getElementById("empty-state").hidden = cy.nodes('[!isParent]').length > 0;
      var descEl = document.getElementById("view-desc");
      descEl.textContent = state.hiddenIsolated
        ? VIEWS[state.view].desc + " · " + state.hiddenIsolated + " isolated hidden"
        : VIEWS[state.view].desc;

      // Reuse prior positions; only the genuinely new nodes need placing.
      var newNodes = [];
      cy.nodes('[!isParent]').forEach(function (n) {
        var sp = savedPos[n.id()];
        if (sp) n.position(sp); else newNodes.push(n);
      });

      if (newNodes.length) {
        // Topology changed → re-run layout from current positions, then gently
        // fit so the new nodes are actually on-screen.
        var l = cy.layout(Object.assign({}, layoutOptions(), { fit: false, randomize: false, animate: false }));
        l.run();
        cy.animate({ fit: { padding: 60 } }, { duration: 400 });
      } else {
        // Same node set (only edges/labels changed) → keep the camera put.
        cy.zoom(savedZoom);
        cy.pan(savedPan);
      }

      applyEdgeLabels();
      if (state.selectedId && cy.getElementById(state.selectedId).nonempty()) highlightNode(state.selectedId, false);
      else clearHighlight();

      var n = (newData.stats && newData.stats.nodes) || newData.nodes.length;
      toast("Graph updated · " + n + " nodes");
    }).catch(function () { /* transient; the next event will retry */ });
  }

  // ---- Highlight / focus -------------------------------------------------
  function highlightNode(id, openPanel) {
    var cy = state.cy;
    var node = cy.getElementById(id);
    if (node.empty()) return;
    state.selectedId = id;

    cy.elements().addClass("faded");
    var neighborhood = node.closedNeighborhood();
    neighborhood.removeClass("faded").addClass("highlight");
    node.removeClass("highlight").addClass("focus");
    node.connectedEdges().removeClass("faded").addClass("highlight");

    applyEdgeLabels();
    if (openPanel !== false) showDetail(id);
  }

  function clearHighlight() {
    var cy = state.cy;
    cy.elements().removeClass("faded highlight focus");
    applyEdgeLabels();
  }

  function resetSelection() {
    state.selectedId = null;
    var hadFocus = !!state.focusInsight;
    state.focusInsight = null;
    clearInsightActive();
    clearHighlight();
    closeDetail();
    // Pinned isolated nodes (dead page / orphan) must drop back out of view.
    if (hadFocus) render(true);
  }

  // ---- Insights (architecture lint) -------------------------------------
  var SEV_LABEL = { high: "high", medium: "med", low: "low" };

  function renderInsights() {
    var block = document.getElementById("insights-block");
    var panel = document.getElementById("insights-panel");
    if (!block || !panel) return;
    var ins = state.data && state.data.insights;
    if (!ins || !ins.summary || !ins.summary.total) { block.hidden = true; return; }
    block.hidden = false;
    document.getElementById("ins-total").textContent = ins.summary.total;

    var html = ins.categories.map(function (cat) {
      if (!cat.items.length) return "";
      var sev = cat.items[0].severity; // categories are single-severity in practice
      var items = cat.items.slice(0, 200).map(function (it) {
        return '' +
          '<li><button class="ins-item" data-key="' + esc(cat.key) + '" data-id="' + esc(it.id) + '" title="' + esc(it.detail) + '">' +
            '<span class="ins-dot sev-' + esc(it.severity) + '"></span>' +
            '<span class="ins-item-title">' + esc(it.title) + '</span>' +
          '</button></li>';
      }).join("");
      var more = cat.items.length > 200 ? '<li class="ins-more">+' + (cat.items.length - 200) + ' more</li>' : "";
      return '' +
        '<details class="ins-cat" data-key="' + esc(cat.key) + '">' +
          '<summary>' +
            '<span class="ins-dot sev-' + esc(sev) + '"></span>' +
            '<span class="ins-cat-label">' + esc(cat.label) + '</span>' +
            '<span class="ins-count">' + cat.items.length + '</span>' +
          '</summary>' +
          '<p class="ins-desc">' + esc(cat.description) + '</p>' +
          '<ul class="ins-items">' + items + more + '</ul>' +
        '</details>';
    }).join("");
    panel.innerHTML = html;

    Array.prototype.forEach.call(panel.querySelectorAll(".ins-item"), function (el) {
      el.addEventListener("click", function () {
        activateInsight(el.getAttribute("data-key"), el.getAttribute("data-id"));
      });
    });
  }

  function clearInsightActive() {
    Array.prototype.forEach.call(document.querySelectorAll(".ins-item.active"), function (el) {
      el.classList.remove("active");
    });
  }

  function findInsight(catKey, itemId) {
    var ins = state.data && state.data.insights;
    if (!ins) return null;
    for (var i = 0; i < ins.categories.length; i++) {
      var c = ins.categories[i];
      if (c.key !== catKey) continue;
      for (var j = 0; j < c.items.length; j++) if (c.items[j].id === itemId) return { cat: c, item: c.items[j] };
    }
    return null;
  }

  function activateInsight(catKey, itemId) {
    var found = findInsight(catKey, itemId);
    if (!found) return;
    var item = found.item;

    closeDrawer();
    clearInsightActive();
    var btn = document.querySelector('.ins-item[data-key="' + catKey + '"][data-id="' + cssEsc(itemId) + '"]');
    if (btn) {
      btn.classList.add("active");
      var det = btn.closest("details"); if (det) det.open = true;
    }

    state.selectedId = null;
    state.focusInsight = new Set(item.nodes);

    var view = INSIGHT_VIEW[catKey] || state.view;
    if (view !== state.view) switchView(view); else render(true);

    highlightInsightSet(item);
    showInsightDetail(found.cat, item);
  }

  function highlightInsightSet(item) {
    var cy = state.cy;
    if (!cy) return;
    cy.elements().addClass("faded");
    var sel = cy.collection();
    item.nodes.forEach(function (id) { var n = cy.getElementById(id); if (n.nonempty()) sel = sel.union(n); });
    (item.edges || []).forEach(function (id) { var e = cy.getElementById(id); if (e.nonempty()) sel = sel.union(e); });
    if (sel.empty()) {
      cy.elements().removeClass("faded");
      toast("Those nodes are filtered out — clear package/feature filters to see them.");
      return;
    }
    sel.removeClass("faded").addClass("highlight");
    applyEdgeLabels();
    cy.animate({ fit: { eles: sel, padding: 90 } }, { duration: 450 });
  }

  function showInsightDetail(cat, item) {
    var nodeButtons = item.nodes.map(function (id) {
      var rec = nodeRecord(id);
      var label = rec ? rec.label : id;
      var layerColor = cssVar(LAYER_VAR[(rec && rec.layer) || "other"]);
      return '' +
        '<button class="neighbor" data-id="' + esc(id) + '">' +
          '<span class="dot ' + (rec ? rec.kind : "file") + '" style="background:' + layerColor + '"></span>' +
          '<span class="nb-label">' + esc(label) + '</span>' +
        '</button>';
    }).join("");

    var single = item.nodes.length === 1 ? nodeRecord(item.nodes[0]) : null;

    var html = '' +
      '<div class="detail-head">' +
        '<div class="detail-glyph ins sev-' + esc(item.severity) + '">' + insightIcon() + '</div>' +
        '<div>' +
          '<div class="detail-title">' + esc(item.title) + '</div>' +
          '<div class="detail-kind"><span class="ins-badge sev-' + esc(item.severity) + '">' + esc(SEV_LABEL[item.severity] || item.severity) + '</span> ' + esc(cat.label) + '</div>' +
        '</div>' +
        '<button class="close-detail" id="close-detail" title="Close">×</button>' +
      '</div>' +
      '<p class="ins-detail-text">' + esc(item.detail) + '</p>' +
      (single && state.canSource && single.path && single.path.indexOf("(") !== 0
        ? '<button class="code-btn" id="view-code">' +
            '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' +
            '<span>View source</span></button>'
        : '') +
      '<div class="neighbor-group"><h3>Involved <span class="cnt">' + item.nodes.length + '</span></h3>' +
        '<div class="neighbor-list">' + (nodeButtons || '<div class="empty-neighbors">—</div>') + '</div></div>';

    var body = document.getElementById("detail-body");
    body.innerHTML = html;
    body.hidden = false;
    document.getElementById("detail-empty").style.display = "none";
    document.getElementById("detail").classList.remove("empty");
    document.getElementById("main").classList.add("detail-open");

    document.getElementById("close-detail").addEventListener("click", resetSelection);
    var viewCode = document.getElementById("view-code");
    if (viewCode && single) viewCode.addEventListener("click", function () {
      state.codeRoute = single.routePath || null;
      openCode(single.path);
    });
    Array.prototype.forEach.call(body.querySelectorAll(".neighbor"), function (el) {
      el.addEventListener("click", function () {
        var nid = el.getAttribute("data-id");
        highlightNode(nid, true);
        centerOn(nid);
      });
    });
  }

  function insightIcon() {
    return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.3 3.2 1.8 18a1 1 0 0 0 .9 1.5h17a1 1 0 0 0 .9-1.5L12 3.2a1 1 0 0 0-1.7 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
  }

  // CSS.escape shim for querySelector attribute values (ids contain :, /, .).
  function cssEsc(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, function (c) { return "\\" + c; });
  }

  // ---- Coupling dashboard (package instability) -------------------------
  function renderCoupling() {
    var block = document.getElementById("coupling-block");
    var panel = document.getElementById("coupling-panel");
    if (!block || !panel) return;
    var rows = state.data && state.data.coupling;
    if (!rows || !rows.length) { block.hidden = true; return; }
    block.hidden = false;

    panel.innerHTML = rows.map(function (r) {
      var pct = Math.round(r.instability * 100);
      return '' +
        '<button class="cpl-row' + (r.watch ? ' watch' : '') + '" data-pkg="' + esc(r.package) + '" ' +
          'title="Ca ' + r.ca + ' depend on it · Ce ' + r.ce + ' it depends on · Instability ' + r.instability + (r.watch ? ' · watch zone' : '') + '">' +
          '<span class="cpl-name">' + esc(r.package) + (r.watch ? '<span class="cpl-watch">watch</span>' : '') + '</span>' +
          '<span class="cpl-meta">' + r.ca + '↓ ' + r.ce + '↑</span>' +
          '<span class="cpl-bar"><span class="cpl-fill" style="width:' + pct + '%"></span></span>' +
          '<span class="cpl-i">' + r.instability.toFixed(2) + '</span>' +
        '</button>';
    }).join("");

    Array.prototype.forEach.call(panel.querySelectorAll(".cpl-row"), function (el) {
      el.addEventListener("click", function () { highlightPackage(el.getAttribute("data-pkg")); });
    });
  }

  // Light up a whole package + its cross-package import edges in the file view.
  function highlightPackage(pkg) {
    closeDrawer();
    state.focusInsight = null;
    clearInsightActive();
    if (state.view !== "file") switchView("file"); else render(true);
    var cy = state.cy;
    if (!cy) return;
    var sel = cy.nodes('[pkg = "' + pkg + '"]');
    if (sel.empty()) { toast("No nodes for " + pkg + " in this view."); return; }
    cy.elements().addClass("faded");
    var edges = sel.connectedEdges();
    var keep = sel.union(edges).union(edges.connectedNodes());
    keep.removeClass("faded");
    sel.addClass("highlight");
    edges.addClass("highlight");
    applyEdgeLabels();
    state.selectedId = null;
    cy.animate({ fit: { eles: keep, padding: 60 } }, { duration: 450 });
  }

  // ---- Detail panel ------------------------------------------------------
  function nodeRecord(id) {
    return state.data.nodes.filter(function (n) { return n.id === id; })[0];
  }

  function showDetail(id) {
    var n = nodeRecord(id);
    if (!n) return;
    var cy = state.cy;
    var node = cy.getElementById(id);

    // neighbors within current view
    var outgoing = node.outgoers("node").map(function (x) { return x.id(); });
    var incoming = node.incomers("node").map(function (x) { return x.id(); });
    // edge type per neighbor (first match)
    function edgeTypeBetween(a, b) {
      var e = cy.edges('[source = "' + a + '"][target = "' + b + '"]');
      return e.nonempty() ? e[0].data("etype") : "";
    }

    var layerColor = cssVar(LAYER_VAR[n.layer || "other"]);

    var rows = [];
    rows.push(metaRow("Kind", esc(n.kind)));
    rows.push(metaRow("Path", esc(n.path)));
    if (n.package) rows.push(metaRow("Package", esc(n.package)));
    if (n.feature) rows.push(metaRow("Feature", esc(n.feature)));
    if (n.layer) rows.push('<div class="meta-row"><dt>Layer</dt><dd><span class="layer-tag" style="background:' + layerColor + '">' + esc(n.layer) + '</span></dd></div>');
    if (n.routePath) rows.push(metaRow("Route", esc(n.routePath)));

    var html = '' +
      '<div class="detail-head">' +
        '<div class="detail-glyph ' + n.kind + '" style="border-color:' + layerColor + ';color:' + layerColor + '">' +
          (n.kind === "page" ? pageIcon() : fileIcon()) +
        '</div>' +
        '<div>' +
          '<div class="detail-title">' + esc(n.label) + '</div>' +
          '<div class="detail-kind">' + esc(n.kind) + (n.routePath ? ' · ' + esc(n.routePath) : '') + '</div>' +
        '</div>' +
        '<button class="close-detail" id="close-detail" title="Close">×</button>' +
      '</div>' +
      (state.canSource && id.indexOf("svc:") !== 0
        ? '<button class="code-btn" id="view-code">' +
            '<svg viewBox="0 0 24 24"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>' +
            '<span>View source</span></button>'
        : '') +
      '<dl class="meta-grid">' + rows.join("") + '</dl>' +
      neighborGroup("Outgoing", outgoing, id, edgeTypeBetween, true) +
      neighborGroup("Incoming", incoming, id, edgeTypeBetween, false);

    var body = document.getElementById("detail-body");
    body.innerHTML = html;
    body.hidden = false;
    document.getElementById("detail-empty").style.display = "none";
    document.getElementById("detail").classList.remove("empty");
    document.getElementById("main").classList.add("detail-open");

    document.getElementById("close-detail").addEventListener("click", resetSelection);
    var viewCode = document.getElementById("view-code");
    if (viewCode) viewCode.addEventListener("click", function () {
      state.codeRoute = n.routePath || null;
      openCode(n.path);
    });
    Array.prototype.forEach.call(body.querySelectorAll(".neighbor"), function (el) {
      el.addEventListener("click", function () {
        var nid = el.getAttribute("data-id");
        highlightNode(nid, true);
        centerOn(nid);
      });
    });
  }

  function neighborGroup(title, ids, selfId, edgeTypeFn, isOut) {
    var items = ids.map(function (nid) {
      var rec = nodeRecord(nid);
      if (!rec) return "";
      var layerColor = cssVar(LAYER_VAR[rec.layer || "other"]);
      var etype = isOut ? edgeTypeFn(selfId, nid) : edgeTypeFn(nid, selfId);
      return '' +
        '<button class="neighbor" data-id="' + esc(nid) + '">' +
          '<span class="dot ' + rec.kind + '" style="background:' + layerColor + '"></span>' +
          '<span class="nb-label">' + esc(rec.label) + '</span>' +
          (etype ? '<span class="nb-edge">' + esc(etype) + '</span>' : '') +
        '</button>';
    }).join("");
    var body = items || '<div class="empty-neighbors">none in this view</div>';
    return '<div class="neighbor-group"><h3>' + title + ' <span class="cnt">' + ids.length + '</span></h3><div class="neighbor-list">' + body + '</div></div>';
  }

  function metaRow(label, val) {
    return '<div class="meta-row"><dt>' + label + '</dt><dd>' + val + '</dd></div>';
  }
  function pageIcon() { return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18" rx="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/></svg>'; }
  function fileIcon() { return '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/></svg>'; }

  function closeDetail() {
    document.getElementById("detail-body").hidden = true;
    document.getElementById("detail-empty").style.display = "block";
    document.getElementById("detail").classList.add("empty");
    document.getElementById("main").classList.remove("detail-open");
  }

  function centerOn(id) {
    var cy = state.cy;
    var n = cy.getElementById(id);
    if (n.nonempty()) cy.animate({ center: { eles: n }, zoom: Math.max(cy.zoom(), 1.2) }, { duration: 350 });
  }

  // ---- Header / stats ----------------------------------------------------
  function renderHeader() {
    var d = state.data;
    document.getElementById("project-name").textContent = d.projectRoot || "(unknown root)";
    var s = d.stats || {};
    var pills = [
      ["Nodes", s.nodes != null ? s.nodes : d.nodes.length],
      ["Edges", s.edges != null ? s.edges : d.edges.length],
      ["Pages", s.pages != null ? s.pages : d.nodes.filter(function (n) { return n.kind === "page"; }).length],
      ["Pkgs", s.packages != null ? s.packages : d.packages.length]
    ];
    document.getElementById("header-stats").innerHTML = pills.map(function (p) {
      return '<div class="stat-pill"><span class="num">' + p[1] + '</span><span class="lbl">' + p[0] + '</span></div>';
    }).join("");
  }

  // ---- Filters UI --------------------------------------------------------
  function renderFilters() {
    var d = state.data;
    var pkgs = d.packages.map(function (p) { return p.name; });
    // include any package referenced by nodes but missing from list
    d.nodes.forEach(function (n) { if (n.package && pkgs.indexOf(n.package) === -1) pkgs.push(n.package); });

    var feats = [];
    d.nodes.forEach(function (n) { if (n.feature && feats.indexOf(n.feature) === -1) feats.push(n.feature); });

    var pkgWrap = document.getElementById("filter-package");
    pkgWrap.innerHTML = pkgs.map(function (p) {
      var on = state.activePackages.has(p) ? " on" : "";
      return '<button class="chip' + on + '" data-pkg="' + esc(p) + '">' + esc(p) + '</button>';
    }).join("");

    var featWrap = document.getElementById("filter-feature");
    featWrap.innerHTML = feats.length
      ? feats.map(function (f) { var on = state.activeFeatures.has(f) ? " on" : ""; return '<button class="chip' + on + '" data-feat="' + esc(f) + '">' + esc(f) + '</button>'; }).join("")
      : '<span style="font-size:11.5px;color:var(--ink-faint)">no features</span>';

    Array.prototype.forEach.call(pkgWrap.querySelectorAll(".chip"), function (el) {
      el.addEventListener("click", function () {
        var p = el.getAttribute("data-pkg");
        if (state.activePackages.has(p)) { state.activePackages.delete(p); el.classList.remove("on"); }
        else { state.activePackages.add(p); el.classList.add("on"); }
        renderKeepFilters();
        syncUrl();
      });
    });
    Array.prototype.forEach.call(featWrap.querySelectorAll(".chip"), function (el) {
      el.addEventListener("click", function () {
        var f = el.getAttribute("data-feat");
        if (state.activeFeatures.has(f)) { state.activeFeatures.delete(f); el.classList.remove("on"); }
        else { state.activeFeatures.add(f); el.classList.add("on"); }
        renderKeepFilters();
        syncUrl();
      });
    });
  }

  // ---- Search ------------------------------------------------------------
  function setupSearch() {
    var input = document.getElementById("search");
    var box = document.getElementById("search-results");
    var activeIdx = -1;
    var matches = [];

    function close() { box.classList.remove("show"); box.innerHTML = ""; activeIdx = -1; }

    function run() {
      var q = input.value.trim().toLowerCase();
      if (!q) { close(); return; }
      matches = state.data.nodes.filter(function (n) {
        return n.label.toLowerCase().indexOf(q) !== -1 || (n.path && n.path.toLowerCase().indexOf(q) !== -1);
      }).slice(0, 12);
      if (!matches.length) { box.innerHTML = '<div class="sr-item" style="color:var(--ink-faint)">no matches</div>'; box.classList.add("show"); return; }
      box.innerHTML = matches.map(function (n, i) {
        return '<div class="sr-item' + (i === activeIdx ? ' active' : '') + '" data-id="' + esc(n.id) + '">' +
          '<span class="sr-kind">' + esc(n.kind) + '</span>' +
          '<span>' + esc(n.label) + '</span>' +
          '<span class="sr-path">' + esc(n.package || "") + '</span>' +
          '</div>';
      }).join("");
      box.classList.add("show");
      Array.prototype.forEach.call(box.querySelectorAll(".sr-item[data-id]"), function (el) {
        el.addEventListener("click", function () { pick(el.getAttribute("data-id")); });
      });
    }

    function pick(id) {
      close();
      input.value = "";
      var n = nodeRecord(id);
      if (!n) return;
      // ensure node is visible in current view; if not, switch to a view containing it
      ensureVisible(id, n);
      highlightNode(id, true);
      centerOn(id);
    }

    input.addEventListener("input", run);
    input.addEventListener("keydown", function (e) {
      if (!box.classList.contains("show")) return;
      if (e.key === "ArrowDown") { e.preventDefault(); activeIdx = Math.min(activeIdx + 1, matches.length - 1); run(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); run(); }
      else if (e.key === "Enter") { e.preventDefault(); if (matches[activeIdx]) pick(matches[activeIdx].id); else if (matches[0]) pick(matches[0].id); }
      else if (e.key === "Escape") { close(); }
    });
    document.addEventListener("click", function (e) {
      if (!e.target.closest(".search-wrap")) close();
    });
  }

  // If a searched node isn't in the current view, switch to a view that holds it.
  function ensureVisible(id, rec) {
    var cy = state.cy;
    if (cy.getElementById(id).nonempty()) return;
    // pick the first view whose kinds include this node's kind
    var order = ["page", "file", "uses", "api"];
    for (var i = 0; i < order.length; i++) {
      if (VIEWS[order[i]].kinds.indexOf(rec.kind) !== -1) {
        // also clear filters that would hide it
        if (state.activePackages.size && !state.activePackages.has(rec.package)) clearPackageFilters();
        if (state.activeFeatures.size && !state.activeFeatures.has(rec.feature || "")) clearFeatureFilters();
        switchView(order[i]);
        break;
      }
    }
  }
  function clearPackageFilters() {
    state.activePackages.clear();
    Array.prototype.forEach.call(document.querySelectorAll('#filter-package .chip'), function (c) { c.classList.remove("on"); });
  }
  function clearFeatureFilters() {
    state.activeFeatures.clear();
    Array.prototype.forEach.call(document.querySelectorAll('#filter-feature .chip'), function (c) { c.classList.remove("on"); });
  }

  // ---- View switching ----------------------------------------------------
  function switchView(view) {
    state.view = view;
    Array.prototype.forEach.call(document.querySelectorAll(".view-tab"), function (t) {
      t.classList.toggle("active", t.getAttribute("data-view") === view);
    });
    document.getElementById("view-desc").textContent = VIEWS[view].desc;
    render(true);
    syncUrl();
  }

  // ---- Toolbar / toggles -------------------------------------------------
  // Close the responsive sidebar drawer (no-op on desktop where it's docked).
  function closeDrawer() {
    var a = document.getElementById("app");
    if (a) a.classList.remove("sidebar-open");
  }

  function setupControls() {
    // Responsive: hamburger toggles the sidebar drawer; scrim taps close it.
    var sbToggle = document.getElementById("sidebar-toggle");
    if (sbToggle) sbToggle.addEventListener("click", function () {
      document.getElementById("app").classList.toggle("sidebar-open");
    });
    var scrim = document.getElementById("scrim");
    if (scrim) scrim.addEventListener("click", closeDrawer);

    Array.prototype.forEach.call(document.querySelectorAll(".view-tab"), function (t) {
      t.addEventListener("click", function () {
        // Leaving an insight focus: drop pinned nodes + clear the active marker.
        state.focusInsight = null;
        clearInsightActive();
        switchView(t.getAttribute("data-view"));
      });
    });
    document.getElementById("btn-relayout").addEventListener("click", runLayout);
    document.getElementById("btn-fit").addEventListener("click", function () { state.cy.animate({ fit: { padding: 50 } }, { duration: 350 }); });
    document.getElementById("btn-reset").addEventListener("click", resetSelection);

    document.getElementById("toggle-groups").addEventListener("change", function (e) {
      state.groupByPackage = e.target.checked;
      // Grouping is a topology change (compound parents) → full relayout.
      render(true);
      syncUrl();
    });
    document.getElementById("toggle-edgelabels").addEventListener("change", function (e) {
      state.edgeLabels = e.target.checked;
      applyEdgeLabels();
      syncUrl();
    });

    // theme toggle (persisted). Dark is the default; light is opt-in.
    var saved = null;
    try { saved = localStorage.getItem("pm-theme"); } catch (e) {}
    if (saved === "light") document.documentElement.setAttribute("data-theme", "light");
    document.getElementById("theme-toggle").addEventListener("click", function () {
      var light = document.documentElement.getAttribute("data-theme") === "light";
      if (light) document.documentElement.removeAttribute("data-theme");
      else document.documentElement.setAttribute("data-theme", "light");
      try { localStorage.setItem("pm-theme", light ? "dark" : "light"); } catch (e) {}
      // restyle cytoscape with new CSS vars
      state.cy.style(buildStyle());
      applyEdgeLabels();
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 4000);
  }

  // ---- Init --------------------------------------------------------------
  function init() {
    var loader = document.createElement("div");
    loader.id = "loader"; loader.innerHTML = '<div class="spinner"></div>';
    document.body.appendChild(loader);

    loadData().then(function (data) {
      state.data = data;
      // Seed state from the URL hash BEFORE building filters/elements so the
      // first render already reflects the linked view + filters + toggles.
      applyHashToState();
      renderHeader();
      renderFilters();
      renderInsights();
      renderCoupling();
      document.getElementById("view-desc").textContent = VIEWS[state.view].desc;

      // Reflect restored state in the UI controls (view tabs + toggles), which
      // default to page/groups-off/labels-on in the markup.
      Array.prototype.forEach.call(document.querySelectorAll(".view-tab"), function (t) {
        t.classList.toggle("active", t.getAttribute("data-view") === state.view);
      });
      var tg = document.getElementById("toggle-groups");
      if (tg) tg.checked = state.groupByPackage;
      var tl = document.getElementById("toggle-edgelabels");
      if (tl) tl.checked = state.edgeLabels;

      state.cy = window.cytoscape({
        container: document.getElementById("cy"),
        style: buildStyle(),
        minZoom: 0.15,
        maxZoom: 3,
        boxSelectionEnabled: false
      });

      // events
      state.cy.on("tap", "node", function (evt) {
        var n = evt.target;
        if (n.data("isParent")) return;
        highlightNode(n.id(), true);
      });
      state.cy.on("tap", function (evt) {
        if (evt.target === state.cy) resetSelection();
      });
      // hover affordance — light up the node + its neighborhood without committing
      state.cy.on("mouseover", "node", function (evt) {
        var n = evt.target;
        if (n.data("isParent")) return;
        n.addClass("cyhover");
        document.body.style.cursor = "pointer";
      });
      state.cy.on("mouseout", "node", function (evt) {
        evt.target.removeClass("cyhover");
        document.body.style.cursor = "";
      });
      state.cy.on("zoom", debounce(applyEdgeLabels, 120));

      setupControls();
      setupSearch();
      setupExport();
      setupSource();
      window.addEventListener("resize", debounce(fitDeviceFrame, 150));
      // Server-only features: live updates + on-demand refine. A standalone
      // export has no server, so skip them.
      if (!window.__PM_GRAPH__) {
        setupLiveUpdates();
        setupRefine();
      }
      render(true);

      loader.classList.add("hide");
      setTimeout(function () { if (loader.parentNode) loader.remove(); }, 350);
    }).catch(function (err) {
      console.error(err);
      loader.classList.add("hide");
      toast("Failed to load graph data: " + err.message);
    });
  }

  function debounce(fn, ms) {
    var t; return function () { clearTimeout(t); t = setTimeout(fn, ms); };
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
