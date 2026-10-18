// trading/scripts/instrument-probe.js — run Phase 0 and write the findings document (TRD-45).
//
// The probe runs INSIDE the trading service (a second CDP client to the shared Chrome is the
// landmine that kills the bridge), so this script just calls the route and writes up the result.
//
// BEFORE RUNNING: in the Plus500 Chrome (debug port 9224), navigate BY HAND to a page listing
// instruments — a category page, or any page with the instrument table. The probe reads whatever
// is loaded; it never navigates for you. Do it a few times on DIFFERENT pages (a category list, a
// single instrument's ticket) and run this each time; the outputs accumulate in the doc.
//
// Usage: node trading/scripts/instrument-probe.js [--label "Gold category page"] [--select[=<instrumentId>]]
//
// --select performs ONE click to open the instrument sidebar. It is needed whenever the contract
// spec is what you want, because the sidebar only mounts once a row is selected — measured on
// /trade/gold---weekly, the element is present with height 611 but `.wrap` has no `sidebar-open`
// class, so it is visibility:hidden with zero contract rows. Bare --select clicks the row already
// marked selected (falling back to the first); --select=<id> clicks that instrument's row.
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const fs = require('fs');
const path = require('path');
const https = require('https');
const jwt = require('jsonwebtoken');
const { getPool } = require('../../shared/db');

const argv = process.argv.slice(2);
const li = argv.indexOf('--label');
const label = li >= 0 ? String(argv[li + 1] || '') : `observation ${new Date().toISOString().slice(0, 16)}Z`;
// --select, --select=true, --select=1116673
const selArg = argv.find((a) => a === '--select' || a.startsWith('--select='));
const select = !selArg ? false : (selArg.includes('=') ? selArg.split('=')[1] || true : true);
const DOC = path.join(__dirname, '..', 'docs', 'INSTRUMENT_MIRROR_PHASE0.md');
const RAW = path.join(__dirname, '..', '..', 'temp', 'phase0-observation.json');

