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
    "nav-depth": "page",
    "hotspot": "file",
    "temporal-coupling": "file",
    "policy-violation": "file",
    "untested-page": "page"
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
    showIsolated: false,
    swimlanes: false,    // arrange nodes into horizontal bands by architectural layer
    swimBands: null,     // [{layer, yTop, yBottom}] for the band-label overlay
    churnOverlay: false, // size + heat-tint file nodes by git churn (hotspots)
    collapsedPackages: new Set(), // packages folded into a single supernode (flat view only)
    layoutCache: {},   // (view|group|iso|focus) -> {nodeId:{x,y}} so view switches don't re-layout
    focusSubgraph: null, // { id, hops } — restrict the graph to a node's k-hop neighborhood
    detailStack: [],     // node ids visited via drill-in, for the detail panel's Back button
    insFilter: "",       // text filter for the Insights panel
    insLimits: {},       // catKey -> how many items are currently shown (pagination)
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
    if (state.showIsolated) parts.push("iso=1");
    if (state.swimlanes) parts.push("swim=1");
    if (state.collapsedPackages.size) parts.push("collapse=" + setToArray(state.collapsedPackages).map(encodeURIComponent).join(","));
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
    if (params.iso === "1") state.showIsolated = true;
    if (params.swim === "1") state.swimlanes = true;
    if (params.collapse) {
      params.collapse.split(",").forEach(function (p) { if (p) state.collapsedPackages.add(decodeURIComponent(p)); });
    }
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

    // 1b. focus subgraph — keep only the focused node + its k-hop neighborhood
    if (state.focusSubgraph) {
      var keepSet = kHopSet(state.focusSubgraph.id, state.focusSubgraph.hops);
      var pruned = new Set();
      visibleNodeIds.forEach(function (id) { if (keepSet[id]) pruned.add(id); });
      visibleNodeIds = pruned;
    }

    // 1c. collapse-to-package: members of a collapsed package fold into one
    //     supernode; their edges reroute to it. Flat view only — grouping
    //     already provides compound parents. When the set is empty everything
    //     below behaves exactly as before (superIdFor is the identity).
    var collapsed = (!state.groupByPackage && state.collapsedPackages.size) ? state.collapsedPackages : null;
    function superIdFor(id) {
      if (!collapsed) return id;
      var nn = nodeById[id];
      return (nn && nn.package && collapsed.has(nn.package)) ? "super::" + nn.package : id;
    }

    // 2. edges of the right type whose endpoints are visible (remapped through
    //    any collapse — intra-package edges become self-loops and drop out,
    //    parallel edges merge with a weight).
    var elEdges = [];
    var edgeByKey = {};
    edges.forEach(function (e) {
      if (view.edges.indexOf(e.type) === -1) return;
      if (!visibleNodeIds.has(e.source) || !visibleNodeIds.has(e.target)) return;
      if (!collapsed) {
        elEdges.push({ data: { id: e.id, source: e.source, target: e.target, etype: e.type, label: e.label || "" } });
        return;
      }
      var s = superIdFor(e.source), t = superIdFor(e.target);
      if (s === t) return;
      var key = s + "|" + t + "|" + e.type;
      if (edgeByKey[key]) { edgeByKey[key].data.weight++; return; }
      var rec = { data: { id: "e::" + key, source: s, target: t, etype: e.type, label: e.label || "", weight: 1 } };
      edgeByKey[key] = rec;
      elEdges.push(rec);
    });

    // 3. only keep nodes that participate (avoid orphan clutter) — but keep
    //    page nodes always in page view so isolated pages still appear.
    var connected = new Set();
    elEdges.forEach(function (e) { connected.add(e.data.source); connected.add(e.data.target); });

    var elNodes = [];
    var parents = {}; // package -> compound node
    var supers = {};  // superId -> tally for collapsed packages
    var hiddenIsolated = 0;
    visibleNodeIds.forEach(function (id) {
      var n = nodeById[id];
      var sid = superIdFor(id);
      if (collapsed && sid !== id) {
        // folded away — tally into its supernode instead of drawing the node
        var sup = supers[sid] || (supers[sid] = { label: n.package, count: 0, layerCount: {} });
        sup.count++;
        var ly = n.layer || "other";
        sup.layerCount[ly] = (sup.layerCount[ly] || 0) + 1;
        return;
      }
      // Only show nodes that participate in an edge of this view. Isolated
      // nodes (e.g. a page never navigated to/from) are clutter and make the
      // layout unreadable, so we drop them and report the count instead.
      // Exception: nodes pinned by an active insight (dead pages / orphan
      // files are isolated by definition — keep them so they can be located).
      var keep = state.showIsolated || connected.has(id) || (state.focusInsight && state.focusInsight.has(id));
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
          churn: n.churn || 0,
          parent: parentId
        }
      });
    });

    // Emit one supernode per collapsed package (always kept — it's intentional).
    Object.keys(supers).forEach(function (sid) {
      var sup = supers[sid], domLayer = "other", best = -1;
      Object.keys(sup.layerCount).forEach(function (l) { if (sup.layerCount[l] > best) { best = sup.layerCount[l]; domLayer = l; } });
      elNodes.push({ data: { id: sid, label: sup.label, kind: "super", isSuper: true, layer: domLayer, pkg: sup.label, feature: "", route: "", parent: null, count: sup.count } });
    });

    state.hiddenIsolated = hiddenIsolated;
    var elParents = Object.keys(parents).map(function (k) { return parents[k]; });
    return elParents.concat(elNodes).concat(elEdges);
  }

  // Stable hue (0-359) from a string — used to tint each package parent.
  function hueFromString(s) {
    var h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
    return h;
  }

  // ---- Cytoscape stylesheet ---------------------------------------------
  function buildStyle() {
    var isLightTheme = document.documentElement.getAttribute("data-theme") === "light";
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
      // compound package parent — per-package tint (hash→hue, low chroma), a
      // solid hairline border, and a label docked top-left as a chip.
      {
        selector: "node[?isParent]",
        style: {
          "label": "data(label)",
          "shape": "round-rectangle",
          "background-color": function (ele) {
            var h = hueFromString(ele.data("label") || "");
            return isLightTheme ? "hsl(" + h + ",42%,95%)" : "hsl(" + h + ",24%,15%)";
          },
          "background-opacity": isLightTheme ? 0.65 : 0.5,
          "border-width": 1,
          "border-color": function (ele) {
            var h = hueFromString(ele.data("label") || "");
            return isLightTheme ? "hsl(" + h + ",38%,72%)" : "hsl(" + h + ",30%,40%)";
          },
          "border-style": "solid",
          "text-valign": "top",
          "text-halign": "left",
          "text-margin-x": 10,
          "text-margin-y": 9,
          "font-size": "10.5px",
          "font-weight": "bold",
          "color": cssVar("--ink-soft"),
          "text-background-color": cssVar("--surface"),
          "text-background-opacity": 0.92,
          "text-background-padding": "3px",
          "text-background-shape": "roundrectangle",
          "padding": 22
        }
      },
      // collapsed package supernode — a tinted rounded box sized by member count
      {
        selector: "node[?isSuper]",
        style: {
          "shape": "round-rectangle",
          "background-color": function (ele) { var h = hueFromString(ele.data("pkg") || ""); return isLightTheme ? "hsl(" + h + ",44%,90%)" : "hsl(" + h + ",26%,22%)"; },
          "background-opacity": 1,
          "border-width": 1.5,
          "border-color": function (ele) { var h = hueFromString(ele.data("pkg") || ""); return isLightTheme ? "hsl(" + h + ",42%,60%)" : "hsl(" + h + ",36%,48%)"; },
          "label": function (ele) { return ele.data("label") + "  ▸ " + ele.data("count"); },
          "color": cssVar("--ink"),
          "font-size": "12px",
          "font-weight": "bold",
          "text-valign": "center",
          "text-halign": "center",
          "text-max-width": "120px",
          "width": function (ele) { return Math.min(140, 46 + Math.sqrt(ele.data("count") || 1) * 9); },
          "height": function (ele) { return Math.min(80, 30 + Math.sqrt(ele.data("count") || 1) * 5); },
          "padding": 6,
          "z-index": 8
        }
      },
      // edges
      {
        selector: "edge",
        style: {
          "width": 1.3,
          "line-color": function (e) { return edgeColor[e.data("etype")] || faint; },
          "line-opacity": 0.7,
          "line-cap": "round",
          "target-arrow-color": function (e) { return edgeColor[e.data("etype")] || faint; },
          "target-arrow-shape": "triangle",
          "arrow-scale": 0.85,
          "curve-style": "bezier",
          "opacity": 0.9,
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
      { selector: "node.lod-hide", style: { "text-opacity": 0 } },
      { selector: "edge.edge-straight", style: { "curve-style": "straight" } },
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

  // Per-(view+group+isolated) layout signature, so switching views restores
  // cached node positions instead of paying a full fcose pass every time.
  function layoutKey() {
    return state.view + "|" + (state.groupByPackage ? "g" : "") + "|" + (state.showIsolated ? "i" : "") +
      "|" + (state.focusSubgraph ? "f:" + state.focusSubgraph.id : "") +
      "|" + (state.collapsedPackages.size ? "c:" + setToArray(state.collapsedPackages).sort().join(",") : "");
  }

  // BFS the k-hop neighborhood of a node over the CURRENT view's edge types
  // (undirected), computed from the full graph data — not the filtered cy
  // instance — so focus works even on nodes the current filter would hide.
  function kHopSet(rootId, hops) {
    var view = VIEWS[state.view];
    var adj = {};
    state.data.edges.forEach(function (e) {
      if (view.edges.indexOf(e.type) === -1) return;
      (adj[e.source] = adj[e.source] || []).push(e.target);
      (adj[e.target] = adj[e.target] || []).push(e.source);
    });
    var seen = {}; seen[rootId] = true;
    var frontier = [rootId];
    for (var h = 0; h < hops; h++) {
      var next = [];
      frontier.forEach(function (id) {
        (adj[id] || []).forEach(function (nb) { if (!seen[nb]) { seen[nb] = true; next.push(nb); } });
      });
      frontier = next;
    }
    return seen;
  }
  function saveLayoutPositions() {
    var cy = state.cy;
    if (!cy) return;
    var pos = {};
    cy.nodes('[!isParent]').forEach(function (n) { var p = n.position(); pos[n.id()] = { x: p.x, y: p.y }; });
    state.layoutCache[layoutKey()] = pos;
  }
  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  }
  // animate=true tweens nodes from their current spots to the freshly-computed
  // layout (smooth, no teleport) for user-initiated reflows — Layout button,
  // group-by toggle — unless the OS asks for reduced motion. Positions are saved
  // on layoutstop so the cache captures the FINAL (post-animation) coordinates.
  function runLayout(animate) {
    if (!state.cy) return;
    var opts = layoutOptions();
    if (animate && !prefersReducedMotion()) {
      opts = Object.assign({}, opts, { animate: true, animationDuration: 650, animationEasing: "ease-in-out", randomize: false });
    }
    var l = state.cy.layout(opts);
    l.one("layoutstop", function () { saveLayoutPositions(); mmRedraw(); });
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
    applyNodeLOD();
    applyEdgeCurves();
  }

  // At low zoom on a dense graph, swap bezier edges for straight lines — beziers
  // overplot into unreadable bands when hundreds of edges overlap. Highlighted
  // edges keep their curve so a traced path still reads as distinct.
  function applyEdgeCurves() {
    var cy = state.cy;
    if (!cy) return;
    var simplify = cy.zoom() < 0.5 && cy.edges().length > 200;
    cy.edges().forEach(function (e) {
      if (simplify && !e.hasClass("highlight")) e.addClass("edge-straight");
      else e.removeClass("edge-straight");
    });
  }

  // Level-of-detail: when zoomed out on a big graph, hide labels except on hub
  // (high-degree) and selected/highlighted nodes — only landmarks stay legible.
  function applyNodeLOD() {
    var cy = state.cy;
    if (!cy) return;
    var nodes = cy.nodes('[!isParent]');
    var thin = cy.zoom() < 0.55 && nodes.length > 120;
    nodes.forEach(function (n) {
      if (thin && (n.data("degree") || 0) < 6 && !n.hasClass("focus") && !n.hasClass("highlight")) n.addClass("lod-hide");
      else n.removeClass("lod-hide");
    });
  }

  // ---- Minimap -----------------------------------------------------------
  // A corner overview: layer-colored dots for every node + a viewport rectangle
  // synced to cy's pan/zoom. Dots are recomputed only when positions change
  // (mmRedraw); the cheap rectangle repaints on every pan/zoom (mmUpdateView).
  var MM = { w: 184, h: 132, pad: 8, bb: null, scale: 1, ox: 0, oy: 0, drag: false, MIN: 28 };

  function mmRedraw() {
    var cy = state.cy;
    var wrap = document.getElementById("minimap");
    var canvas = document.getElementById("minimap-canvas");
    if (!cy || !wrap || !canvas) return;
    var nodes = cy.nodes('[!isParent]');
    if (nodes.length < MM.MIN) { wrap.hidden = true; return; }
    wrap.hidden = false;

    var bb = nodes.boundingBox();
    MM.bb = bb;
    var dpr = window.devicePixelRatio || 1;
    if (canvas.width !== MM.w * dpr) { canvas.width = MM.w * dpr; canvas.height = MM.h * dpr; canvas.style.width = MM.w + "px"; canvas.style.height = MM.h + "px"; }
    var ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, MM.w, MM.h);

    var availW = MM.w - MM.pad * 2, availH = MM.h - MM.pad * 2;
    var s = Math.min(availW / (bb.w || 1), availH / (bb.h || 1));
    MM.scale = s;
    MM.ox = MM.pad + (availW - bb.w * s) / 2;
    MM.oy = MM.pad + (availH - bb.h * s) / 2;

    var lc = {};
    Object.keys(LAYER_VAR).forEach(function (k) { lc[k] = cssVar(LAYER_VAR[k]); });
    nodes.forEach(function (n) {
      var p = n.position();
      var x = MM.ox + (p.x - bb.x1) * s;
      var y = MM.oy + (p.y - bb.y1) * s;
      ctx.fillStyle = lc[n.data("layer")] || lc.other || "#888";
      ctx.beginPath(); ctx.arc(x, y, 1.5, 0, 6.2832); ctx.fill();
    });
    mmUpdateView();
  }

  function mmUpdateView() {
    var cy = state.cy;
    var view = document.getElementById("minimap-view");
    if (!cy || !view || !MM.bb) return;
    var ext = cy.extent();
    var s = MM.scale;
    var left = MM.ox + (ext.x1 - MM.bb.x1) * s;
    var top = MM.oy + (ext.y1 - MM.bb.y1) * s;
    // clamp the rectangle to the minimap box so it never spills out at high zoom
    var l = Math.max(0, Math.min(left, MM.w));
    var t = Math.max(0, Math.min(top, MM.h));
    var w = Math.min(ext.w * s, MM.w - l);
    var h = Math.min(ext.h * s, MM.h - t);
    view.style.left = l + "px"; view.style.top = t + "px";
    view.style.width = Math.max(6, w) + "px"; view.style.height = Math.max(6, h) + "px";
  }

  function mmPanTo(clientX, clientY) {
    var cy = state.cy;
    var canvas = document.getElementById("minimap-canvas");
    if (!cy || !MM.bb) return;
    var r = canvas.getBoundingClientRect();
    var modelX = MM.bb.x1 + ((clientX - r.left) - MM.ox) / MM.scale;
    var modelY = MM.bb.y1 + ((clientY - r.top) - MM.oy) / MM.scale;
    var z = cy.zoom();
    cy.pan({ x: cy.width() / 2 - modelX * z, y: cy.height() / 2 - modelY * z });
  }

  function setupMinimap() {
    var wrap = document.getElementById("minimap");
    if (!wrap || !state.cy) return;
    wrap.addEventListener("mousedown", function (e) { MM.drag = true; mmPanTo(e.clientX, e.clientY); e.preventDefault(); });
    window.addEventListener("mousemove", function (e) { if (MM.drag) mmPanTo(e.clientX, e.clientY); });
    window.addEventListener("mouseup", function () { MM.drag = false; });
    // mmUpdateView is just a few style writes — cheap enough to run on every
    // pan/zoom directly (rAF throttling silently stalls in a backgrounded tab).
    state.cy.on("pan zoom", function () { mmUpdateView(); positionSwimLabels(); });
  }

  // ---- Layer swimlanes ---------------------------------------------------
  // Arrange nodes into horizontal bands by architectural layer (presentation on
  // top → other at the bottom), so any edge pointing UP is a visible back-flow
  // (e.g. a domain file importing presentation). Deterministic positioner: keep
  // each node's X (preserves the fcose horizontal clustering) and pack each
  // layer's nodes into rows within its band.
  var LAYER_ORDER = ["presentation", "domain", "data", "other"];

  function applySwimlanes() {
    var cy = state.cy;
    if (!cy) return;
    var nodes = cy.nodes('[!isParent]');
    if (!nodes.length) { renderSwimLabels(); return; }

    var xs = nodes.map(function (n) { return n.position("x"); });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var spanX = maxX - minX;
    if (!isFinite(spanX) || spanX < 50) { minX = 0; spanX = Math.max(nodes.length * 14, 600); }

    var byLayer = {};
    LAYER_ORDER.forEach(function (l) { byLayer[l] = []; });
    nodes.forEach(function (n) {
      var l = LAYER_ORDER.indexOf(n.data("layer")) >= 0 ? n.data("layer") : "other";
      byLayer[l].push(n);
    });

    var rowGap = 46, bandGap = 96, y = 0, bands = [];
    cy.startBatch();
    LAYER_ORDER.forEach(function (l) {
      var band = byLayer[l];
      if (!band.length) return;
      band.sort(function (a, b) { return a.position("x") - b.position("x"); });
      var perRow = Math.max(1, Math.round(Math.sqrt(band.length) * 1.8));
      var rows = Math.ceil(band.length / perRow);
      band.forEach(function (n, i) {
        var col = i % perRow, row = Math.floor(i / perRow);
        var fx = perRow > 1 ? col / (perRow - 1) : 0.5;
        n.position({ x: minX + fx * spanX, y: y + row * rowGap });
      });
      var bandH = Math.max(rows - 1, 0) * rowGap;
      bands.push({ layer: l, yTop: y, yBottom: y + bandH, yMid: y + bandH / 2 });
      y += bandH + bandGap;
    });
    cy.endBatch();
    state.swimBands = bands;
    cy.fit(null, 70);
    renderSwimLabels();
  }

  function renderSwimLabels() {
    var host = document.getElementById("swimlane-labels");
    if (!host) return;
    if (!state.swimlanes || !state.swimBands || !state.swimBands.length) { host.hidden = true; host.innerHTML = ""; return; }
    host.hidden = false;
    host.innerHTML = state.swimBands.map(function (b) {
      return '<div class="swim-label" data-y="' + b.yMid + '">' +
        '<span class="swim-dot" data-layer="' + esc(b.layer) + '"></span>' + esc(b.layer) + '</div>';
    }).join("");
    positionSwimLabels();
  }

  function positionSwimLabels() {
    var host = document.getElementById("swimlane-labels");
    var cy = state.cy;
    if (!host || host.hidden || !cy) return;
    var pan = cy.pan(), z = cy.zoom();
    Array.prototype.forEach.call(host.querySelectorAll(".swim-label"), function (el) {
      var my = parseFloat(el.getAttribute("data-y"));
      el.style.top = (my * z + pan.y) + "px";
    });
  }

  // ---- Help / onboarding -------------------------------------------------
  function setupHelp() {
    var modal = document.getElementById("help-modal");
    var btn = document.getElementById("help-toggle");
    if (!modal || !btn) return;
    function open() { modal.hidden = false; }
    function hide() { modal.hidden = true; }
    btn.addEventListener("click", open);
    var close = document.getElementById("help-close");
    if (close) close.addEventListener("click", hide);
    modal.addEventListener("click", function (e) { if (e.target === modal) hide(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && !modal.hidden) hide(); });
    // First run: show the guide once (same persisted-flag pattern as the theme).
    var seen = null;
    try { seen = localStorage.getItem("pm-help-seen"); } catch (e) {}
    if (!seen) {
      open();
      try { localStorage.setItem("pm-help-seen", "1"); } catch (e) {}
    }
  }

  // ---- Render the graph for current state -------------------------------
  // Show the "no nodes" overlay; when filtering or hiding caused it, offer
  // recovery actions (clear filters / reveal isolated nodes) instead of a dead end.
  function renderEmptyState() {
    var el = document.getElementById("empty-state");
    var cy = state.cy;
    var empty = !!cy && cy.nodes('[!isParent]').length === 0;
    el.hidden = !empty;
    if (!empty) return;
    var btns = "";
    if (state.activePackages.size || state.activeFeatures.size) btns += '<button class="es-btn" data-act="clear">Clear filters</button>';
    if (state.hiddenIsolated > 0 && !state.showIsolated) btns += '<button class="es-btn" data-act="iso">Show isolated nodes</button>';
    el.innerHTML = '<div class="es-inner"><p>No nodes match this view &amp; filter combination.</p>' +
      (btns ? '<div class="es-actions">' + btns + '</div>' : '') + '</div>';
    var c = el.querySelector('[data-act="clear"]');
    if (c) c.addEventListener("click", function () { clearPackageFilters(); clearFeatureFilters(); renderKeepFilters(); syncUrl(); });
    var iso = el.querySelector('[data-act="iso"]');
    if (iso) iso.addEventListener("click", function () {
      state.showIsolated = true;
      var t = document.getElementById("toggle-isolated"); if (t) t.checked = true;
      render(true); syncUrl();
    });
  }

  // Scale file nodes by connection count so hubs read bigger than leaves.
  // Recomputed per render (each view drops isolated nodes, changing degree).
  // sqrt keeps a few mega-hubs from dwarfing everything; pages keep a fixed size.
  function sizeNodesByDegree() {
    var cy = state.cy;
    if (!cy) return;
    var files = cy.nodes('[kind = "file"]');
    var maxDeg = 1;
    files.forEach(function (n) { var d = n.degree(false); if (d > maxDeg) maxDeg = d; });
    files.forEach(function (n) {
      var d = n.degree(false);
      n.data("degree", d);
      var sz = 24 + Math.round((58 - 24) * Math.sqrt(d / maxDeg));
      n.style({ width: sz, height: sz, "underlay-color": "", "underlay-opacity": "", "border-color": "", "border-opacity": "" });
    });
  }

  // True when the loaded graph carries git churn (the hotspot overlay is usable).
  function hasChurn() {
    return !!(state.data && state.data.nodes && state.data.nodes.some(function (n) { return n.churn; }));
  }

  // Size + heat-tint file nodes by git churn: bigger + redder = changed more
  // often. Pairs with the "Hotspots" insight (churn × coupling).
  function sizeNodesByChurn() {
    var cy = state.cy;
    if (!cy) return;
    var files = cy.nodes('[kind = "file"]');
    var maxCh = 1;
    files.forEach(function (n) { var c = n.data("churn") || 0; if (c > maxCh) maxCh = c; });
    files.forEach(function (n) {
      // Keep degree data fresh so applyNodeLOD's label logic still works in churn mode.
      n.data("degree", n.degree(false));
      var c = n.data("churn") || 0;
      if (c > 0) {
        var t = c / maxCh; // 0..1
        var sz = 22 + Math.round((62 - 22) * Math.sqrt(t));
        n.style({
          width: sz, height: sz,
          "underlay-color": "#ff6b35",
          "underlay-opacity": 0.10 + 0.4 * t,
          "border-color": "#ff6b35",
          "border-opacity": 0.45 + 0.5 * t
        });
      } else {
        // No churn → small + muted so hotspots stand out (clear any prior tint).
        n.style({ width: 20, height: 20, "underlay-color": "", "underlay-opacity": 0.04, "border-color": "", "border-opacity": 0.4 });
      }
    });
  }

  // Dispatch node sizing: churn overlay when on + available, else by degree.
  function sizeNodes() {
    if (state.churnOverlay && hasChurn()) sizeNodesByChurn();
    else sizeNodesByDegree();
  }

  function render(relayout, animateLayout) {
    var els = buildElements();
    var cy = state.cy;
    cy.startBatch();
    cy.elements().remove();
    cy.add(els);
    cy.endBatch();
    sizeNodes();

    renderEmptyState();
    renderActiveFilters();

    // Append a "(N isolated hidden)" note to the view description.
    var descEl = document.getElementById("view-desc");
    var base = VIEWS[state.view].desc;
    descEl.textContent = state.hiddenIsolated
      ? base + " · " + state.hiddenIsolated + " isolated hidden"
      : base;

    if (relayout !== false) {
      if (state.swimlanes) {
        // Need a base layout for X clustering, then band by layer. Use the cached
        // normal layout if present (sync); otherwise a one-off sync fcose. The
        // banded positions are NOT cached, so toggling swimlanes off restores
        // the normal layout untouched.
        var baseCached = state.layoutCache[layoutKey()];
        if (baseCached) {
          cy.nodes('[!isParent]').forEach(function (n) { var p = baseCached[n.id()]; if (p) n.position(p); });
        } else {
          var bl = cy.layout(Object.assign({}, layoutOptions(), { fit: false, animate: false }));
          bl.run();
          saveLayoutPositions();
        }
        applySwimlanes();
      } else {
        var cached = state.layoutCache[layoutKey()];
        if (cached) {
          // Restore the prior layout for this view; only place genuinely-new nodes.
          var missing = [];
          cy.nodes('[!isParent]').forEach(function (n) {
            var p = cached[n.id()];
            if (p) n.position(p); else missing.push(n);
          });
          if (missing.length) {
            var inc = cy.layout(Object.assign({}, layoutOptions(), { fit: false, randomize: false, animate: false }));
            inc.run();
          }
          cy.fit(null, 50);
          saveLayoutPositions();
        } else {
          runLayout(animateLayout);
        }
      }
    }
    applyEdgeLabels();

    // restore selection highlight if still present
    if (state.selectedId && cy.getElementById(state.selectedId).nonempty()) {
      highlightNode(state.selectedId, false);
    } else {
      clearHighlight();
    }
    mmRedraw();
    if (!state.swimlanes) renderSwimLabels(); // hide stale band labels when off
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
    sizeNodes();

    renderEmptyState();
    renderActiveFilters();
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
    mmRedraw();
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

    // Copy path / source to the clipboard, with toast feedback.
    function copyToClipboard(text, label) {
      if (!text) { toast("Nothing to copy"); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(
          function () { toast(label + " copied"); },
          function () { toast("Copy blocked by the browser"); }
        );
      } else {
        toast("Clipboard unavailable");
      }
    }
    var copyPath = document.getElementById("copy-path");
    if (copyPath) copyPath.addEventListener("click", function () { copyToClipboard(state.codePath, "Path"); });
    var copySource = document.getElementById("copy-source");
    if (copySource) copySource.addEventListener("click", function () { copyToClipboard(state.codeSource, "Source"); });

    // Arrow-key navigation across the (visible) Source / Preview / Live tabs.
    var tabsWrap = document.getElementById("code-tabs");
    if (tabsWrap) tabsWrap.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      var tabs = Array.prototype.filter.call(tabsWrap.querySelectorAll(".code-tab"), function (t) { return !t.hidden; });
      var idx = tabs.indexOf(document.activeElement);
      if (idx === -1) return;
      e.preventDefault();
      var next = e.key === "ArrowRight" ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
      tabs[next].focus();
      tabs[next].click(); // reuse the existing tab handler → showCodeTab
    });
  }

  function closeCode() {
    cancelPreview();
    if (state.liveTimer) { clearTimeout(state.liveTimer); state.liveTimer = null; }
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
    if (tab !== "preview") cancelPreview(); // don't keep generating for a hidden tab
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
    var overlay = document.createElement("div");
    overlay.className = "live-loading";
    overlay.innerHTML = '<div class="spinner"></div><div class="code-status-sub">loading the real app…</div>';
    stage.appendChild(frame);
    stage.appendChild(overlay);
    host.appendChild(stage);

    var done = false;
    frame.addEventListener("load", function () {
      done = true;
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      requestAnimationFrame(fitDeviceFrame);
    });
    // If the iframe is slow (waking server / behind a login), offer a Retry
    // without tearing down the frame in case it's just about to paint.
    if (state.liveTimer) clearTimeout(state.liveTimer);
    state.liveTimer = setTimeout(function () {
      if (done || !overlay.parentNode) return;
      overlay.innerHTML =
        '<div class="code-status-sub">Still loading — the app may be waking up or behind a login.</div>' +
        '<button class="gen-btn" id="live-retry">Retry</button>';
      var r = document.getElementById("live-retry");
      if (r) r.addEventListener("click", function () { host.removeAttribute("data-key"); loadLive(relPath); });
    }, 12000);
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
      state.codeSource = text; // kept so "Copy source" works without re-fetching
      var lines = text.split("\n");
      var rows = "";
      for (var i = 0; i < lines.length; i++) {
        rows += '<div class="code-row"><span class="ln">' + (i + 1) + '</span>' +
          '<code>' + (esc(lines[i]) || "&nbsp;") + '</code></div>';
      }
      body.innerHTML = '<div class="code-lines">' + rows + '</div>';
      body.scrollTop = 0;
    }).catch(function () {
      state.codeSource = "";
      body.innerHTML = '<div class="code-status">Source unavailable.</div>';
    });
  }

  // Render the AI-generated UI mockup for the current file inside a phone frame.
  // Generation can take ~10-30s, so we show a loading state and cache per path.
  function cancelPreview() {
    if (state.previewAbort) { try { state.previewAbort.abort(); } catch (e) {} state.previewAbort = null; }
    if (state.previewTimer) { clearInterval(state.previewTimer); state.previewTimer = null; }
  }

  function loadPreview(relPath) {
    var host = document.getElementById("code-preview");
    if (!host || !relPath) return;
    if (host.getAttribute("data-path") === relPath && host.querySelector("iframe")) return; // already loaded

    cancelPreview(); // drop any in-flight generation before starting a new one
    var controller = (typeof AbortController !== "undefined") ? new AbortController() : null;
    state.previewAbort = controller;

    var t0 = Date.now();
    host.innerHTML =
      '<div class="code-status gen">' +
        '<div class="gen-bar"><span></span></div>' +
        '<div class="gen-msg">Generating UI mockup with Claude…</div>' +
        '<div class="code-status-sub">reading the widget tree · <span id="gen-elapsed">0s</span></div>' +
        '<button class="gen-btn" id="gen-cancel">Cancel</button>' +
      '</div>';
    state.previewTimer = setInterval(function () {
      var el = document.getElementById("gen-elapsed");
      if (el) el.textContent = Math.round((Date.now() - t0) / 1000) + "s";
    }, 500);
    var cancelBtn = document.getElementById("gen-cancel");
    if (cancelBtn) cancelBtn.addEventListener("click", cancelPreview);

    function showError(msg, cancelled) {
      if (state.previewTimer) { clearInterval(state.previewTimer); state.previewTimer = null; }
      host.removeAttribute("data-path");
      host.innerHTML =
        '<div class="code-status">' + (cancelled ? "Preview cancelled." : "Couldn’t generate preview.") +
          (msg ? '<br><span class="code-status-sub">' + esc(msg) + '</span>' : "") +
          '<br><button class="gen-btn" id="gen-retry">Retry</button>' +
        '</div>';
      var r = document.getElementById("gen-retry");
      if (r) r.addEventListener("click", function () { loadPreview(relPath); });
    }

    fetch("/preview?path=" + encodeURIComponent(relPath), controller ? { signal: controller.signal } : {}).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error(t || ("preview " + r.status)); });
      return r.text();
    }).then(function (html) {
      if (state.previewTimer) { clearInterval(state.previewTimer); state.previewTimer = null; }
      state.previewAbort = null;
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
      requestAnimationFrame(fitDeviceFrame); setTimeout(fitDeviceFrame, 320);
    }).catch(function (err) {
      if (err && err.name === "AbortError") { showError("", true); return; }
      showError((err && err.message) || "", false);
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
      state.layoutCache = {};   // graph changed → stale cached positions
      // snapshot positions + camera
      var savedPos = {};
      cy.nodes().forEach(function (n) { var p = n.position(); savedPos[n.id()] = { x: p.x, y: p.y }; });
      var savedZoom = cy.zoom();
      var savedPan = { x: cy.pan().x, y: cy.pan().y };

      state.data = newData;
      state._impAdj = null;     // import adjacency cache — graph changed
      state._nodeById = null;   // node lookup cache — graph changed
      state._pageFiles = null;  // page-declaring-file cache — graph changed
      renderHeader();
      pruneFilters();
      renderFilters();
      renderInsights();
      renderCoupling();
      // Git churn may appear after a background LSP refine — reveal the toggle.
      var churnRowLR = document.getElementById("churn-row");
      if (churnRowLR) churnRowLR.hidden = !hasChurn();

      var els = buildElements();
      cy.startBatch();
      cy.elements().remove();
      cy.add(els);
      cy.endBatch();
      sizeNodes();

      renderEmptyState();
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
      mmRedraw();

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
    if (openPanel !== false) {
      showDetail(id);
      var rec = nodeRecord(id);
      if (rec) announce("Selected " + rec.label + ", " + rec.kind + ", " + (node.degree(false)) + " connections");
    }
  }

  function clearHighlight() {
    var cy = state.cy;
    cy.elements().removeClass("faded highlight focus");
    applyEdgeLabels();
  }

  function resetSelection() {
    state.selectedId = null;
    state.detailStack = [];
    var hadFocus = !!state.focusInsight || !!state.focusSubgraph;
    state.focusInsight = null;
    state.focusSubgraph = null;
    clearInsightActive();
    clearHighlight();
    closeDetail();
    // Pinned isolated nodes (dead page / orphan) and focus subgraphs must drop back out of view.
    if (hadFocus) render(true);
  }

  // ---- Insights (architecture lint) -------------------------------------
  var SEV_LABEL = { high: "high", medium: "med", low: "low" };

  var INS_PAGE = 200; // how many items a category shows per "Show more" step

  function renderInsights() {
    var block = document.getElementById("insights-block");
    var panel = document.getElementById("insights-panel");
    if (!block || !panel) return;
    var ins = state.data && state.data.insights;
    if (!ins || !ins.summary || !ins.summary.total) { block.hidden = true; return; }
    block.hidden = false;
    document.getElementById("ins-total").textContent = ins.summary.total;

    // The filter input lives in the persistent block head (not re-rendered), so
    // bind its handler once and keep focus across category re-renders.
    var filterInput = document.getElementById("ins-filter");
    if (filterInput) {
      filterInput.hidden = false;
      if (!filterInput.dataset.bound) {
        filterInput.dataset.bound = "1";
        filterInput.addEventListener("input", function () {
          state.insFilter = filterInput.value.trim().toLowerCase();
          renderInsightCategories();
        });
      }
    }
    renderInsightCategories();
  }

  // Builds only the category list — called on first render, on filter keystroke,
  // and on "Show more". Preserves which categories are open across rebuilds.
  function renderInsightCategories() {
    var panel = document.getElementById("insights-panel");
    var ins = state.data && state.data.insights;
    if (!panel || !ins) return;
    var q = state.insFilter;

    var openKeys = {};
    Array.prototype.forEach.call(panel.querySelectorAll("details.ins-cat[open]"), function (d) {
      openKeys[d.getAttribute("data-key")] = true;
    });

    function matchItem(it) {
      return (it.title && it.title.toLowerCase().indexOf(q) !== -1) ||
             (it.detail && it.detail.toLowerCase().indexOf(q) !== -1);
    }

    var html = ins.categories.map(function (cat) {
      if (!cat.items.length) return "";
      var matches = q ? cat.items.filter(matchItem) : cat.items;
      if (!matches.length) return "";
      var sev = cat.items[0].severity; // categories are single-severity in practice
      var limit = state.insLimits[cat.key] || INS_PAGE;
      var shown = matches.slice(0, limit);
      var items = shown.map(function (it) {
        return '' +
          '<li><button class="ins-item" data-key="' + esc(cat.key) + '" data-id="' + esc(it.id) + '" title="' + esc(it.detail) + '">' +
            '<span class="ins-dot sev-' + esc(it.severity) + '"></span>' +
            '<span class="ins-item-title">' + esc(it.title) + '</span>' +
          '</button></li>';
      }).join("");
      var remaining = matches.length - shown.length;
      var more = remaining > 0
        ? '<li class="ins-more"><button class="ins-more-btn" data-key="' + esc(cat.key) + '">' +
            'Show ' + Math.min(INS_PAGE, remaining) + ' more · ' + remaining + ' hidden</button></li>'
        : "";
      var isOpen = q ? true : !!openKeys[cat.key]; // auto-open matching cats while filtering
      var countLabel = q ? matches.length + " / " + cat.items.length : String(cat.items.length);
      return '' +
        '<details class="ins-cat"' + (isOpen ? " open" : "") + ' data-key="' + esc(cat.key) + '">' +
          '<summary>' +
            '<span class="ins-dot sev-' + esc(sev) + '"></span>' +
            '<span class="ins-cat-label">' + esc(cat.label) + '</span>' +
            '<span class="ins-count">' + countLabel + '</span>' +
          '</summary>' +
          '<p class="ins-desc">' + esc(cat.description) + '</p>' +
          '<ul class="ins-items">' + items + more + '</ul>' +
        '</details>';
    }).join("");

    panel.innerHTML = html || '<p class="ins-empty">No insights match &ldquo;' + esc(state.insFilter) + '&rdquo;.</p>';

    Array.prototype.forEach.call(panel.querySelectorAll(".ins-item"), function (el) {
      el.addEventListener("click", function () {
        activateInsight(el.getAttribute("data-key"), el.getAttribute("data-id"));
      });
    });
    Array.prototype.forEach.call(panel.querySelectorAll(".ins-more-btn"), function (el) {
      el.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        var k = el.getAttribute("data-key");
        state.insLimits[k] = (state.insLimits[k] || INS_PAGE) + INS_PAGE;
        renderInsightCategories();
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
      btn.scrollIntoView({ block: "nearest" }); // keep the activated item visible in a long list
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
        state.detailStack = []; // entering node detail from an insight is a fresh start
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

    // Impact / blast radius over the full import graph. For a page node, the
    // code lives in its declaring file, so measure impact on that file id.
    var impactId = (n.kind === "page") ? n.path : id;
    var imp = (id.indexOf("svc:") !== 0) ? computeImpact(impactId) : null;

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
    if (n.layer) rows.push('<div class="meta-row"><dt>Layer</dt><dd><span class="layer-tag" style="background:color-mix(in srgb,' + layerColor + ' 20%,transparent);color:' + layerColor + ';border:1px solid color-mix(in srgb,' + layerColor + ' 45%,transparent)">' + esc(n.layer) + '</span></dd></div>');
    if (n.routePath) rows.push(metaRow("Route", esc(n.routePath)));

    var backId = state.detailStack.length ? state.detailStack[state.detailStack.length - 1] : null;
    var backRec = backId ? nodeRecord(backId) : null;
    var html = '' +
      (backRec
        ? '<button class="detail-back" id="detail-back" title="Back to ' + esc(backRec.label) + '">' +
            '<svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg>' +
            '<span>' + esc(backRec.label) + '</span></button>'
        : '') +
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
      (id.indexOf("svc:") !== 0
        ? '<div class="trace-row">' +
            '<button class="trace-btn" data-dir="up" title="Highlight everything that depends on this — within the current view">&uarr; Dependents</button>' +
            '<button class="trace-btn" data-dir="down" title="Highlight everything this depends on — within the current view">&darr; Dependencies</button>' +
          '</div>' +
          '<button class="trace-focus" id="focus-sub" title="Rebuild the graph with only this node and its 2-hop neighborhood">&#9678; Focus subgraph (2-hop)</button>' +
          (n.package && !state.groupByPackage
            ? '<button class="trace-focus" id="collapse-pkg" title="Fold every file in this package into a single supernode (click the supernode to expand)">&#9776; Collapse package &ldquo;' + esc(n.package) + '&rdquo;</button>'
            : '') +
          '<div class="trace-hint">Shift-click another node for the shortest path · ' +
            (state.focusSubgraph ? '<b>Focused</b> — press Clear to exit.' : 'Focus isolates a node’s neighborhood.') + '</div>'
        : '') +
      (imp
        ? '<div class="impact-box">' +
            '<div class="impact-head">Impact · blast radius</div>' +
            '<div class="impact-grid">' +
              '<div class="impact-cell hot"><span class="impact-num">' + imp.dependents.length + '</span><span class="impact-lbl">dependents</span></div>' +
              '<div class="impact-cell"><span class="impact-num">' + imp.dependencies.length + '</span><span class="impact-lbl">depends on</span></div>' +
              '<div class="impact-cell"><span class="impact-num">' + imp.features + '</span><span class="impact-lbl">features hit</span></div>' +
              '<div class="impact-cell"><span class="impact-num">' + imp.pages + '</span><span class="impact-lbl">pages hit</span></div>' +
            '</div>' +
            '<div class="impact-sub">transitive over the full import graph · ' + imp.direct + ' direct dependent' + (imp.direct === 1 ? '' : 's') + '</div>' +
            (imp.dependents.length ? '<button class="impact-btn" id="impact-hl">Highlight blast radius</button>' : '') +
          '</div>'
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
        state.detailStack.push(id); // remember where we drilled from
        highlightNode(nid, true);
        centerOn(nid);
      });
    });
    var backBtn = document.getElementById("detail-back");
    if (backBtn) backBtn.addEventListener("click", function () {
      var prev = state.detailStack.pop();
      if (prev == null) return;
      highlightNode(prev, true); // re-renders the panel; stack is now one shorter
      centerOn(prev);
    });
    Array.prototype.forEach.call(body.querySelectorAll(".trace-btn"), function (el) {
      el.addEventListener("click", function () { tracePath(id, el.getAttribute("data-dir")); });
    });
    var impactBtn = document.getElementById("impact-hl");
    // Recompute on click (not the captured `imp`) so it's correct even after a
    // live-reload rebuilt the graph while this panel stayed open.
    if (impactBtn) impactBtn.addEventListener("click", function () {
      highlightBlastRadius(impactId, computeImpact(impactId).dependents);
    });
    var focusBtn = document.getElementById("focus-sub");
    if (focusBtn) focusBtn.addEventListener("click", function () {
      state.focusSubgraph = { id: id, hops: 2 };
      render(true);
      var cy2 = state.cy; if (cy2) { highlightNode(id, false); cy2.fit(null, 60); }
      showDetail(id); // refresh the panel so the hint shows "Focused — Clear to exit"
    });
    var collapseBtn = document.getElementById("collapse-pkg");
    if (collapseBtn) collapseBtn.addEventListener("click", function () {
      state.collapsedPackages.add(n.package);
      state.selectedId = null;
      closeDetail();
      render(true, true);
      syncUrl();
      announce("Collapsed package " + n.package + " · click the supernode to expand");
    });
  }

  // ---- Impact / blast radius (full import graph, ignores view & filters) ----
  // Forward + reverse import adjacency over the WHOLE graph, cached. Unlike the
  // in-view "Dependents/Dependencies" trace, this answers the real question:
  // "if I change this file, everything that could be affected — across all
  // features/pages — regardless of what's currently on screen."
  function importAdjacency() {
    if (state._impAdj) return state._impAdj;
    var fwd = {}, rev = {};
    (state.data.edges || []).forEach(function (e) {
      if (e.type !== "import") return;
      (fwd[e.source] || (fwd[e.source] = [])).push(e.target);
      (rev[e.target] || (rev[e.target] = [])).push(e.source);
    });
    state._impAdj = { fwd: fwd, rev: rev };
    return state._impAdj;
  }

  function nodeByIdMap() {
    if (state._nodeById) return state._nodeById;
    var m = {};
    state.data.nodes.forEach(function (n) { m[n.id] = n; });
    state._nodeById = m;
    return m;
  }

  // BFS transitive closure from startId over the given adjacency (excludes self).
  function importClosure(startId, adj) {
    var seen = {}, queue = [startId], head = 0;
    while (head < queue.length) {
      var v = queue[head++];
      var ns = adj[v] || [];
      for (var i = 0; i < ns.length; i++) {
        var w = ns[i];
        if (!seen[w] && w !== startId) { seen[w] = true; queue.push(w); }
      }
    }
    return Object.keys(seen);
  }

  // Files that declare a page (import edges target files, not page nodes, so to
  // count "pages affected" we look for dependents that are page-declaring files).
  function pageFileSet() {
    if (state._pageFiles) return state._pageFiles;
    var s = {};
    // Count pages per declaring file — one file can declare several page classes.
    state.data.nodes.forEach(function (n) { if (n.kind === "page" && n.path) s[n.path] = (s[n.path] || 0) + 1; });
    state._pageFiles = s;
    return s;
  }

  function computeImpact(id) {
    var adj = importAdjacency();
    var dependents = importClosure(id, adj.rev);   // who transitively imports id
    var dependencies = importClosure(id, adj.fwd); // what id transitively imports
    var direct = (adj.rev[id] || []).filter(function (x) { return x !== id; }).length;
    var byId = nodeByIdMap();
    var pf = pageFileSet();
    var feats = {}, pages = 0;
    dependents.forEach(function (nid) {
      var nn = byId[nid];
      if (nn && nn.feature) feats[nn.feature] = 1;
      if (pf[nid]) pages += pf[nid]; // pages declared by this dependent file
    });
    return {
      dependents: dependents, dependencies: dependencies,
      direct: direct, features: Object.keys(feats).length, pages: pages
    };
  }

  // Light up a node + its full reverse-import closure (the blast radius) in the
  // File Dependency view, regardless of current filters.
  function highlightBlastRadius(id, dependents) {
    closeDrawer();
    state.focusInsight = null;
    clearInsightActive();
    if (state.view !== "file") switchView("file"); else render(true);
    var cy = state.cy;
    if (!cy) return;
    var sel = cy.collection();
    var self = cy.getElementById(id);
    if (self.nonempty()) sel = sel.union(self);
    dependents.forEach(function (nid) { var nn = cy.getElementById(nid); if (nn.nonempty()) sel = sel.union(nn); });
    if (!dependents.length) { toast("Nothing depends on this file."); return; }
    // dependents exist but none are on screen (all filtered out) → sel is just self.
    if (sel.empty() || sel.length <= 1) {
      toast("Blast-radius nodes are filtered out — clear filters to see them.");
      return;
    }
    cy.elements().addClass("faded");
    sel.removeClass("faded").addClass("highlight");
    sel.edgesWith(sel).removeClass("faded").addClass("highlight");
    self.removeClass("highlight").addClass("focus");
    applyEdgeLabels();
    state.selectedId = id;
    cy.animate({ fit: { eles: sel, padding: 60 } }, { duration: 450 });
    toast("Blast radius: " + dependents.length + " dependent file" + (dependents.length === 1 ? "" : "s"));
  }

  // Trace the transitive reach of a node (within the current view): predecessors
  // (everything that depends on it) or successors (everything it depends on).
  function tracePath(id, dir) {
    var cy = state.cy;
    var node = cy.getElementById(id);
    if (node.empty()) return;
    var reach = dir === "up" ? node.predecessors() : node.successors();
    var set = reach.union(node);
    cy.elements().addClass("faded");
    set.removeClass("faded");
    set.nodes().addClass("highlight");
    set.edges().addClass("highlight");
    node.removeClass("highlight").addClass("focus");
    applyEdgeLabels();
    state.selectedId = id;
    if (set.length > 1) cy.animate({ fit: { eles: set, padding: 60 } }, { duration: 450 });
    toast((dir === "up" ? "Dependents" : "Dependencies") + ": " + (set.nodes().length - 1) + " nodes");
  }

  // Shortest dependency path between two nodes (shift-click), directed first.
  function tracePathBetween(a, b) {
    var cy = state.cy;
    var na = cy.getElementById(a), nb = cy.getElementById(b);
    if (na.empty() || nb.empty()) return;
    var r = cy.elements().aStar({ root: na, goal: nb, directed: true });
    if (!r.found) r = cy.elements().aStar({ root: na, goal: nb, directed: false });
    if (!r.found) { toast("No path between these nodes in this view"); return; }
    cy.elements().addClass("faded");
    r.path.removeClass("faded");
    r.path.nodes().addClass("highlight");
    r.path.edges().addClass("highlight");
    applyEdgeLabels();
    cy.animate({ fit: { eles: r.path, padding: 70 } }, { duration: 450 });
    toast("Path: " + r.path.nodes().length + " nodes");
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

    function close() {
      box.classList.remove("show"); box.innerHTML = ""; activeIdx = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    // Keep aria-activedescendant pointing at the highlighted option for SR users.
    function syncActiveDescendant() {
      if (activeIdx >= 0 && matches[activeIdx]) input.setAttribute("aria-activedescendant", "sr-opt-" + activeIdx);
      else input.removeAttribute("aria-activedescendant");
    }

    // Which field matched the query — shown in the result row so a search by
    // route / feature / package explains itself.
    function matchHint(n, q) {
      if (n.routePath && n.routePath.toLowerCase().indexOf(q) !== -1) return n.routePath;
      if (n.feature && n.feature.toLowerCase().indexOf(q) !== -1) return "feat:" + n.feature;
      if (n.package && n.package.toLowerCase().indexOf(q) !== -1) return n.package;
      if (n.path && n.path.toLowerCase().indexOf(q) !== -1) return n.path.split("/").pop();
      return n.package || "";
    }

    function run() {
      var q = input.value.trim().toLowerCase();
      if (!q) { close(); return; }
      matches = state.data.nodes.filter(function (n) {
        return (n.label && n.label.toLowerCase().indexOf(q) !== -1)
          || (n.path && n.path.toLowerCase().indexOf(q) !== -1)
          || (n.routePath && n.routePath.toLowerCase().indexOf(q) !== -1)
          || (n.feature && n.feature.toLowerCase().indexOf(q) !== -1)
          || (n.package && n.package.toLowerCase().indexOf(q) !== -1);
      }).slice(0, 12);
      input.setAttribute("aria-expanded", "true");
      if (!matches.length) { box.innerHTML = '<div class="sr-item" style="color:var(--ink-faint)">no matches</div>'; box.classList.add("show"); input.removeAttribute("aria-activedescendant"); return; }
      box.innerHTML = matches.map(function (n, i) {
        return '<div class="sr-item' + (i === activeIdx ? ' active' : '') + '" id="sr-opt-' + i + '" role="option"' +
          ' aria-selected="' + (i === activeIdx ? "true" : "false") + '" data-id="' + esc(n.id) + '">' +
          '<span class="sr-kind">' + esc(n.kind) + '</span>' +
          '<span>' + esc(n.label) + '</span>' +
          '<span class="sr-path">' + esc(matchHint(n, q)) + '</span>' +
          '</div>';
      }).join("");
      box.classList.add("show");
      syncActiveDescendant();
      Array.prototype.forEach.call(box.querySelectorAll(".sr-item[data-id]"), function (el) {
        el.addEventListener("click", function () { pick(el.getAttribute("data-id")); });
      });
    }

    function pick(id) {
      close();
      input.value = "";
      var n = nodeRecord(id);
      if (!n) return;
      state.detailStack = []; // fresh selection from search resets drill history
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
    // Global shortcut: "/" or Cmd/Ctrl-K focuses search (unless already typing).
    document.addEventListener("keydown", function (e) {
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      var typing = tag === "INPUT" || tag === "TEXTAREA";
      if ((e.key === "/" && !typing) || ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        input.focus();
        input.select();
      }
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
  // Reconcile sidebar chip "on" state with the active sets (robust to package
  // names with special characters — avoids fragile attribute-selector escaping).
  function syncSidebarChips() {
    Array.prototype.forEach.call(document.querySelectorAll('#filter-package .chip'), function (c) {
      c.classList.toggle("on", state.activePackages.has(c.getAttribute("data-pkg")));
    });
    Array.prototype.forEach.call(document.querySelectorAll('#filter-feature .chip'), function (c) {
      c.classList.toggle("on", state.activeFeatures.has(c.getAttribute("data-feat")));
    });
  }
  // Floating bar over the canvas showing every active filter as a removable
  // pill + "Clear all" — so a filter left on is always visible, never silent.
  function renderActiveFilters() {
    var bar = document.getElementById("active-filters");
    if (!bar) return;
    var pkgs = setToArray(state.activePackages);
    var feats = setToArray(state.activeFeatures);
    if (!pkgs.length && !feats.length) { bar.hidden = true; bar.innerHTML = ""; return; }
    var html = '<span class="af-label">Filters</span>';
    pkgs.forEach(function (p) {
      html += '<button class="af-chip" data-kind="pkg" data-val="' + esc(p) + '" title="Remove this package filter">' +
        '<span class="af-dot pkg"></span>' + esc(p) + '<span class="af-x">&times;</span></button>';
    });
    feats.forEach(function (f) {
      html += '<button class="af-chip" data-kind="feat" data-val="' + esc(f) + '" title="Remove this feature filter">' +
        '<span class="af-dot feat"></span>' + esc(f) + '<span class="af-x">&times;</span></button>';
    });
    html += '<button class="af-clear" id="af-clear" title="Remove all filters">Clear all</button>';
    bar.innerHTML = html;
    bar.hidden = false;
    Array.prototype.forEach.call(bar.querySelectorAll(".af-chip"), function (el) {
      el.addEventListener("click", function () {
        var val = el.getAttribute("data-val");
        if (el.getAttribute("data-kind") === "pkg") state.activePackages.delete(val);
        else state.activeFeatures.delete(val);
        syncSidebarChips();
        renderKeepFilters();
        syncUrl();
      });
    });
    document.getElementById("af-clear").addEventListener("click", function () {
      clearPackageFilters();
      clearFeatureFilters();
      renderKeepFilters();
      syncUrl();
    });
  }

  // Reflect the active view in ARIA + a roving tabindex (active tab is the only
  // one in the tab order; arrow keys move between them).
  function updateTabA11y() {
    Array.prototype.forEach.call(document.querySelectorAll(".view-tab"), function (t) {
      var on = t.classList.contains("active");
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.setAttribute("tabindex", on ? "0" : "-1");
    });
  }

  // ---- View switching ----------------------------------------------------
  function switchView(view) {
    state.view = view;
    state.focusSubgraph = null; // focus is per-view; switching exits it
    Array.prototype.forEach.call(document.querySelectorAll(".view-tab"), function (t) {
      t.classList.toggle("active", t.getAttribute("data-view") === view);
    });
    updateTabA11y();
    document.getElementById("view-desc").textContent = VIEWS[view].desc;
    render(true);
    syncUrl();
    announce(VIEWS[view].desc.split(" · ")[0] + " view");
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

    var viewTabs = Array.prototype.slice.call(document.querySelectorAll(".view-tab"));
    viewTabs.forEach(function (t, i) {
      t.addEventListener("click", function () {
        // Leaving an insight focus: drop pinned nodes + clear the active marker.
        state.focusInsight = null;
        clearInsightActive();
        switchView(t.getAttribute("data-view"));
      });
      // ARIA tablist keyboard model: ←/→ (and Home/End) move + activate.
      t.addEventListener("keydown", function (e) {
        var idx = -1;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") idx = (i + 1) % viewTabs.length;
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") idx = (i - 1 + viewTabs.length) % viewTabs.length;
        else if (e.key === "Home") idx = 0;
        else if (e.key === "End") idx = viewTabs.length - 1;
        else return;
        e.preventDefault();
        var next = viewTabs[idx];
        next.focus();
        next.click();
      });
    });
    document.getElementById("btn-relayout").addEventListener("click", function () { runLayout(true); });
    document.getElementById("btn-fit").addEventListener("click", function () { state.cy.animate({ fit: { padding: 50 } }, { duration: 350 }); });
    document.getElementById("btn-reset").addEventListener("click", resetSelection);

    document.getElementById("toggle-groups").addEventListener("change", function (e) {
      state.groupByPackage = e.target.checked;
      // Grouping is a topology change (compound parents) → full relayout, animated.
      render(true, true);
      syncUrl();
    });
    document.getElementById("toggle-edgelabels").addEventListener("change", function (e) {
      state.edgeLabels = e.target.checked;
      applyEdgeLabels();
      syncUrl();
    });
    document.getElementById("toggle-isolated").addEventListener("change", function (e) {
      state.showIsolated = e.target.checked;
      // Topology change (adds/removes many disconnected nodes) → full relayout.
      render(true);
      syncUrl();
    });
    document.getElementById("toggle-swimlanes").addEventListener("change", function (e) {
      state.swimlanes = e.target.checked;
      render(true);
      syncUrl();
    });
    var churnToggle = document.getElementById("toggle-churn");
    if (churnToggle) churnToggle.addEventListener("change", function (e) {
      state.churnOverlay = e.target.checked;
      sizeNodes(); // re-size/tint only — no relayout needed
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

  // Push a message to the polite aria-live region for screen readers.
  function announce(msg) {
    var el = document.getElementById("a11y-live");
    if (!el) return;
    el.textContent = ""; // re-trigger announcement even if the text repeats
    setTimeout(function () { el.textContent = msg; }, 30);
  }

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "toast"; t.textContent = msg;
    document.body.appendChild(t);
    announce(msg); // toasts are visual-only otherwise — mirror them to SR users
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
      updateTabA11y();
      var tg = document.getElementById("toggle-groups");
      if (tg) tg.checked = state.groupByPackage;
      var tl = document.getElementById("toggle-edgelabels");
      if (tl) tl.checked = state.edgeLabels;
      var ti = document.getElementById("toggle-isolated");
      if (ti) ti.checked = state.showIsolated;
      var ts = document.getElementById("toggle-swimlanes");
      if (ts) ts.checked = state.swimlanes;
      // The churn/hotspot overlay is only meaningful when git history is present.
      var churnRow = document.getElementById("churn-row");
      if (churnRow) churnRow.hidden = !hasChurn();
      var tcInit = document.getElementById("toggle-churn");
      if (tcInit) tcInit.checked = state.churnOverlay;

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
        if (n.data("isSuper")) { // expand a collapsed package back to its files
          state.collapsedPackages.delete(n.data("pkg"));
          render(true, true);
          syncUrl();
          announce("Expanded package " + n.data("pkg"));
          return;
        }
        // Shift-click a second node → trace shortest path from the selected one.
        if (evt.originalEvent && evt.originalEvent.shiftKey && state.selectedId && state.selectedId !== n.id()) {
          tracePathBetween(state.selectedId, n.id());
          return;
        }
        state.detailStack = []; // a fresh canvas click starts a new drill history
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
      setupMinimap();
      setupHelp();
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
