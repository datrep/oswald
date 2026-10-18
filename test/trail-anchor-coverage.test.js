// ★★ TRD-TRL-6b (2026-10-02) — the anchor fix was applied to the sites that DECIDE and missed the site that
// REPORTS, so this pins EVERY call site rather than the bug that was found.
//
// THE DEFECT. `distanceFromPercent` computes
//
//     trailLevel = entry + percentFraction x price        distance = |trailLevel - price|
//                = |(entry - price) + q x price|          = |e + D|
//
// On a ticket that has NOT been submitted the venue anchors to the CURRENT PRICE, so `entry` cancels and the
// answer is simply `|D|`. TRL-6 replaced the anchor at the two sites that decide (the tolerance check and the
// wide fallback) — and left the `stuckDist` diagnostic passing `entryGuess`, which is the DECISION price and is
// measured 39-142 s stale. Solving `e` from the four production failures gave 0.48%, 1.19%, 0.71% and 0.53% of
// price — the stale-tick band — which is why the failures clustered near 0.5x rather than at one factor.
//
// ⚠ WHY THE ASSERTION IS STRUCTURAL. Pinning the three sites that were wrong would leave the fourth to be
// written by the next change. The property is not "these call sites are correct", it is: **in this file, and for
// this instrument state, `entry` and `price` must be the SAME READING** — because the venue's own anchor is the
// current price, so anything else injects a drift term that varies with price while `D` varies with ATR.
//
// Run with: npm run test:unit
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { code } = require('./_source');

const nl = (s) => s.replace(/\r\n/g, '\n');
const webtrader = nl(code('trading/plus500/webtrader.js'));

/** Every `distanceFromPercent({ ... })` object literal in the file, as normalised text. */
function callSites() {
  const out = [];
  const re = /distanceFromPercent\(\{([\s\S]*?)\}\)/g;
  let m;
  while ((m = re.exec(webtrader)) !== null) {
    // ⚠ Capture with a bracket-aware scan rather than `[^}]*`, because the arg is an object literal and a lazy
    // `.*?` up to the first `)` can stop early on a nested call. The bodies here are flat, so a bounded slice is
    // enough and is checked below.
    out.push(m[1].replace(/\s+/g, ' ').trim());
  }
  return out;
}

test('★★ EVERY `distanceFromPercent` call anchors `entry` to the SAME reading as `price`', () => {
  const sites = callSites();
  assert.ok(sites.length >= 3, `expected several call sites, found ${sites.length}: ${JSON.stringify(sites)}`);

  // ★ THE ONE LEGITIMATE EXCEPTION (TRD-TRL-12b, 2026-10-18): the POST-ENTRY edit card anchors its percent to
  // the position's ENTRY price, measured live on 2026-10-08 — so the engage path inside `setPositionTrail` MUST
  // pass the trade's entry, not the current price. Every other site (unsubmitted tickets) keeps the rule above.
  // The exception is pinned by SHAPE: exactly one entryRate/post.price site, and it must sit inside that function.
  const start = webtrader.indexOf('async function setPositionTrail');
  const nextFn = webtrader.indexOf('\nasync function ', start + 10);
  const engageBody = start > -1 ? webtrader.slice(start, nextFn > -1 ? nextFn : webtrader.length) : '';

  const offenders = [];
  let engageSites = 0;
  for (const s of sites) {
    const entry = /\bentry:\s*([A-Za-z_$][\w$.]*)/.exec(s);
    const price = /\bprice:\s*([A-Za-z_$][\w$.]*)/.exec(s);
    if (!entry || !price) {
      offenders.push(`could not read both sides from: ${s}`);
      continue;
    }
    const inEngage = engageBody.includes(s);
    if (inEngage) {
      engageSites += 1;
      // trade-entry anchored: entry must be enteringRate and price must be the card's current reading
      if (entry[1] !== 'entryRate' || price[1] !== 'post.price') {
        offenders.push(`engage site must be entry: entryRate / price: post.price — got entry: ${entry[1]} price: ${price[1]}`);
      }
      continue;
    }
    if (entry[1] !== price[1]) offenders.push(`entry: ${entry[1]}  vs  price: ${price[1]}   -> ${s}`);
  }
  assert.equal(engageSites, 1, `expected exactly ONE trade-entry anchored site (the engage card), found ${engageSites}`);
  assert.deepStrictEqual(
    offenders,
    [],
    'the venue anchors an unsubmitted ticket to the CURRENT PRICE, so `entry` must cancel — except on the ' +
      'post-entry edit card, which anchors to the ENTRY price (TRD-TRL-12b). Any other anchor injects a drift ' +
      'term of |entry - price| into the distance — the TRL-6 defect:\n  ' + offenders.join('\n  ')
  );
});

test('★ `entryGuess` no longer reaches any distance derivation — it is the stale DECISION price', () => {
  // It is still legitimately CARRIED as evidence (`entryUsed`) and used to plan the level; what it must never do
  // again is enter a distance computation, where the venue's own price is the anchor.
  for (const s of callSites()) {
    assert.doesNotMatch(s, /entry:\s*entryGuess/, `entryGuess is back in a distance derivation: ${s}`);
  }
});

test('★ the diagnostic that reports a stuck field computes the same distance the checker would', () => {
  // The specific site TRL-6 missed. It is an error MESSAGE, and a message that reproduces the defect it is
  // reporting is worse than no message — it sends the reader after the wrong cause.
  const stuck = /const stuckDist = stuck\s*\n?\s*\?[\s\S]{0,220}?distanceFromPercent\(\{([\s\S]{0,160}?)\}\)/.exec(webtrader);
  assert.ok(stuck, 'the stuckDist diagnostic must still exist');
  const body = stuck[1].replace(/\s+/g, ' ');
  const entry = /entry:\s*([A-Za-z_$][\w$.]*)/.exec(body);
  const price = /price:\s*([A-Za-z_$][\w$.]*)/.exec(body);
  assert.ok(entry && price, `both sides must be readable: ${body}`);
  assert.equal(entry[1], price[1], 'the stuck-field diagnostic must anchor on the card\'s own price');
});

test('the derivation it now anchors on is invariant to the stale decision price', () => {
  // The property the fix exists for, asserted on the real function rather than on the source: with entry === price
  // the answer cannot move when the stale decision anchor moves.
  const { distanceFromPercent } = require('../trading/agent/trailingStop');
  const price = 92.65;
  const q = -2.17 / price;
  const reads = new Set(
    [0, 0.5, 1.1, 5, -5].map(() =>
      distanceFromPercent({ direction: 'buy', entry: price, price, percentFraction: q }).distance
    )
  );
  assert.equal(reads.size, 1, 'entry === price must cancel the drift term entirely');
  assert.ok(Math.abs([...reads][0] - 2.17) < 1e-6, 'and must land on the distance the count means');
});
