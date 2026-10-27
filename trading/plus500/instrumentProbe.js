// trading/plus500/instrumentProbe.js — PHASE 0 of the instrument mirror (TRD-45).
//
// A MEASUREMENT INSTRUMENT, not a scraper. It reads whatever page the OPERATOR has already
// navigated to and reports what fields the platform actually exposes. It never navigates, never
// clicks, never closes or disconnects the shared page.
//
// Why it exists: the report concludes we cannot design the mirror until we know whether the venue
// exposes lot size / minimum trade / leverage / spread at all. A repository-wide search for
// `lotSize|minTrade|contractSize|leverage` returns nothing, and the only instrument reader
// (`webtrader.readInstrumentTable`) extracts exactly four fields — name, change, sell, buy. So the
// headline question for Phase 0 is: is contract metadata VISIBLE on the page, and if so where?
//
// DELIBERATE DEVIATION FROM §8 OF THE PLAN, stated rather than slipped: the owner agreed to
// "closed market only" for DISCOVERY. This probe does not navigate at all — it reads the page the
// operator is already on — so it cannot add session contention beyond the operator's own
// browsing. The market state is therefore REPORTED, not enforced; the hard gate is the wake guard
// (a wake may be mid-decision and the bridge is shared). A NAVIGATING pass (Phase 3) must respect
// the closed-market gate.
'use strict';

const browser = require('./browser');
// The verdict rules live in a pure module because THIS file top-level-requires ./browser: a test that loaded it
// would try to attach to the desk's live Chrome. See probeVerdict.js for why `ok` is not a constant.
const { probeVerdict } = require('./probeVerdict');

