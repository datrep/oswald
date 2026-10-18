// trading/agent/stopCoverage.js — TRD-43: WHY A MISSING STOP IS NOT ONE FACT.
//
// THE FINDING (2026-09-14). 11 of the desk's 25 closed trades carry no `stopPrice`, which makes
// them invisible to every R-based metric: `expectancy.rMultiple` returns null, `analytics`
// reports them as one `rExcluded` count, and the `risk_unit` field contract can say nothing
// about them. A single count presents that as ONE phenomenon. It is TWO, and only one of them
// is a defect:
//
//   mirrored_unmeasured  origin='venue'. The desk NEVER OPENED the position — `executor.reconcile`
//                        adopted it from Plus500's position list. The desk never placed a stop,
//                        so it has no stop to record. Structurally unmeasurable, NOT a control
//                        failure. It is also NOT BACKFILLABLE: the venue position rows the
//                        connector reads expose Type/Direction/Amount/NetPL/CurrentRate/OpenRate
//                        (webtrader.js:303) and no stop column, and all of these positions are
//                        closed, so the level is simply gone.
//
//   mirrored_traded      ★ TRD-RSK-9 (2026-09-28). origin='venue', no stop, AND THE DESK CLOSED IT
//                        (`closePriceSource='fill'`, whose own definition is "the desk closed it").
//                        The paragraph above rests on "the desk NEVER OPENED the position" — and that
//                        is read off `origin`, a field the adopting branch WRITES ITSELF. The premise
//                        is therefore self-certified, and on 2026-09-28 the desk was caught closing
//                        positions it had labelled not-its-own. A position the desk closes is a
//                        position the desk MANAGED, so this is a control failure after all. See
//                        `deskClosed` for the measurement that split the class in two.
//
//   missing_stop         origin='agent' | 'manual'. The DESK OPENED IT and recorded no risk.
//                        This IS a control failure. The desk's entire risk framework divides by
//                        |open − stop| × size, so a desk-opened position with no stop is an
//                        unmeasured risk position, not a position with zero risk. It must be
//                        counted as a DEFECT — surfaced and alerted on — rather than absorbed
//                        into "not in the sample".
//
//   zero_distance        A stop exists but sits at the fill, so |open − stop| = 0 and the R is
//                        still undefined. Same effect, different cause. Kept separate so nobody
//                        goes hunting for a field that is in fact populated.
//
//   measured             A usable stop. The only state an R-based test may consume.
//
// THE CAUSE OF THE 6 DESK-OPENED ROWS (drafted 2026-09-14): the day-one seed. Ids 3, 5, 6, 7, 9
// and 10 were opened 2026-09-08 10:27–10:33 and 2026-09-09, all BEFORE `exitLevels.entryLimits`
// existed — the first stopped agent entry is id 13 at 2026-09-10 03:27. They are historical and
// unfixable, and the point of this module is that the desk can now TELL that about them, per row,
// instead of printing "11 excluded" and moving on.
//
// WHY THIS IS NOT FOLDED INTO expectancy.js: `rMultiple` answers "is there a usable R". This
// answers "if not, whose fault is it", which depends on `origin` — a provenance field the pure
// statistics layer deliberately knows nothing about.
'use strict';

const store = require('../store');
const { num } = require('./expectancy');

// Reasons. Exported so consumers (selfHealth, analytics, tests) compare against constants
// instead of retyping string literals that can silently drift apart.
const REASON = {
  MEASURED: 'measured',
  MIRRORED: 'mirrored_unmeasured',
  MIRRORED_TRADED: 'mirrored_traded',
  MISSING: 'missing_stop',
  ZERO: 'zero_distance',
  NOT_CLOSED: 'not_closed',
};

// The reasons that mean "a desk decision produced an unmeasurable position".
//
// `MIRRORED_TRADED` belongs HERE and not with `MIRRORED`, and the distinction is the whole point of the
// split: the desk CLOSED that position, which is a decision about a position it held. Its risk was not
// somebody else's — it was the desk's, unmeasured, while its execution layer acted on it.
const DEFECTS = [REASON.MISSING, REASON.ZERO, REASON.MIRRORED_TRADED];