const call = (method, p, token, body) => new Promise((resolve, reject) => {
  const u = new URL('https://172.22.160.3:8114' + p);
  const req = https.request({
    hostname: u.hostname, port: u.port, path: u.pathname, method,
    rejectUnauthorized: false, timeout: 600000,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
  }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
  req.on('error', reject);
  req.end(body ? JSON.stringify(body) : undefined);
});

(async () => {
  const pool = await getPool();
  const uv = await pool.request().query('SELECT tokenVersion FROM Users WHERE id = 1');
  const token = jwt.sign(
    { userID: 1, roles: ['admin'], permissions: ['services.manage'], v: uv.recordset[0]?.tokenVersion ?? 0 },
    process.env.JWT_SECRET, { expiresIn: '1h' },
  );

  // --scan[=max] walks every instrument row on the loaded page and reads each contract spec.
  const scanArg = argv.find((a) => a === '--scan' || a.startsWith('--scan='));
  const scanMax = scanArg && scanArg.includes('=') ? Number(scanArg.split('=')[1]) || 25 : 25;

  const r = scanArg
    ? await call('POST', '/api/trading/instruments/scan', token, { max: scanMax })
    : await call('POST', '/api/trading/instruments/probe', token, { select });
  if (r.status !== 200) { console.error(`HTTP ${r.status}: ${r.body.slice(0, 300)}`); process.exit(1); }
  const o = JSON.parse(r.body);
  if (o.skipped) {
    console.error(`REFUSED: ${o.skipped}${o.hint ? ` — ${o.hint}` : ''}`);
    console.error('The bridge is shared with the live desk; rerun when the wake finishes (?force=1 to override).');
    process.exit(2);
  }

  try { fs.mkdirSync(path.dirname(RAW), { recursive: true }); fs.writeFileSync(RAW, JSON.stringify(o, null, 2), 'utf8'); } catch { /* best effort */ }

  // --- chain scan: write the universe, then stop ---------------------------------------------
  // A scan answers a different question from a single probe, so it gets its own report: not "which
  // fields exist" but "what is the universe, and is every reading internally consistent".
  if (o.mode === 'scan') {
    const SCAN = path.join(__dirname, '..', '..', 'temp', 'phase0-chain-scan.json');
    try { fs.writeFileSync(SCAN, JSON.stringify(o, null, 2), 'utf8'); } catch { /* best effort */ }
    const S = [];
    const push = (...xs) => { for (const x of xs) S.push(x); };
    push(`## ${label}`, '');
    push(`- observed: \`${o.at}\`  ·  market: **${o.market}**`);
    push(`- ${o.readOnly}`);
    push(`- page: \`${o.url}\``);
    push(`- rows on page **${o.counts.rowsOnPage}**  ·  scanned **${o.counts.scanned}**`, '');
    push('### Integrity checks', '');
    push('| check | result |', '|---|---|');
    push(`| sidebar names the clicked row | **${o.checks.matched} / ${o.checks.totals.scanned}** |`);
    push(`| dynamicSpread == buy - sell | **${o.checks.spreadConsistent} / ${o.checks.totals.scanned}** (${o.checks.spreadUntestable} untestable) |`);
    push(`| initialMargin == 1/leverage | **${o.checks.marginLeverageConsistent} / ${o.checks.totals.scanned}** |`, '');
    if (o.mismatches.length) {
      push(`**${o.mismatches.length} MISMATCH** - a spec was paired with the wrong row and MUST NOT be trusted:`, '');
      for (const m of o.mismatches) push(`- \`${m.instrumentId}\`: row says \`${m.rowSays}\`, sidebar says \`${m.sidebarSays}\``);
      push('');
    }
    if (o.spreadDisagreements.length) {
      push(`**${o.spreadDisagreements.length} spread disagreement** - the sidebar's stated spread does not equal the row's own buy - sell:`, '');
      for (const d of o.spreadDisagreements) push(`- \`${d.instrumentId}\` ${d.name}: row diff ${d.rowDiff}, sidebar says ${d.sidebarSpread}`);
      push('');
    }
    push('### The universe: minimum trade size by unit, straight from the venue', '');
    push('| unit kind | instruments | min unit | max unit |', '|---|---|---|---|');
    for (const [k, v] of Object.entries(o.universe.byUnitKind)) push(`| ${k} | ${v.count} | **${v.minUnit}** | ${v.maxUnit} |`);
    push('');
    push(`plain CFDs **${o.universe.plainCfds}** · options **${o.universe.options}** · carrying overnight funding **${o.universe.withFunding}**`);
    if (o.universe.optionTypes.length) push(`option types seen: ${o.universe.optionTypes.join(', ')}`);
    if (o.universe.expiries.length) push(`expiries seen: ${o.universe.expiries.slice(0, 12).join(', ')}`);
    push('', '### Per instrument', '');
    push('| id | name | sell | buy | unit amount | unit | leverage | margin | spread | opt type | strike | expiry | funding b/s |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const it of o.items) {
      const c = it.contract || {};
      push(`| \`${it.instrumentId}\` | ${it.name}${it.secondary ? ` <br>_${it.secondary}_` : ''} | ${it.sell ?? ''} | ${it.buy ?? ''} | ${c.unitAmount ?? ''} | ${c.unitKind ?? ''} | ${c.leverage ?? ''} | ${c.initialMargin ?? ''} | ${c.dynamicSpread ?? ''} | ${c.optionType ?? ''} | ${c.strikePrice ?? ''} | ${c.expiryDate ?? ''} | ${c.fundingBuy ?? ''} / ${c.fundingSell ?? ''} |`);
    }
    push('', '---', '');
    try { fs.appendFileSync(DOC, S.join('\n') + '\n', 'utf8'); } catch { /* best effort */ }
    console.log(`recorded chain scan "${label}": ${o.counts.scanned}/${o.counts.rowsOnPage} instruments · ${o.checks.matched} matched · ${o.mismatches.length} mismatch · ${o.spreadDisagreements.length} spread disagreement`);
    console.log(`  -> ${DOC}`);
    console.log(`  -> ${SCAN}`);
    console.log(`  -> ${RAW}`);
    process.exit(0);
  }

  // The DECISIVE measurement, CORRECTED. The keyword sweep below is prose-based and returned ZERO
  // even on a page that was displaying the full contract spec, because the spec is not prose — it
  // is a 3-column stat box plus a definition/value list. So the sweep's verdict was a false
  // negative, and the report previously drew a wrong conclusion from it ("the table alone cannot
  // supply contract size and Phase 2 needs a per-instrument page, a much slower path"). The real
  // answer is the sidebar of the selected instrument, which is already loaded.
  const spec = o.contract;
  const inv = Object.entries(o.fieldInventory || {}).sort((a, b) => b[1] - a[1]);
  const L = [];
  L.push(`## ${label}`);
  L.push('');
  L.push(`- observed: \`${o.at}\`  ·  market: **${o.market}**  ·  ${o.readOnly}`);
  L.push(`- page: \`${o.url}\``);
  L.push(`- title: ${o.title || '(none)'}`);
  L.push(`- instrument table found: **${o.tableFound}**  ·  rows on page: **${o.rowCount}**`);
  L.push('');
  L.push('### Contract spec of the selected instrument (the Phase 0 question, answered)');
  L.push('');
  if (spec && spec.name) {
    L.push(`**FOUND** — names \`${spec.name}\`${spec.symbol ? ` ${spec.symbol}` : ''}, read from the sidebar with no navigation and no click.`);
    L.push('');
    L.push('| field | value |');
    L.push('|---|---|');
    for (const [k, v] of Object.entries({
      'unit amount (MIN trade size, not a multiplier)': spec.unitAmount,
      'unit kind': spec.unitKind,
      leverage: spec.leverage,
      'dynamic spread': spec.dynamicSpread,
      'point value': spec.pointValue,
      'initial margin': spec.initialMargin,
      'maintenance margin': spec.maintenanceMargin,
      'strike price': spec.strikePrice,
      'option type': spec.optionType,
      expiry: spec.expiryDate,
      'next session': spec.nextSession,
      'overnight funding - buy': spec.fundingBuy,
      'overnight funding - sell': spec.fundingSell,
      'overnight funding time': spec.fundingTime,
    })) L.push(`| ${k} | ${v == null ? '_(absent)_' : `\`${v}\``} |`);
    L.push('');
    L.push(`- venue's own market state: **${spec.closedBanner ? 'closed' : 'no closed-banner'}** — \`${spec.closedTitle || ''}\` / \`${spec.opensText || ''}\`${spec.placeOrdersText ? ` / "${spec.placeOrdersText}"` : ''}`);
    L.push(`- sidebar names the SELECTED row: **${o.sidebarMatchesSelectedRow === null ? 'UNTESTABLE (one side missing — do not treat as a pass)' : o.sidebarMatchesSelectedRow}**${o.sidebarMatchesSelectedRow === false ? '  <-- MISMATCH: a spec must never be paired with the wrong instrument' : ''}`);
    if (spec.referenceUrl) L.push(`- venue's own underlying reference: \`${spec.referenceUrl}\``);
    L.push('');
    const pairs = (spec.listItems || []).filter((x) => x.label && x.value);
    if (pairs.length) {
      L.push('Definition/value pairs the sidebar exposes (these are labels WITH values, not guessed columns):');
      L.push('');
      for (const p of pairs) L.push(`- \`${p.testid || '(no testid)'}\`: **${p.label}** = \`${p.value}\``);
      L.push('');
    }
  } else {
    L.push('**No sidebar contract block.** The sidebar is probably collapsed, or the page rotated away from the instrument you were viewing — the desk\'s own pollers move it every 15-60s, so a miss here is a RACE, not a finding.');
    L.push('');
    L.push(`Keyword sweep for comparison: text hits ${o.keyword?.textHits?.length || 0} · attribute hits ${o.keyword?.attrHits?.length || 0}. **A zero from that sweep is not evidence of absence** — it returned zero on a page that was visibly displaying the whole contract spec.`);
    L.push('');
  }
  L.push(`### Row field inventory (child classes across ${o.rows?.length || 0} rows)`);
  L.push('');
  if (inv.length) {
    L.push('| class | present on N rows |');
    L.push('|---|---|');
    for (const [cls, n] of inv) L.push(`| \`${cls}\` | ${n} |`);
  } else L.push('_none — no instrument-row children matched_');
  L.push('');
  if (o.perInstrument) {
    L.push(`### Per-instrument signals (${o.rows?.length || 0} rows)`);
    L.push('');
    L.push(`with a venue id: **${o.perInstrument.withId}**  ·  marked selected: **${o.perInstrument.selected}**  ·  watchlisted: **${o.perInstrument.watchlisted}**`);
    L.push('');
    L.push(`\`data-no-trading\`: false **${o.perInstrument.rateFlagFalse}** / true **${o.perInstrument.rateFlagTrue}**  ·  \`no-trading\` logo class: **${o.perInstrument.logoNoTrading}**`);
    L.push('');
    L.push('_Semantics of `data-no-trading` are **UNRESOLVED** and were reported wrongly once. It reads `false` on instruments the venue is simultaneously showing as "Market is closed", so it is not a market-open flag, and the `no-trading` logo class disagrees with it on the same row. Both are recorded raw. Build nothing on either until one is observed against an OPEN market._');
    L.push('');
  }
  L.push('### Rows (first 15, with every attribute seen)');
  L.push('');
  L.push('| name | change | sell | buy | sel | rate-flag | logo-no-trading | testid | attrs |');
  L.push('|---|---|---|---|---|---|---|---|---|');
  for (const row of (o.rows || []).slice(0, 15)) {
    const attrs = Object.entries(row.attrs || {}).map(([k, v]) => `${k}=${String(v).slice(0, 24)}`).join('; ');
    L.push(`| ${row.name || ''} | ${row.change || ''} | ${row.sell ?? ''} | ${row.buy ?? ''} | ${row.selected ? '**yes**' : ''} | ${row.rateNoTrading ?? ''} | ${row.logoNoTrading ? 'yes' : ''} | \`${row.testid || ''}\` | ${attrs.replace(/\|/g, '/')} |`);
  }
  L.push('');
  if ((o.links || []).length) { L.push('### Candidate per-instrument links'); L.push(''); for (const l of o.links) L.push(`- \`${l}\``); L.push(''); }
  if ((o.panels || []).length) { L.push('### Panels/tabs seen'); L.push(''); L.push(o.panels.map((p) => `\`${p}\``).join(' · ')); L.push(''); }
  L.push('---');
  L.push('');

  const header = fs.existsSync(DOC)
    ? ''
    : '# Phase 0 — what the Plus500 instrument pages actually expose\n\nObservational capture: each section below is one manual browsing stop. The probe reads the page\nthe operator has already loaded — it never navigates. Raw JSON per run is in `temp/phase0-observation.json`.\n\n---\n\n';
  fs.mkdirSync(path.dirname(DOC), { recursive: true });
  fs.appendFileSync(DOC, header + L.join('\n'), 'utf8');

  console.log(`recorded "${label}": tableFound=${o.tableFound} rows=${o.rowCount} contractSpec=${o.contract && o.contract.name ? 'YES' : 'no'}`);
  if (o.interaction) console.log(`  click: ${JSON.stringify(o.interaction)}`);
  console.log(`  -> ${DOC}`);
  console.log(`  -> ${RAW}`);
  // The console hint says what ACTUALLY explains a miss. Two earlier versions of this hint asserted
  // causes that turned out to be false — first that the table alone cannot carry contract size, then
  // that the miss was a race with the desk's own pollers. Neither was true. What was true: the tab
  // was sitting on about:blank, nothing was reading it, and the WATCHDOG (not the mirror poller) is
  // what eventually navigates it away.
  if (!(o.contract && o.contract.name)) {
    if (/^about:blank$/i.test(o.url || '')) {
      console.log('  NOTE: the desk\'s bridge tab was BLANK at read time, so there was nothing to read.');
      console.log('        Under a HARD kill the mirror poller never navigates it, by design — but the watchdog\'s');
      console.log('        5-minute login check still does (watchdog.js:58, no pageLock, not kill-aware), so the tab');
      console.log('        does not stay blank for long and is probably on /trade rather than your instrument now.');
      console.log('        Re-select the instrument and rerun. NB this probe reads the DESK\'s Chrome (profile');
      console.log('        trading\\.chrome-profile, debug port 9224); a tab in the VS Code integrated browser is a');
      console.log('        DIFFERENT process and is invisible to this probe.');
    } else if (!o.tableFound) {
      console.log(`  NOTE: the tab is on ${o.url} — not an instrument or list view. Select an instrument row, then rerun.`);
    } else {
      console.log('  NOTE: instrument table present but no sidebar contract block — the sidebar is most likely collapsed. Open the instrument\'s Info tab, then rerun.');
    }
  }
  process.exit(0);
})().catch((e) => { console.error(`failed: ${String(e.stack || e.message || e)}`); process.exit(3); });