// Runs in the page. Kept dependency-free and defensive: an unexpected DOM shape must produce a
// partial report, never a thrown error that hides what WAS readable.
async function probeCurrentPage(page) {
  return page.evaluate(() => {
    // Coerce FIRST. `className` on an SVG element is an SVGAnimatedString OBJECT, not a string,
    // so calling .replace on it throws and takes the whole observation with it — which is exactly
    // what happened on /trade/oil---weekly, where instrument rows contain icon SVGs. An unexpected
    // DOM shape must downgrade to a partial report, never kill the read.
    const clean = (s) => String(s == null ? '' : s).replace(/[\u200e\u200f\u200b\u00a0]/g, '').trim().replace(/\s+/g, ' ');
    const clsOf = (el) => {
      if (!el) return '';
      const c = el.className;
      if (c == null) return '';
      return String(c.baseVal != null ? c.baseVal : c);
    };
    const num = (s) => {
      const m = clean(s).match(/[\d,]+(?:\.\d+)?/);
      return m ? parseFloat(m[0].replace(/,/g, '')) : null;
    };
    const short = (s, n = 90) => clean(s).slice(0, n);

    // --- the table we already know about -------------------------------------
    const container = document.querySelector('[class*="instrument-table-container"]');
    const rowEls = container ? [...container.querySelectorAll('[class*="instrument-row"]')] : [];

    // Per-row: every attribute and every child, so nothing visible is lost to a guess about
    // which fields matter. `childClasses` is the field inventory that drives Phase 1.
    const rows = rowEls.slice(0, 40).map((el) => {
      try {
      const attrs = {};
      for (const a of el.attributes) attrs[a.name] = short(a.value, 120);
      // Fields the LIVE page turned out to expose that the first probe did not read (from the
      // owner's own page dumps, 2026-09-13).
      //   • data-instrument-id  — the venue's stable numeric id. It is ALSO embedded in every
      //     data-testid ("InstrumentRow.1116673.SellRate"), so it is the mirror's join key even
      //     where the attribute itself is absent.
      //   • the watchlist star's icon attribute -pds-star-filled vs -pds-star  — membership.
      //   • data-no-trading on the RATE SPANS. CORRECTED — my first version of this comment said
      //     "a MACHINE-READABLE per-instrument tradability flag ... the answer to whether an
      //     instrument is being traded". The owner's two option dumps DISPROVE that reading: both
      //     rows read data-no-trading="false" while the sidebar simultaneously shows "Market is
      //     closed" and the high/low cell reads "Market is closed". So it is NOT a market-open
      //     flag. Semantics remain UNRESOLVED: record the raw attribute, build nothing on it until
      //     it has been observed against an OPEN market (if it never changes, it is a constant).
      //     The row carries a SECOND, different no-trading signal — the class `no-trading` on the
      //     logo wrap and on the high/low span — and the two DISAGREE on the same row, so both are
      //     captured separately rather than collapsed into one "tradable" boolean.
      const nt = el.querySelector('[data-no-trading]');
      const wlBtn = el.querySelector('[data-testid$="Button.Watchlist"]');
      const wlIcon = wlBtn ? String(wlBtn.getAttribute('icon') || '') : '';
      return {
        name: short((el.querySelector('.name') || {}).textContent),
        secondary: short((el.querySelector('[data-testid$=".SecondaryName"]') || {}).textContent, 60),
        change: short((el.querySelector('.change') || {}).textContent, 30),
        sell: num((el.querySelector('.button-sell') || {}).textContent),
        buy: num((el.querySelector('.button-buy') || {}).textContent),
        instrumentId: el.getAttribute('data-instrument-id'),
        // Which row the SIDEBAR is describing. Without this the contract spec below cannot be
        // attributed to an instrument, and a mismatch would be silent.
        selected: /(^|\s)selected(\s|$)/.test(clsOf(el)),
        rateNoTrading: nt ? String(nt.getAttribute('data-no-trading')) : null,
        logoNoTrading: /(^|\s)no-trading(\s|$)/.test(clsOf(el.querySelector('.instrument-logo-wrap'))),
        watchlisted: /filled/.test(wlIcon) ? true : (wlIcon ? false : null),
        marketText: short((el.querySelector('.high-low') || {}).textContent, 40),
        testid: el.getAttribute('data-testid'),
        attrs,
        childClasses: [...el.children].map((c) => short(clsOf(c), 60)).filter(Boolean),
        text: short(el.textContent, 200),
      };
      } catch (e) {
        // one unreadable row must not cost us the other 39
        return { name: short(el.textContent, 60), partial: true, error: String((e && e.message) || e).slice(0, 120) };
      }
    });

    // Union of child classes across rows = "which fields exist at all on this page".
    const fieldInventory = {};
    for (const r of rows) for (const c of r.childClasses) fieldInventory[c] = (fieldInventory[c] || 0) + 1;

    // --- the measurement that decides Phase 1 ---------------------------------
    // Does the PAGE mention contract metadata anywhere? If these are empty, the table cannot
    // supply lot size and Phase 2 needs the per-instrument ticket instead (a much slower path).
    const KW = /(lot|contract|minimum|min\.?\s*(?:trade|size|amount)|leverage|margin|spread|commission|swap|units|trading hours|session)/i;
    const textHits = [];
    try {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode()) && textHits.length < 60) {
        // SKIP non-rendered text. The first run of this probe reported a keyword hit that turned
        // out to be a JavaScript comment inside an inline <script> ("load the manifest according
        // to product type"). Since the sweep's verdict decides whether Phase 1 can obtain contract
        // metadata at all, noise here is not cosmetic — it reads as evidence.
        const tag = n.parentElement && n.parentElement.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
        const t = clean(n.nodeValue);
        if (t && t.length > 2 && KW.test(t)) textHits.push(short(t, 140));
      }
    } catch { /* partial is fine */ }
    const attrHits = [...document.querySelectorAll('[class],[title],[data-testid],[aria-label]')]
      .map((e) => `${e.tagName}.${short(e.className, 50)}|${e.getAttribute('data-testid') || ''}|${e.getAttribute('title') || ''}|${e.getAttribute('aria-label') || ''}`)
      .filter((s) => KW.test(s)).slice(0, 40);

    // Any link to a likely per-instrument detail route (the ticket carries contract size).
    const links = [...document.querySelectorAll('a[href]')]
      .map((a) => a.getAttribute('href')).filter((h) => h && /instrument|trade\/|market/i.test(h)).slice(0, 25);

    // What panels/tabs exist, so we know what else is reachable by hand.
    const panels = [...document.querySelectorAll('[role="tab"],[class*="tab"]')]
      .map((e) => short(e.textContent, 40)).filter((t) => t && t.length < 40 && t.length > 1).slice(0, 30);

    // --- category nav (breadth WITHOUT navigating) ---------------------------
    // The operator's point: when Plus500 is already open on a page, the nav tells us which
    // categories EXIST and which one is highlighted, and the table tells us which instruments the
    // highlighted category holds. That is a breadth signal obtainable from one manual stop — no
    // crawling, no extra logins.
    const cats = new Map();
    for (const el of document.querySelectorAll('a[href],[role="tab"],[class*="categor"],[class*="nav-item"],[class*="menu-item"]')) {
      const name = clean(el.textContent);
      if (!name || name.length > 40) continue;
      const href = String(el.getAttribute('href') || '').slice(0, 120);
      const cls = clsOf(el).slice(0, 60);
      const selected = el.getAttribute('aria-selected') === 'true' || /(^|[\s-])(active|selected|current|highlight)/i.test(cls);
      const relevant = /categor|instrument|trade\//i.test(href) || /categor/i.test(cls) || selected;
      if (!relevant) continue;
      const key = `${name}|${href}`;
      if (!cats.has(key)) cats.set(key, { name, href, selected, cls });
    }
    const categories = [...cats.values()].slice(0, 150);
    const highlighted = categories.filter((c) => c.selected).map((c) => c.name).slice(0, 10);

    // The CATEGORY TREE, which is the breadth map: every group (Commodities, Commodities Options,
    // Indices Options, Forex Options, Shares Options, ...) with the venue's OWN category ids
    // (data-toggle-name="category_2") and which entry is selected. Options are first-class
    // categories here, so the universe is several times larger than the watchlist suggests.
    const tree = [];
    try {
      for (const li of document.querySelectorAll('#mainCategoriesRepeater > li')) {
        const g = clean((li.querySelector('h3 span') || {}).textContent);
        if (!g) continue;
        const items = [...li.querySelectorAll('a[data-testid^="TradeCategories.Button."]')].map((a) => ({
          name: clean(a.textContent).slice(0, 40),
          categoryId: a.getAttribute('data-toggle-name') || null,
          selected: /(^|\s)selected(\s|$)/.test(String(a.className || '')),
        })).filter((x) => x.name);
        tree.push({ group: g, count: items.length, selected: items.filter((x) => x.selected).map((x) => x.name), items: items.slice(0, 30) });
      }
    } catch { /* partial is fine */ }

    // Options-chain context: the page names its own underlying and frequency, so a chain page can
    // be attributed without guessing from the URL.
    const chainEl = document.querySelector('[data-testid="InstrumentTable.OptionsChainHeader.InstrumentName"]');
    const freqEl = document.querySelector('plus500-button-group[name="option-frequency"]');
    const chainFrequency = freqEl
      ? (() => { const c = freqEl.querySelector('[checked]'); return c ? clean(c.textContent).slice(0, 20) : null; })()
      : null;

    // --- the CONTRACT block: the sidebar spec of the SELECTED instrument --------
    // This IS the Phase 0 answer, and it needs no navigation and no click. The venue publishes the
    // entire contract spec of the selected instrument in the Info tab of the sidebar, already
    // loaded. The earlier probes missed it because the contract-metadata SWEEP is prose-based
    // (it looks for the words lot/contract/minimum/leverage/margin in text); the spec is not prose
    // — it is a 3-column stat box plus a definition/value list — so a zero from that sweep is NOT
    // evidence of absence. Established from the owner's dumps of Oil|Call 98.5|Oct and
    // Gold|Put 4225|Sep W3, both of which expose every field the mirror needs.
    //
    // Address by data-testid ONLY. The sidebar is Vue custom elements (plus500-list-data-item,
    // plus500-data-text) carrying hashed data-v-* scope attributes and no stable classes, so a
    // class-based selector here would rot on the venue's next deploy.
    const sidebar = document.querySelector('[data-testid="Sidebar.Content"]');
    // If the sidebar is not found, SAY WHY rather than leaving a null that gets explained by guesswork.
    // "The sidebar is collapsed" was my own guess on the first logged-in read and it was unverified —
    // the two real possibilities (element absent vs present-but-hidden) have different fixes, and so
    // does a renamed testid. Cheap to capture, and it stops the next null from being narrated.
    const sidebarDiag = {
      loadSidebarById: !!document.getElementById('load-sidebar'),
      sidebarContentTestid: !!sidebar,
      instrumentPanel: !!document.querySelector('.instrument-panel-cfd'),
      listDataItems: document.querySelectorAll('plus500-list-data-item').length,
      anySidebarTestids: [...document.querySelectorAll('[data-testid*="Sidebar"],[data-testid*="InstrumentPanelCfd"]')]
        .map((e) => e.getAttribute('data-testid')).slice(0, 25),
      wrapClass: (() => { const w = document.querySelector('.wrap'); return w ? short(clsOf(w), 120) : null; })(),
      sidebarClass: (() => { const s = document.querySelector('.sidebar'); return s ? short(clsOf(s), 120) : null; })(),
      // present-but-hidden is a DIFFERENT problem from absent: Vue removes it with v-if when closed
      visibility: (() => {
        const s = document.getElementById('load-sidebar');
        if (!s) return null;
        const cs = getComputedStyle(s);
        return { visibility: cs.visibility, opacity: cs.opacity, display: cs.display, inLayout: s.offsetParent !== null, childRect: s.getBoundingClientRect().height };
      })(),
      tabsRail: [...document.querySelectorAll('[data-testid^="InstrumentPanelCfd.Tabs"]')].map((e) => e.getAttribute('data-testid')).slice(0, 6),
    };
    const sPick = (id) => {
      const e = sidebar && sidebar.querySelector(`[data-testid="${id}"]`);
      return e ? short(e.textContent, 60) : null;
    };
    // Definition/value pairs. Margin, point value, strike, option type, expiry and next session are
    // each a list-data-item with slot="definition-item" and slot="value-item", so the LABEL comes
    // with the value instead of being assumed from column position.
    const listItems = sidebar ? [...sidebar.querySelectorAll('plus500-list-data-item')].map((li) => ({
      testid: li.getAttribute('data-testid') || null,
      label: short((li.querySelector('[slot="definition-item"]') || {}).textContent, 50),
      value: short((li.querySelector('[slot="value-item"]') || {}).textContent, 50),
    })).filter((x) => x.label || x.value) : [];

    const contract = sidebar ? {
      name: sPick('InstrumentHeader.InstrumentName'),
      symbol: sPick('InstrumentHeader.Symbol'),
      // The 3-column stat box. unitAmount is a MINIMUM trade size in venue units, NOT a contract
      // multiplier — the sub-value names the unit ("Options" here), so the unit is captured too.
      // This is the field the desk's sizing has never had: `size = equity*riskPct/stopDist` assumes
      // a floor of zero and a unit of one.
      unitAmount: sPick('sidebar.rates-and-values.column-0.value'),
      unitKind: sPick('sidebar.rates-and-values.column-0.sub-value'),
      // ★ 2026-09-28 (migration 045): WHICH WORD DOES THE VENUE USE FOR COLUMN-0?
      //
      // The value above is read by POSITION and its MEANING is still asserted in the comment two lines
      // up — the one field the desk enforces as a hard veto is the one field identified by where it sits
      // rather than by its own name. The venue publishes a LABELLED definition/value list separately
      // (`listItems`, built above from `plus500-list-data-item`), so the venue's own word is derivable by
      // EXACT MATCH and needs no guessed testid and no assumption about the sidebar's structure: find the
      // labelled pair whose VALUE is the same text as the stat box.
      //
      // ⚠ NULL MEANS "THE VENUE DOES NOT LABEL THIS FIELD", NEVER "no minimum". Both sides go through
      // `short(...)` with different budgets (60 for sPick, 50 for listItems), so the comparison is made on
      // a common prefix rather than on the raw strings — otherwise a long value would fail to match itself.
      unitAmountLabel: (() => {
        // ★★ 2026-10-27 — THE VENUE PUBLISHES THIS DIRECTLY, ONE SELECTOR AWAY, AND IT WAS NULL ON ALL 44 ROWS.
        //
        // Migration 045 added the column to hold THE VENUE'S OWN WORD for column-0. The lookup below matched a
        // `listItems` entry whose VALUE equalled the stat box — an elaborate route that CANNOT fire, because the
        // venue does not repeat the number in its labelled pair list. Measured on the live sidebar (Gold and
        // Soybeans, 2026-10-27): the stat box has a SIBLING with its own testid,
        // `sidebar.rates-and-values.column-0.label`, whose text is "Unit amount" on both.
        //
        // ⚠ WHAT THAT WORD SETTLES. The desk calls this a MINIMUM TRADE SIZE; the venue calls it a UNIT AMOUNT.
        // Those are different claims. Recording their word is what lets a later reader see that the ledger's
        // `minimum_trade_size` is OUR interpretation of their field rather than a term they use — which is exactly
        // the provenance this column exists for.
        //
        // ⚠ AND A CORRECTION TO MY OWN EARLIER READING: the UNIT word ("Troy Ounces", "Bushels") was never missing.
        // It comes from `column-0.sub-value` into `unitKind`, straight off the page, so the ledger's `valueUnit` does
        // carry the venue's own word. What was absent was the FIELD's name, not the unit's.
        const labelled = sPick('sidebar.rates-and-values.column-0.label');
        if (labelled != null) return labelled;
        // Fallback for a sidebar shape that predates the label testid. If it ever fires, the label is being inferred
        // from a coincidence rather than read, so it is kept SECOND and never preferred.
        const boxed = sPick('sidebar.rates-and-values.column-0.value');
        if (boxed == null) return null;
        const norm = (v) => String(v == null ? '' : v).trim().slice(0, 40);
        const hit = listItems.find((li) => li && li.label && norm(li.value) === norm(boxed));
        return hit ? hit.label : null;
      })(),
      leverage: sPick('sidebar.rates-and-values.column-1.value'),
      dynamicSpread: sPick('sidebar.rates-and-values.column-2.value'),
      pointValue: sPick('DetailsSidebar.rates-and-values.exchange-multiplier.value'),
      // Cross-field invariant available for free: initialMargin should equal 1/leverage
      // (20.00% <-> 1:5 on both dumps). Captured raw so the check can be made downstream.
      initialMargin: sPick('DetailsSidebar.margin.initial.value'),
      maintenanceMargin: sPick('DetailsSidebar.margin.maintenance.value'),
      // Options-only fields — null on a plain CFD. Their presence is itself the signal that this
      // instrument is an option with an EXPIRY, i.e. the venue will close it without the desk.
      strikePrice: sPick('DetailsSidebar.more-info.strike-price.value'),
      optionType: sPick('DetailsSidebar.more-info.option-type.value'),
      expiryDate: sPick('DetailsSidebar.availability.expiry-date.value'),
      nextSession: sPick('DetailsSidebar.availability.next-trading-hours.value'),
      fundingBuy: sPick('DetailsSidebar.more-info.premium-buy.value'),
      fundingSell: sPick('DetailsSidebar.more-info.premium-sell.value'),
      fundingTime: sPick('DetailsSidebar.more-info.premium-time.value'),
      // The venue's OWN market state. Worth recording against our session calendar: if they ever
      // disagree, the desk would be trying to trade a window the venue does not have.
      closedBanner: !!sidebar.querySelector('[data-testid="DetailsSidebar.market-closed-banner"]'),
      closedTitle: sPick('MarketClosedBanner.Title'),
      opensText: sPick('MarketClosedBanner.OpenText'),
      placeOrdersText: sPick('MarketClosedBanner.ShowPlaceOrders'),
      referenceUrl: (() => {
        const a = sidebar.querySelector('[data-testid="DetailsSidebar.instrument-info-link.external-link"]');
        return a ? String(a.getAttribute('href') || '').slice(0, 160) : null;
      })(),
      listItems,
    } : null;

    // Integrity check: the sidebar describes the SELECTED row, so the two names must agree. A
    // mismatch means we would be pairing a contract spec with the wrong instrument — silently. The
    // result is three-valued on purpose: null means UNTESTABLE (sidebar collapsed, or the page
    // rotated away from the row), which is not the same as a passing check.
    const selectedRow = rows.find((r) => r.selected) || null;
    const sidebarName = contract ? contract.name : null;
    const sidebarMatchesSelectedRow = (sidebarName && selectedRow && selectedRow.name)
      ? sidebarName === selectedRow.name
      : null;

    // Field inventory for the sidebar, mirroring fieldInventory for the rows: every testid the
    // sidebar actually carries, so Phase 1 discovers the schema instead of assuming it.
    const sidebarFields = sidebar
      ? Object.fromEntries([...sidebar.querySelectorAll('[data-testid]')]
        .map((e) => [e.getAttribute('data-testid'), short(e.textContent, 60)])
        .filter(([k, v]) => k && v).slice(0, 200))
      : null;

    // EVERY instrument on the page, not just the detailed sample above — this is the mirror's
    // unit of capture. The per-row attribute detail stays capped to keep the payload sane.
    const allNames = rowEls.map((el) => clean((el.querySelector('.name') || {}).textContent)).filter(Boolean).slice(0, 500);

    return {
      url: String(location.href).slice(0, 200),
      title: short(document.title, 120),
      tableFound: !!container,
      rowCount: rowEls.length,
      rows,
      allNames,
      categories,
      highlighted,
      categoryTree: tree,
      chain: { underlying: short(chainEl && chainEl.textContent, 40), frequency: chainFrequency },
      // The contract spec of the SELECTED instrument (null when the sidebar is collapsed or the
      // page has rotated — the desk's own pollers move it every 15-60s).
      contract,
      sidebarMatchesSelectedRow,
      sidebarFields,
      sidebarDiag,
      selectedRowTestid: selectedRow ? selectedRow.testid : null,
      perInstrument: {
        withId: rows.filter((r) => r.instrumentId).length,
        selected: rows.filter((r) => r.selected).length,
        // Raw counts, NOT an interpretation: the previous label here ("tradable") asserted a
        // meaning for data-no-trading that the owner's dumps disproved. See the note above.
        rateFlagFalse: rows.filter((r) => r.rateNoTrading === 'false').length,
        rateFlagTrue: rows.filter((r) => r.rateNoTrading === 'true').length,
        logoNoTrading: rows.filter((r) => r.logoNoTrading).length,
        watchlisted: rows.filter((r) => r.watchlisted === true).length,
      },
      fieldInventory,
      keyword: { textHits: [...new Set(textHits)], attrHits: [...new Set(attrHits)] },
      links: [...new Set(links)],
      panels: [...new Set(panels)],
    };
  });
}