// The desk's own rows default to 'agent' — the same default `executor.openTrade` applies when it
// writes the row (`origin || 'agent'`) and the same reading it uses when deciding which rows the
// position cap guards. An absent origin is therefore a desk-opened row, which is the
// conservative direction: it makes an unattributed row a defect rather than letting it pass as
// somebody else's position.
function isDeskOpened(origin) {
  const o = origin == null || origin === '' ? 'agent' : String(origin).trim();
  return o !== 'venue';
}

// The realised stop distance. null = no level recorded; 0 = a level recorded AT the fill.
function stopDistance(t) {
  if (!t) return null;
  const open = num(t.openPrice);
  const stop = num(t.stopPrice);
  if (![open, stop].every(Number.isFinite)) return null;
  const d = Math.abs(open - stop);
  return d > 0 ? d : 0;
}

// ★ TRD-RSK-9 (2026-09-28): DID THE DESK CLOSE THIS POSITION ITSELF?
//
// THE MEASUREMENT. Of the 5 rows in the mirrored class (`origin='venue'` since the levels epoch), FOUR
// carry the desk's own close. Two of them also carry the machine-readable mark that makes this a rule
// rather than a note-matching hack:
//
//   #1111 Sugar         2026-09-28T07:31:10Z  closePriceSource='fill'   trade_closed actor system:executor
//   #1115 Arabica Coffee 2026-09-28T08:15:54Z closePriceSource='fill'   trade_closed actor system:executor
//   #15  Silver / #1034 Gold                  closePriceSource=null     note 'executor close' (pre-column)
//   #1114 Arabica Coffee                     closePriceSource='venue_rate'  — the venue closed this one
//
// So the class the module above calls "structurally unmeasurable, NOT a control failure" contains
// positions the desk opened, held, and closed. Worse, in the same window the position-review loop
// reviewed 1108 / 1112 / 1113 / 1099 and never these — the desk's judgment layer could not see them
// while its execution layer traded them.
//
// WHY THE COLUMN AND NOT THE NOTE. `closePriceSource === 'fill'` is set by the desk's own close path
// (`executor.js`, `CLOSE_PRICE_SOURCE.fill`, defined as "the desk closed it"). `note` is free text that
// TRD-11's phantom-upgrade path OVERWRITES on a later cycle, so a classifier keyed on it would be built
// on a field another branch rewrites. THE PRICE OF THAT CHOICE, stated so it is not mistaken for full
// coverage: this test only sees rows closed after the column was populated, so #15 and #1034 are counted
// as `mirrored_unmeasured` even though their notes say otherwise. A rule that is knowably narrow beats
// one whose input can be rewritten underneath it.
function deskClosed(t) {
  return !!t && String(t.closePriceSource || '').trim() === 'fill';
}

function classify(t) {
  if (!t || t.closeAt == null || (t.status != null && t.status !== 'closed')) return REASON.NOT_CLOSED;
  const d = stopDistance(t);
  if (d == null) {
    if (isDeskOpened(t.origin)) return REASON.MISSING;
    return deskClosed(t) ? REASON.MIRRORED_TRADED : REASON.MIRRORED;
  }
  if (d === 0) return REASON.ZERO;
  return REASON.MEASURED;
}

