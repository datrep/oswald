// trading/public/js/bridge-machine.js — LIVE BRIDGE STATE MACHINE (TRD-BRG-1 #1511, 2026-10-05).
//
// The owner's ask, verbatim: "a live (semi interactive) state machine, fitted inside the trading agent,
// not a html report... have the UI and code do it for you."
//
// So: the DRAWING is data. `bridge-state-graph.json` is exported verbatim from
// `trading/plus500/bridgeStateGraph.js` (which is pinned against the reducer in
// `test/bridge-state-graph.test.js` — an arrow that lies about where it goes fails the suite), and this
// file renders it: nodes and edges come from the graph, the LIVE state comes from `bridge-state.json`
// (the observer's own output, 10 s cadence), and positions/labels are computed from tables below — no
// hand-drawn picture that can drift, no LLM spaghetti.
//
// Semi-interactive: click a node for its story + every edge touching it; click an edge for its guard;
// click a timeline entry to replay which arrow fired; the active node pulses and its category colours it.
//
// Mounted twice: the dashboard's "Bridge state machine" card (compact) and /bridge-state.html (full).
// Usage: BridgeMachine.mount(el, { compact, graphUrl, stateUrl, pollMs }).
'use strict';
(function () {
  // ── geometry — tuned once for clean lines; keyed by state/transition id ────────────────────────────
  const NODES = {
    OFF: { x: 30, y: 60, w: 140, h: 42 },
    LAUNCHING: { x: 260, y: 60, w: 150, h: 42 },
    WEDGED: { x: 30, y: 210, w: 160, h: 46 },
    RESTING: { x: 260, y: 210, w: 150, h: 46 },
    LOGGED_OUT: { x: 30, y: 360, w: 160, h: 46 },
    NAVIGATING: { x: 490, y: 210, w: 170, h: 46 },
    BLANK_RENDER: { x: 490, y: 360, w: 170, h: 46 },
  };
  const EDGES = {
    'launch-intent':  { d: 'M 170 81 L 252 81',                          lx: 176, ly: 75,  anchor: 'start' },
    'attach-ok':      { d: 'M 335 102 L 335 204',                        lx: 341, ly: 150, anchor: 'start' },
    'attach-timeout': { d: 'M 260 87 L 232 87 L 232 226 L 196 226',      lx: 122, ly: 124, anchor: 'start' },
    'cdp-unattached': { d: 'M 335 210 L 335 178 L 110 178 L 110 204',    lx: 112, ly: 172, anchor: 'start' },
    'chrome-gone':    { d: 'M 60 210 L 60 108',                          lx: 66,  ly: 150, anchor: 'start' },
    'capture-wedge':  { d: 'M 258 220 L 196 220',                        lx: 96,  ly: 206, anchor: 'start' },
    'reads-resume':   { d: 'M 196 240 L 254 240',                        lx: 192, ly: 258, anchor: 'start' },
    'login-death':    { d: 'M 260 240 L 226 240 L 226 383 L 196 383',    lx: 100, ly: 336, anchor: 'start' },
    'login-ok':       { d: 'M 196 397 L 226 397 L 226 254 L 254 254',    lx: 232, ly: 418, anchor: 'start' },
    'nav-start':      { d: 'M 410 224 L 484 224',                        lx: 414, ly: 218, anchor: 'start' },
    'nav-settle':     { d: 'M 484 244 L 414 244',                        lx: 414, ly: 260, anchor: 'start' },
    'nav-blank':      { d: 'M 575 256 L 575 354',                        lx: 581, ly: 308, anchor: 'start' },
    'blank-settle':   { d: 'M 490 383 L 462 383 L 462 300 L 410 300 L 410 250', lx: 414, ly: 316, anchor: 'start' },
  };
  const VB = { w: 1060, h: 470 };
  const TINT = { operational: '#3fae6a', degraded: '#e0a63c', dead: '#e05c5c' };
  const CAT_TINT = { OPERATIONAL: '#3fae6a', QUIET: '#8a97a5', DEGRADED: '#e0a63c', DEAD: '#e05c5c' };

  const CSS = `
  .bm-root { font: 13px/1.5 Consolas, Menlo, monospace; color: #d7dde3; }
  .bm-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .bm-chip { padding: 3px 10px; border-radius: 10px; background: #1d2733; font-size: 14px; }
  .bm-chip small { color: #6b7d90; font-size: 11px; }
  .bm-svgwrap { width: 100%; }
  .bm-svgwrap svg { width: 100%; height: auto; display: block; }
  .bm-node rect { fill: #161d26; stroke-width: 1.6; }
  .bm-node text { fill: #d7dde3; font-weight: 600; font-size: 12px; }
  .bm-node .bm-sub { fill: #9fb3c8; font-weight: 400; font-size: 10px; }
  .bm-node { cursor: pointer; }
  .bm-node.op rect { stroke: ${TINT.operational}; } .bm-node.dg rect { stroke: ${TINT.degraded}; } .bm-node.dd rect { stroke: ${TINT.dead}; }
  .bm-node.bm-active rect { stroke-width: 3; filter: drop-shadow(0 0 6px currentColor); }
  .bm-node.bm-active { animation: bm-pulse 1.6s ease-in-out infinite; }
  @keyframes bm-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }
  .bm-node.bm-dim { opacity: 0.45; }
  .bm-edge { stroke: #4a5b6d; stroke-width: 1.3; fill: none; }
  .bm-edge.bm-sel { stroke: #9fd3ff; stroke-width: 2.4; }
  .bm-arrow.bm-sel { fill: #9fd3ff; }
  .bm-elabel { fill: #7b8ea0; font: 9.5px Consolas, monospace; cursor: pointer; }
  .bm-elabel.bm-sel { fill: #9fd3ff; }
  .bm-panel { margin-top: 8px; background: #131a22; border: 1px solid #223041; border-radius: 8px; padding: 10px 12px; font-size: 12px; min-height: 44px; }
  .bm-panel b { color: #9fb3c8; }
  .bm-panel .bm-k { color: #6b7d90; }
  .bm-timeline { margin-top: 8px; max-height: 150px; overflow: auto; font-size: 11.5px; }
  .bm-timeline div { padding: 2px 6px; border-left: 2px solid transparent; cursor: pointer; color: #9fb3c8; }
  .bm-timeline div:hover { background: #141c25; }
  .bm-timeline div.bm-sel { border-left-color: #9fd3ff; color: #d7dde3; }
  .bm-mods { color: #7b8ea0; font-size: 11px; }
  .bm-mods b { color: #d7dde3; font-weight: 600; }
  .bm-mods .on { color: #e0a63c; font-weight: 600; }
  .bm-link { color: #7fb2d9; font-size: 11px; }
  .bm-compact .bm-sub { display: none; }
  .bm-compact .bm-elabel { font-size: 8.5px; }
  .bm-compact .bm-panel, .bm-compact .bm-timeline { display: none; }
  .bm-err { color: #e05c5c; font-size: 12px; }
  `;

  const NS = 'http://www.w3.org/2000/svg';

  // ── 2026-10-06: THE CONNECTION IS PUSH-BASED (owner: "change 5 s ping to 'when it changes state'").
  // One same-origin SSE connection per page serves ALL subscribers; the desk pushes the full state on
  // connect, on every state change, and as a 5-minute snapshot. A 30 s poll exists ONLY as a fallback
  // when the stream is unavailable — the steady state sends NOTHING between changes.
  const conn = {
    es: null, fails: 0, pollIv: null, subscribers: new Set(),
    emit(j) { for (const cb of Array.from(this.subscribers)) { try { cb(j); } catch { /* a bad subscriber must not kill the stream */ } } },
    connect() {
      if (this.es) return;
      if (typeof EventSource === 'undefined') { this.startFallback(); return; }
      try {
        this.es = new EventSource('/bridge-state-stream');
        this.es.addEventListener('state', (e) => this.got(e));
        this.es.addEventListener('snapshot', (e) => this.got(e));
        this.es.onopen = () => { this.fails = 0; if (this.pollIv) { clearInterval(this.pollIv); this.pollIv = null; } };
        this.es.onerror = () => { if (++this.fails >= 3) this.startFallback(); };
      } catch { this.startFallback(); }
    },
    got(e) { try { this.emit(JSON.parse(e.data)); } catch { /* malformed payload dropped, not rendered */ } },
    startFallback() {
      if (this.pollIv) return;
      this.pollIv = setInterval(async () => {
        try { this.emit(await (await fetch('./bridge-state.json?ts=' + Date.now(), { cache: 'no-store' })).json()); } catch { /* next tick */ }
      }, 30000);
    },
  };
  function subscribe(cb) { conn.subscribers.add(cb); conn.connect(); return () => conn.subscribers.delete(cb); }
  const el = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  };

  function mount(host, opts) {
    const o = Object.assign({ compact: false, graphUrl: './bridge-state-graph.json', stateUrl: './bridge-state.json', pollMs: 5000, title: '' }, opts || {});
    host.classList.add('bm-root');
    if (o.compact) host.classList.add('bm-compact');
    if (!document.getElementById('bm-css')) {
      const st = document.createElement('style');
      st.id = 'bm-css'; st.textContent = CSS;
      document.head.appendChild(st);
    }
    // skeleton
    const head = document.createElement('div'); head.className = 'bm-head'; host.appendChild(head);
    const chip = document.createElement('span'); chip.className = 'bm-chip'; chip.textContent = 'loading…'; head.appendChild(chip);
    const mods = document.createElement('span'); mods.className = 'bm-mods'; head.appendChild(mods);
    const svgwrap = document.createElement('div'); svgwrap.className = 'bm-svgwrap'; host.appendChild(svgwrap);
    const panel = document.createElement('div'); panel.className = 'bm-panel'; panel.innerHTML = '<span class="bm-k">Click a state or an arrow for its story; the timeline replays what fired.</span>'; host.appendChild(panel);
    const timeline = document.createElement('div'); timeline.className = 'bm-timeline'; host.appendChild(timeline);
    if (o.compact) {
      const link = document.createElement('a'); link.className = 'bm-link'; link.href = 'bridge-state.html'; link.textContent = 'open the full live view →';
      head.appendChild(link);
    }

    const svg = el('svg', { viewBox: `0 0 ${VB.w} ${VB.h}`, xmlns: NS }, svgwrap);
    const defs = el('defs', {}, svg);
    const marker = el('marker', { id: 'bm-arr', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
    el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: '#4a5b6d' }, marker);
    const gEdges = el('g', {}, svg), gLabels = el('g', {}, svg), gNodes = el('g', {}, svg);

    let graph = null;
    const edgeEls = {}, edgeLabelEls = {}, nodeEls = {};
    let selEdge = null, selNode = null, lastState = null;
    const causeIndex = {};   // `${from}|${to}|${cause}` -> edge id (structured transitions map exactly)

    function drawGraph() {
      gEdges.textContent = ''; gLabels.textContent = ''; gNodes.textContent = '';
      for (const t of graph.transitions) {
        const geo = EDGES[t.id];
        if (!geo) continue;
        const p = el('path', { d: geo.d, class: 'bm-edge', 'marker-end': 'url(#bm-arr)', 'data-edge': t.id }, gEdges);
        const lab = el('text', { x: geo.lx, y: geo.ly, class: 'bm-elabel', 'text-anchor': geo.anchor, 'data-edge': t.id }, gLabels);
        lab.textContent = t.label;
        edgeEls[t.id] = p; edgeLabelEls[t.id] = lab;
        causeIndex[`${t.from}|${t.to}|${t.cause}`] = t.id;
        p.addEventListener('click', () => selectEdge(t.id));
        lab.addEventListener('click', () => selectEdge(t.id));
      }
      for (const s of graph.states) {
        const n = NODES[s.id]; if (!n) continue;
        const g = el('g', { class: `bm-node ${s.tint === 'operational' ? 'op' : s.tint === 'degraded' ? 'dg' : 'dd'}`, 'data-state': s.id }, gNodes);
        el('rect', { x: n.x, y: n.y, width: n.w, height: n.h, rx: 10 }, g);
        const t1 = el('text', { x: n.x + 14, y: n.y + 19 }, g); t1.textContent = s.title;
        const t2 = el('text', { x: n.x + 14, y: n.y + 34, class: 'bm-sub' }, g); t2.textContent = s.sub;
        g.addEventListener('click', () => selectNode(s.id));
        nodeEls[s.id] = g;
      }
    }

    function selectEdge(id) {
      for (const k in edgeEls) { edgeEls[k].classList.toggle('bm-sel', k === id); edgeLabelEls[k].classList.toggle('bm-sel', k === id); }
      for (const k in nodeEls) nodeEls[k].classList.remove('bm-dim');
      selEdge = id; selNode = null;
      const t = graph.transitions.find((x) => x.id === id);
      if (!t) return;
      panel.innerHTML = `<b>${t.from} → ${t.to}</b> <span class="bm-k">(${t.label})</span><br>`
        + `<span class="bm-k">guard:</span> ${t.guard}<br>`
        + `<span class="bm-k">evidence:</span> ${t.evidence}<br>`
        + `<span class="bm-k">reducer cause:</span> <b>${t.cause}</b>`;
    }

    function selectNode(id) {
      for (const k in nodeEls) nodeEls[k].classList.toggle('bm-dim', k !== id && k !== lastState);
      selNode = id; selEdge = null;
      for (const k in edgeEls) { edgeEls[k].classList.remove('bm-sel'); edgeLabelEls[k].classList.remove('bm-sel'); }
      const s = graph.states.find((x) => x.id === id);
      if (!s) return;
      const ins = graph.transitions.filter((t) => t.to === id).map((t) => `${t.from} → <b>${t.to}</b> <span class="bm-k">when ${t.guard}</span>`).join('<br>');
      const outs = graph.transitions.filter((t) => t.from === id).map((t) => `<b>${t.from}</b> → ${t.to} <span class="bm-k">when ${t.guard}</span>`).join('<br>');
      panel.innerHTML = `<b>${s.title}</b> <span class="bm-k">${s.sub}</span><br>${s.blurb}<br><br>`
        + `<span class="bm-k">entered by:</span><br>${ins || '—'}<br><br><span class="bm-k">leaves via:</span><br>${outs || '—'}`;
    }

    function renderTimeline(trs) {
      timeline.textContent = '';
      if (!trs || !trs.length) { const d = document.createElement('div'); d.innerHTML = '<span class="bm-k">no transitions observed yet this session</span>'; timeline.appendChild(d); return; }
      for (const tr of trs) {
        const d = document.createElement('div');
        let line, eid = null;
        if (typeof tr === 'string') { line = tr; }
        else {
          line = `${(tr.at || '').slice(11, 19)}  ${tr.fromState || '?'} → ${tr.state} (${tr.cause || '?'})`;
          eid = causeIndex[`${tr.fromState}|${tr.state}|${tr.cause}`] || null;
        }
        d.textContent = line;
        if (eid) { d.addEventListener('click', () => selectEdge(eid)); d.dataset.edge = eid; }
        timeline.appendChild(d);
      }
    }

    function apply(live) {
      const st = live.state, cat = live.category;
      const emoji = (graph && graph.categories.find((c) => c.id === cat) || {}).emoji || '';
      const disp = (live.display || '').trim();
      chip.innerHTML = `${disp || (emoji + ' ' + cat + ' · ' + st)} <small>since ${(live.since || '').slice(11, 19)}Z</small>`;
      chip.style.boxShadow = `inset 3px 0 0 ${CAT_TINT[cat] || '#8a97a5'}`;
      for (const k in nodeEls) {
        nodeEls[k].classList.toggle('bm-active', k === st);
        nodeEls[k].classList.remove('bm-dim');
      }
      lastState = st;
      const m = live.modifiers || {};
      const bits = [];
      bits.push(`parked <b class="${m.isParked ? 'on' : ''}">${m.isParked ? 'ON' : 'no'}</b>`);
      bits.push(`paused <b class="${m.healthPaused ? 'on' : ''}">${m.healthPaused ? 'ON' : 'no'}</b>`);
      bits.push(`recovering <b class="${m.isRecovering ? 'on' : ''}">${m.isRecovering ? m.recoveryCause || 'yes' : 'no'}</b>`);
      if (m.feedSilentForMs != null) bits.push(`feed silent <b>${Math.round(m.feedSilentForMs / 1000)}s</b>`);
      mods.innerHTML = bits.join(' · ');
      renderTimeline(live.transitions);
    }

    let graphAt = 0;
    async function ensureGraph() {
      if (graph && Date.now() - graphAt < 15 * 60 * 1000) return;
      try {
        const g = await (await fetch(o.graphUrl + '?ts=' + Date.now(), { cache: 'no-store' })).json();
        // tolerate both key cases (STATES/… from a raw export, states/… from the observer's canonical write)
        graph = g.STATES ? { states: g.STATES, transitions: g.TRANSITIONS, modifiers: g.MODIFIERS, categories: g.CATEGORIES, constants: g.CONSTANTS } : g;
        drawGraph();
        graphAt = Date.now();
      } catch (e) {
        chip.textContent = 'graph unavailable — ' + String(e && e.message || e).slice(0, 80);
        chip.className = 'bm-chip bm-err';
      }
    }
    const onState = (j) => { ensureGraph().then(() => { if (graph) apply(j); }); };
    const unsubscribe = subscribe(onState);
    return {
      stop: () => { unsubscribe(); if (!conn.subscribers.size && conn.es) { try { conn.es.close(); } catch { /* best-effort */ } conn.es = null; } },
    };
  }

  window.BridgeMachine = { mount, subscribe, version: '2026-10-06.1', NODES, EDGES };
})();