// Persist EVERY observation, whichever path produced it. The button path previously returned JSON
// to the UI only, so the first real Phase 0 reading — 12 contract-metadata hits on
// /trade/oil---weekly — existed solely on screen and would have been lost on reload. One file per
// press, never overwritten, so repeated stops accumulate as evidence.
function recordObservation(o, label = '') {
  try {
    const fs = require('fs');
    const path = require('path');
    const dir = path.join(__dirname, '..', '..', 'temp', 'phase0-observations');
    const stamp = String(o.at || new Date().toISOString()).replace(/[:.]/g, '-');
    const slug = String(label || (o.url || '').replace(/^https?:\/\/[^/]+\//, '') || 'observation')
      .replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 50) || 'observation';
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${stamp}-${slug}.json`);
    fs.writeFileSync(file, JSON.stringify(o, null, 2), 'utf8');
    return file;
  } catch { return null; }
}

// THE ONE DELIBERATE INTERACTION, and why the original "no clicks" rule had to bend.
//
// Phase 0 was designed around the OPERATOR driving the page: the probe reads whatever they loaded.
// That holds while the operator can see this browser. They cannot — Plus500 is logged in in the
// desk's Chrome (profile trading\.chrome-profile, port 9224) while the operator works in VS Code's
// INTEGRATED BROWSER, which is a different process the desk cannot see. More importantly, the
// contract spec lives in the sidebar, and the sidebar only mounts when a row is selected: measured
// on /trade/gold---weekly, the element exists with height 611 but `.wrap` carries no `sidebar-open`
// class, so it is visibility:hidden with zero `plus500-list-data-item` nodes. Reading it therefore
// REQUIRES an interaction, and asking the operator to perform it blind is a worse contract than
// doing it here.
//
// So: ONE click, on the Info chevron of a chosen row, off by default, never navigating, and holding
// the same 'ticket' lock the order path uses — so it cannot interleave with a ticket. Nothing else
// on the page is touched. If the sidebar is already open this is a no-op.
async function openSidebarFor(page, which) {
  const clicked = await page.evaluate((want) => {
    const cls = (el) => String(el && el.className && el.className.baseVal != null ? el.className.baseVal : (el ? el.className : ''));
    const txt = (el) => String(el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
    const rows = [...document.querySelectorAll('[data-instrument-id]')];
    if (!rows.length) return { error: 'no_instrument_rows' };
    let row = null;
    if (want != null) row = rows.find((r) => r.getAttribute('data-instrument-id') === String(want)) || null;
    if (!row) row = rows.find((r) => /(^|\s)selected(\s|$)/.test(cls(r))) || rows[0];
    const targetName = txt(row.querySelector('.name'));
    const currentName = txt(document.querySelector('[data-testid="InstrumentHeader.InstrumentName"]'));
    // Rates are read HERE, at click time, not from an earlier snapshot of the page. The instrument
    // table is a VIRTUAL LIST, so rows below the fold have not rendered: their name and rate cells
    // come back empty. That produced 4 FALSE mismatches on the first full scan (rows 1116972-1116975
    // reported name "" while the sidebar named them correctly) and left 4 spread checks untestable.
    const rate = (sel) => { const e = row.querySelector(sel); return e ? txt(e) : ''; };
    const sell = rate('.button-sell [slot="value"]');
    const buy = rate('.button-buy [slot="value"]');
    // Skip the click ONLY if the sidebar is already showing the instrument we CAME FOR.
    // This must compare against the TARGET, not merely "some instrument is showing": the sidebar
    // stays open on whatever was read last, so a bare "is it open" test silently re-reads the
    // WRONG instrument and reports success. Hit immediately, on the first attempt to switch from
    // Gold spot (XAU) to the Gold 4225 put — the run reported contractSpec=YES with the spot spec.
    if (currentName && targetName && currentName === targetName) {
      return { alreadyOpen: true, name: currentName.slice(0, 60), sell, buy };
    }
    // The Info chevron is the documented door to the details sidebar; selecting the row alone does
    // NOT open it (that is exactly the state we measured: selected=1, sidebar-open absent).
    const btn = row.querySelector('[data-testid$=".Button.Info"]') || row.querySelector('.open-information');
    if (!btn) return { error: 'no_info_button', rowTestid: row.getAttribute('data-testid') };
    // In-page .click(): Playwright actionability TIMES OUT on these custom elements.
    btn.click();
    return {
      opened: true,
      rowTestid: row.getAttribute('data-testid'),
      instrumentId: row.getAttribute('data-instrument-id'),
      name: targetName.slice(0, 60),
      sell,
      buy,
      switchedFrom: currentName ? currentName.slice(0, 60) : null,
    };
  }, which === true ? null : which).catch((e) => ({ error: 'evaluate_failed: ' + String((e && e.message) || e) }));
  if (clicked.error) return clicked;
  if (clicked.alreadyOpen) return clicked;
  const t0 = Date.now();
  // The sidebar mounts asynchronously; poll rather than assume the click took effect.
  while (Date.now() - t0 < 15000) {
    const ready = await page.evaluate(() => {
      const n = document.querySelector('[data-testid="InstrumentHeader.InstrumentName"]');
      return !!(n && String(n.textContent || '').trim());
    }).catch(() => false);
    if (ready) return { ...clicked, sidebarReady: true, waitedMs: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ...clicked, sidebarReady: false, waitedMs: Date.now() - t0 };
}

// Walk EVERY instrument row on the loaded page and record each one's contract spec. This is the
// mirror's universe: identity, minimum trade size, leverage, spread, funding and (for options)
// strike/type/expiry, for every instrument the venue will show us on one page.
//
// WHY IT REUSES probeCurrentPage INSTEAD OF A LEANER READER: the scan must read the sidebar through
// EXACTLY the same code path as a single probe, or the two can silently disagree — which is how a
// wrong-instrument read got reported as success earlier in this file. Redundant page-level work per
// row is the cheaper cost.
//
// LOCK DURATION: this holds the 'ticket' lock for the whole walk (~1-3s per row), so `max` is capped
// by default. The order path waits up to 240s for that lock, so the scan delays a ticket rather than
// breaking it — but a large chain should not be scanned mid-session.
async function scanChain(page, { max = 25 } = {}) {
  const targets = await page.evaluate(() => {
    const txt = (el) => String(el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[data-instrument-id]')].map((el) => ({
      instrumentId: el.getAttribute('data-instrument-id'),
      testid: el.getAttribute('data-testid'),
      name: txt(el.querySelector('.name')),
      secondary: txt(el.querySelector('[data-testid$=".SecondaryName"]')),
      sell: txt(el.querySelector('.button-sell [slot="value"]')),
      buy: txt(el.querySelector('.button-buy [slot="value"]')),
      hasInfo: !!el.querySelector('[data-testid$=".Button.Info"]'),
    }));
  });

  const numOrNull = (s) => { const m = String(s == null ? '' : s).replace(/[,%]/g, '').match(/-?\d+(?:\.\d+)?/); return m ? parseFloat(m[0]) : null; };
  const items = [];
  for (const t of targets.slice(0, Math.max(1, max))) {
    const click = await openSidebarFor(page, t.instrumentId);
    const inv = await probeCurrentPage(page);
    const c = inv.contract || null;

    // The CLICK-TIME read wins over the pre-scan snapshot: the table is virtualised, so a row below
    // the fold has an empty name and empty rate cells at snapshot time (see openSidebarFor).
    const rowName = click.name || t.name;

    // CHECK 1 — the sidebar must describe the row we clicked. Without this the scan can silently
    // attribute one instrument's minimum size to another, which is the failure this whole file
    // exists to avoid.
    const matched = !!(c && c.name && rowName && c.name === rowName);

    // CHECK 2 — dynamicSpread is stated in PRICE UNITS, so it must equal the row's own buy - sell.
    // Verified by hand on two instruments (oils 3.93-3.81=0.12; gold put 14.05-13.24=0.81) before
    // being asserted here. Tolerance 0.015 covers 2dp rounding on a 4-figure price.
    const sell = numOrNull(click.sell || t.sell); const buy = numOrNull(click.buy || t.buy); const sp = c ? numOrNull(c.dynamicSpread) : null;
    const rowDiff = (sell != null && buy != null) ? Math.round((buy - sell) * 1000) / 1000 : null;
    const spreadCheck = (rowDiff != null && sp != null)
      ? { rowDiff, sidebarSpread: sp, ok: Math.abs(rowDiff - sp) <= 0.015 }
      : { rowDiff, sidebarSpread: sp, ok: null };

    // CHECK 3 — initial margin and leverage are two statements of one number (20.00% <-> 1:5), so a
    // disagreement means one of them was misread. Holds 3/3 on the instruments read by hand.
    const mg = c ? numOrNull(c.initialMargin) : null;
    const lv = c && c.leverage ? numOrNull(String(c.leverage).split(':').pop()) : null;
    const marginLeverageOk = (mg != null && lv) ? Math.abs(mg - (100 / lv)) <= 0.1 : null;

    items.push({
      instrumentId: t.instrumentId, testid: t.testid, name: rowName, secondary: t.secondary,
      sell, buy, hasInfo: t.hasInfo,
      click, contract: c, listItems: c ? c.listItems : null,
      matched, spreadCheck, marginLeverageOk,
      mismatch: matched ? null : { rowSays: rowName, sidebarSays: c ? c.name : null },
    });
  }

  // Aggregate the universe. This is the actual deliverable: what the venue exposes, by class.
  const withSpec = items.filter((x) => x.contract);
  const byUnitKind = {};
  for (const x of withSpec) {
    const k = x.contract.unitKind || '(unstated)';
    const u = numOrNull(x.contract.unitAmount);
    if (u == null) continue;
    if (!byUnitKind[k]) byUnitKind[k] = { count: 0, minUnit: u, maxUnit: u };
    byUnitKind[k].count += 1;
    byUnitKind[k].minUnit = Math.min(byUnitKind[k].minUnit, u);
    byUnitKind[k].maxUnit = Math.max(byUnitKind[k].maxUnit, u);
  }
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  return {
    url: String(page.url()).slice(0, 200),
    counts: { rowsOnPage: targets.length, scanned: items.length },
    checks: {
      matched: items.filter((x) => x.matched).length,
      spreadConsistent: items.filter((x) => x.spreadCheck && x.spreadCheck.ok === true).length,
      spreadUntestable: items.filter((x) => x.spreadCheck && x.spreadCheck.ok === null).length,
      marginLeverageConsistent: items.filter((x) => x.marginLeverageOk === true).length,
      totals: { scanned: items.length, withSpec: withSpec.length },
    },
    universe: {
      byUnitKind,
      options: withSpec.filter((x) => x.contract.optionType).length,
      plainCfds: withSpec.filter((x) => !x.contract.optionType).length,
      // Funding is per instrument AND per side; options carry none at all (0.0000% / `--`).
      withFunding: withSpec.filter((x) => x.contract.fundingBuy && !/^0\.0+%$/.test(x.contract.fundingBuy)).length,
      expiries: uniq(withSpec.map((x) => x.contract.expiryDate && x.contract.expiryDate !== '--' ? x.contract.expiryDate : null)),
      optionTypes: uniq(withSpec.map((x) => x.contract.optionType)),
      strikes: uniq(withSpec.map((x) => x.contract.strikePrice)).length,
    },
    mismatches: items.filter((x) => !x.matched).map((x) => ({ instrumentId: x.instrumentId, ...x.mismatch, click: x.click })),
    spreadDisagreements: items.filter((x) => x.spreadCheck && x.spreadCheck.ok === false).map((x) => ({ instrumentId: x.instrumentId, name: x.name, ...x.spreadCheck })),
    items,
  };
}

// Guards: a wake may be mid-decision and the bridge is shared; the order path holds the same
// 'ticket' lock, so a read can never land inside a ticket flow.
//
// ★ `symbol` (added 2026-09-14 for TRD-50): OPEN THE INSTRUMENT INSIDE THE LOCK, THEN READ IT.
//
// The two-call sequence `POST /watchlist/open` then `POST /instruments/probe` is a RACE, and it was
// observed losing it: after openInstrument confirmed it had landed on Geely Automobile
// ("Geely Automobile 2.92% Sell 16.53 Buy 16.65", via search), the very next probe read
// `url https://app.plus500.com/open-positions`, rowCount 0, contract null. The desk's own position
// mirror had moved the shared tab between the two requests, and nothing in either request held the
// page across the pair — pageLock is IN-PROCESS state, so a client cannot hold it between two HTTP
// calls by construction.
//
// The fix is not a longer sleep, it is to make the pair ONE operation under ONE lock. This is also
// the shape TRD-50 was written in ("for each watchlist symbol, POST /instruments/probe"), and it
// makes the probe the single place that knows how to put an instrument on screen and read it.
//
// `settings` is passed in by the route rather than re-read, so the probe cannot disagree with the
// caller about which selectors to use.
async function run({ force = false, label = '', select = false, scan = false, symbol = null, settings = null } = {}) {
  const waker = require('../agent/waker');
  if (!force && waker.status().inProgress) {
    return { skipped: 'wake_in_progress', hint: 'a wake is deciding and the bridge is in use — retry in a moment' };
  }
  const sessions = require('../agent/sessions');
  const market = sessions.calendarState(new Date());

  const pageLock = require('./pageLock');
  // Same lock name the order flow uses ('ticket'): a read must never interleave with a ticket.
  await pageLock.acquire('ticket', { waitMs: 60000 });
  try {
    // NOTE: newPage() returns the SHARED Plus500 tab — which is exactly what observational
    // capture wants. Never close it and never disconnect(); both kill the shared bridge.
    const page = await browser.newPage();

    // TRD-66 (2026-09-22): RECORD THE TRANSITION RATHER THAN INFER IT.
    //
    // The row: after ~6 per-symbol navigations `assertDemo` reads 0 chars of body text. The cause is already
    // diagnosed in webtrader.js — a DEAD RENDER of the shared tab after a navigation burst, with assertDemo,
    // isLoggedIn and bankChartBars each reporting their own failure for that one cause. What was never
    // recorded is WHERE the transition happens or WHICH of the three candidate causes it is, so the row asked
    // for exactly this: capture the page URL and body length BEFORE and AFTER each navigation.
    //
    // Three reads, because the three hypotheses need different evidence and one read cannot separate them:
    //   before    — the shared tab AS THIS REQUEST FOUND IT. If it is ALREADY blank (or on another route)
    //               when the request arrives, the loop did not blank it: a poller moved the tab out from
    //               under us, or the previous request left it dead. `blank on arrival` and `blanked by this
    //               request` are different faults and the original measurement could not tell them apart.
    //   afterOpen — what the navigation produced.
    //   after     — what the read left behind, i.e. the state the NEXT symbol inherits. A loop whose page
    //               degrades one step at a time shows up here as monotonically shrinking bodyLen.
    // Read-only: three `document.body.innerText.length` reads. No clicks, no navigation of their own.
    const readPageState = () => page.evaluate(() => ({
      url: String(location.href).slice(0, 200),
      bodyLen: document.body ? document.body.innerText.length : 0,
    })).catch((e) => ({ url: null, bodyLen: null, error: String(e.message || e).slice(0, 120) }));
    const pageBefore = await readPageState();

    // Open the requested instrument first, still holding the lock, so nothing can navigate the tab
    // away between the navigation and the read below.
    let opened = null;
    if (symbol) {
      const webtrader = require('./webtrader');
      opened = await webtrader.openInstrument(page, settings || {}, symbol)
        .then((r) => ({ ...r }))
        .catch((e) => ({ symbol, opened: false, error: String(e.message || e).slice(0, 160) }));
      // The ticket/sidebar mounts asynchronously after the chart title updates. Polled rather than
      // slept-through: a fixed sleep is what made the first attempt read a sidebar that was not
      // there yet, and a longer one is not a fix for that (see the note above).
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const ready = await page.evaluate(() => {
          const n = document.querySelector('[data-testid="InstrumentHeader.InstrumentName"]');
          return !!(n && String(n.textContent || '').trim());
        }).catch(() => false);
        if (ready) { opened.sidebarReady = true; break; }
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    // TRD-66: what the navigation produced, read BEFORE probeCurrentPage claims anything about the page.
    const pageAfterOpen = symbol ? await readPageState() : null;

    if (scan) {
      const res = await scanChain(page, { max: Number(scan) || 25 });
      const verdict = probeVerdict({
        mode: 'scan',
        rowsOnPage: res.counts.rowsOnPage,
        scanned: res.counts.scanned,
        // ⚠ `withSpec` lives at `checks.totals`, not at `totals` — the dispatch used to read the latter and got
        // `undefined` on every run, which read as "not applicable" rather than "field name wrong".
        withSpec: res.checks && res.checks.totals ? res.checks.totals.withSpec : null,
      });
      const out = {
        ok: verdict.ok,
        reason: verdict.reason,
        at: new Date().toISOString(),
        market,
        mode: 'scan',
        readOnly: `chain scan: up to ONE click per instrument (${res.counts.scanned} clicked); no navigation, no close, no disconnect`,
        ...res,
      };
      out.savedTo = recordObservation(out, label);
      return out;
    }
    const interaction = select ? await openSidebarFor(page, select) : null;
    const inv = await probeCurrentPage(page);
    // TRD-66: the state the NEXT request inherits. A loop degrading one step at a time shows as a shrinking
    // bodyLen here, which is the signature that separates "the SPA gives up after N navigations" from
    // "a poller stole the tab between two requests".
    const pageAfter = await readPageState();
    const verdict = probeVerdict({
      mode: 'probe',
      tableFound: inv.tableFound,
      contractExpected: !!(select || symbol),
      contractFound: !!inv.contract,
    });
    const out = {
      ok: verdict.ok,
      reason: verdict.reason,
      at: new Date().toISOString(),
      market,
      // TRD-66: the before/after evidence, so the transition point is recorded by the desk that caused it
      // rather than reconstructed afterwards from three separate failure messages.
      page: { before: pageBefore, afterOpen: pageAfterOpen, after: pageAfter },
      // Stated per run rather than as a blanket claim, so a report cannot imply the probe is
      // interaction-free when it was asked to click.
      readOnly: symbol
        ? 'ONE navigation (open the requested instrument) + ONE click (Info sidebar); no close, no disconnect'
        : (interaction
          ? 'ONE click (open the Info sidebar); no navigation, no close, no disconnect'
          : 'no navigation, no clicks, no close, no disconnect'),
      interaction,
      // Which instrument the run was ASKED for and whether it got there, so a report cannot be
      // read as a capture of `symbol` when the page held something else.
      requestedSymbol: symbol || null,
      opened,
      ...inv,
    };
    out.savedTo = recordObservation(out, label);
    return out;
  } finally {
    pageLock.release('ticket');
  }
}

module.exports = { run, probeCurrentPage, recordObservation, openSidebarFor, scanChain };