// Aggregate. `defects` is the actionable list — it is the whole point of the module, because
// "11 excluded" cannot be acted on and "6 desk-opened positions with no declared risk" can.
function summarise(trades) {
  const rows = Array.isArray(trades) ? trades : [];
  const counts = { measured: 0, mirrored_unmeasured: 0, mirrored_traded: 0, missing_stop: 0, zero_distance: 0, not_closed: 0 };
  const defects = [];
  const adverse = [];

  for (const t of rows) {
    const reason = classify(t);
    counts[reason] += 1;
    if (!DEFECTS.includes(reason)) continue;
    const mae = num(t.maePct);
    defects.push({
      id: t.id,
      symbol: t.symbol,
      origin: t.origin == null || t.origin === '' ? 'agent' : String(t.origin),
      reason,
      // The ENTRY time is what the epoch is about: the question is which order path opened it,
      // not when it happened to close. A trade opened before the epoch and closed after it is
      // still a pre-epoch entry.
      openedAt: t.openAt || null,
      at: t.closeAt || null,
      size: num(t.size),
      // The risk of a defect row is not zero — it is UNKNOWN, and only the adverse excursion was
      // recorded. Carry it so the hole has a size instead of being a bare null.
      maePct: Number.isFinite(mae) ? mae : null,
    });
    if (Number.isFinite(mae)) adverse.push(mae);
  }

  const closed = rows.length - counts.not_closed;
  return {
    total: rows.length,
    closed,
    ...counts,
    // One decimal: the difference between 56.0% and 56.4% coverage is not meaningful at n=25, and
    // a rounded percentage invites the reader to treat it as a measurement.
    coveragePct: closed ? Math.round((counts.measured / closed) * 1000) / 10 : null,
    defects,
    defectCount: defects.length,
    // Worst recorded adverse excursion among the defect rows. A percentage of entry, so it is
    // comparable across symbols and can be read as "the worst this unmeasured risk actually got".
    worstAdversePct: adverse.length ? Math.round(Math.min(...adverse) * 100) / 100 : null,
    // Stated explicitly, and asserted by a test, so nobody "helpfully" backfills a number that was
    // never recorded: neither source of a missing stop leaves a recoverable level.
    backfillable: 0,
  };
}

// THE WINDOWING IS THE DESIGN, and recency alone is not enough. A trailing time window cannot
// tell "the desk opened an unmeasured position yesterday" from "the desk's entire history is
// three days long": on a young ledger EVERY row is inside the last 7 days, so the check would
// report a live failure, then silently heal as the rows aged out — an alert that resolves itself
// is an alert that was never believed.
//
// The honest discriminator is not a time window, it is the EPOCH: the date the desk first became
// CAPABLE of recording levels (`exitLevels.entryLimits`). Before it, a stopless row is fully
// explained by history and nobody's bug. After it, a desk-opened row with no stop is a live
// control failure and must be red.
//
// The date is OBSERVED, not assumed: the first desk-opened trade carrying levels is id 13 (turtle,
// Gold) at 2026-09-10T03:27:21Z, and everything opened before it — including id 5, an agent row
// from 2026-09-08 — has none. If the epoch is ever wrong, the symptom is a clearly-labelled
// historical row being called live, which is visible rather than silent.
const LEVELS_EPOCH = '2026-09-10T00:00:00Z';

// Accepts either a raw trade (openAt) or a defect row (openedAt), so the same rule applies to
// both without the caller having to know which shape it holds.
function openedAfter(t, iso) {
  const at = t ? (t.openAt != null ? t.openAt : t.openedAt) : null;
  return at != null && new Date(at).getTime() >= new Date(iso).getTime();
}

function verdict(all, recent, { epoch = LEVELS_EPOCH, recentDays = 7 } = {}) {
  const A = all || summarise([]);
  // A defect whose position was OPENED after the epoch is a live failure: the desk had the ability
  // to record a risk and did not. Split by the defect's own entry time, not by any window.
  const live = A.defects.filter((d) => openedAfter(d, epoch));
  if (live.length) {
    const names = live.slice(0, 3).map((d) => `${d.symbol} (${d.origin})`).join(' · ');
    return {
      status: 'bad',
      // NOT "desk-opened". A `mirrored_traded` row arrives here with `origin='venue'`, and printing
      // "desk-opened … (venue)" beside each other made the row's own message contradict itself — which is
      // how a correct red gets read as a bug and ignored. "the DESK was trading" is true of both reasons
      // that reach this branch: it opened the `missing_stop` ones, and it CLOSED the `mirrored_traded` ones.
      detail: `${live.length} trade(s) the DESK was trading have NO declared risk: ${names}`
        + `${live.length > 3 ? ` +${live.length - 3} more` : ''}`
        + `${A.worstAdversePct != null ? ` (worst recorded adverse ${A.worstAdversePct}%)` : ''}`
        + ' — these cannot be measured in R, and their risk is UNKNOWN, not zero',
    };
  }
  const mirrored = A.mirrored_unmeasured;
  const traded = A.mirrored_traded;
  const historical = A.missing_stop + A.zero_distance;
  if (mirrored || traded || historical) {
    const parts = [];
    if (mirrored) parts.push(`${mirrored} mirrored from the venue (the desk never placed them — unmeasurable, not fixable)`);
    if (traded) parts.push(`${traded} mirrored row(s) the desk then CLOSED itself — adopted as a stranger, then traded, so the desk held unmeasured risk it was acting on`);
    if (historical) parts.push(`${historical} desk-opened before ${epoch.slice(0, 10)}, when order paths could not record levels yet (historical, not recoverable)`);
    const r = recent || summarise([]);
    const unmeasurable = A.mirrored_unmeasured + A.mirrored_traded + A.missing_stop + A.zero_distance;
    return {
      status: 'warn',
      // ★ TRD-F20-EPOCH (2026-09-28): `standing` — BOTH RESIDUES ARE IRREVERSIBLE, AND THIS FUNCTION'S OWN
      // COMMENT ABOVE ALREADY ARGUED THE CASE. It says the recent window decides the STATUS because "judging
      // the residue would leave this amber forever over rows that cannot be fixed, which is how a real alert
      // gets tuned out" — and then the branch BELOW the live check returned `warn` for exactly that residue,
      // which left it amber forever anyway. The two halves disagreed; the code followed the half it warned
      // against. A mirrored position was never placed by the desk, and a row opened before
      // `exitLevels.entryLimits` existed cannot have a level backfilled (`backfillable: 0`). No action clears
      // either, so both are standing: still rendered, still counted, no longer gating the desk.
      //
      // ★ AMENDED 2026-09-28 (TRD-RSK-9). "A mirrored position was never placed by the desk" was the
      // load-bearing half of that argument, and it is FALSE for `mirrored_traded`: those rows are defects now
      // and reach the `live` branch ABOVE, so a live one is red. What is left standing here is the residue the
      // desk demonstrably never touched — which is what "no action clears it" was always supposed to mean.
      standing: true,
      detail: `${A.measured} of ${A.closed} closed trade(s) measurable; ${parts.join('; ')}.`
        + (r.defectCount ? ` ${r.defectCount} of those ${unmeasurable} unmeasurable row(s) closed within the last ${recentDays}d.` : ` None opened in the last ${recentDays}d.`),
    };
  }
  return {
    status: 'ok',
    detail: A.closed
      ? `all ${A.closed} closed trade(s) carry a usable stop — every one is measurable in R`
      : 'no closed trades in the window yet',
  };
}

// DB wrapper. Thin on purpose: all judgement lives in the pure functions above.
async function report(userId, { days = 90, recentDays = 7, epoch = LEVELS_EPOCH } = {}) {
  const rows = await store.listClosedTradesForStats(userId, { days });
  const cutoff = Date.now() - Math.max(1, Number(recentDays) || 7) * 86400000;
  const isRecent = (t) => t.closeAt != null && new Date(t.closeAt).getTime() >= cutoff;
  const all = summarise(rows);
  const recent = summarise(rows.filter(isRecent));
  // Post-epoch slice: the population the current order paths are responsible for.
  const liveEra = summarise(rows.filter((t) => openedAfter(t, epoch)));
  return {
    windowDays: days, recentDays, epoch,
    all, recent, liveEra,
    verdict: verdict(all, recent, { epoch, recentDays }),
  };
}

module.exports = { REASON, DEFECTS, LEVELS_EPOCH, isDeskOpened, deskClosed, stopDistance, classify, summarise, verdict, report };
