// trading/scripts/flag-instrument-swap-rows.js — flag bars that were banked under the WRONG INSTRUMENT.
//
// WHAT THIS FIXES. The plus500_chart capture sometimes banks the bars of the instrument the chart was
// still DISPLAYING under the symbol it was SWITCHING TO. The result is a bounded run of rows on the victim
// symbol carrying the source instrument's prices, byte-identical to the source's own bars at the same
// timestamp. Seven watchlist symbols are affected; nothing was flagged, so quant/backtest have been
// reading all of it (`flagged = 0` is what makes a bar visible — see store/bars.js and README).
//
// WHY FLAG AND NOT DELETE. `flagged = 1` is the repo's DESIGNED mechanism: quant and backtest filter on
// `flagged = 0`, `listFlaggedBars` surfaces the set, and the UI's "Delete flagged bars and rebuild
// hourly/daily from validated ticks" purges and rebuilds from ticks. Flagging therefore (a) stops the
// damage immediately, (b) PRESERVES the evidence, and (c) is reversible. Deleting would destroy the record
// of a defect that is still recurring — the 2026-09-23 Sinopec run post-dates the 2026-09-23 GRD-1 cleanup.
//
// ★ THE PREDICATE IS THE EXACT-COPY JOIN, NOT A WINDOW AND NOT A RATIO. A swapped bar is byte-identical to
// the source's bar at the same venue/timeframe/timestamp — all four OHLC equal. Flagging a whole window
// would sweep up the victim's own good rows; flagging by level ratio would miss the partially-aggregated
// transition bars. This flags only rows PROVABLY copied from a named source.
//
// ⚠ WHAT THIS IS NOT: COMPLETE. The exact-copy test cannot see (a) the partially-aggregated boundary bars
// (Sinopec 1h 2026-09-23 13:00 differs from Gold's, because it was built from a mixture), nor (b) a run
// longer than the copy window's own continuity. So the flagged set is a LOWER BOUND on the contamination.
// That is stated rather than hidden, and it is why nothing here claims a total.
//
// ⚠ WHY THE VICTIM SIDE IS ASSERTED RATHER THAN DERIVED. The join finds a PAIR; it cannot say which member
// was copied. Each block below was adjudicated from each symbol's own daily level inside vs outside the
// window, recorded in `adjudication`, and the source side's series is smooth and plausible throughout. The
// adjudication is data, not preference — but it is set by hand, so it is written down where it can be
// checked rather than inferred silently by the script.
//
// USAGE
//   node trading/scripts/flag-instrument-swap-rows.js            # DRY RUN (default) — reports only
//   node trading/scripts/flag-instrument-swap-rows.js --yes      # applies flagged = 1, writes a backup
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../.env') });
// `sql` comes from shared/db, NOT from require('mssql'): db.js picks the driver
// (mssql vs mssql/msnodesqlv8) at load time, and a directly-required `mssql` is a
// different instance whose type objects the pool rejects with
// "Validation failed for parameter 'x'. parameter.type.validate is not a function".
const { getPool, sql } = require('../../shared/db');

const USER = 1;
const APPLY = process.argv.includes('--yes');

// Each block: the SYMBOL THAT WAS CORRUPTED (victim), the instrument actually displayed (source), and the
// window the copies occupy. `adjudication` records the evidence that fixes the direction of the pair.
const BLOCKS = [
  {
    victim: 'SGX', source: 'Sands China', timeframe: '1h',
    from: '2026-09-02 07:00:00', to: '2026-09-07 23:59:59',
    adjudication: 'SGX reads 14.09-14.17 against its own 25.4 -> 22.9 before and 24.9 -> 22.0 after; that level is Sands China\'s own daily average on the same days (13.74 -> 14.09 -> 14.04). Sands China\'s series is smooth throughout, so Sands China is the source.',
  },
  {
    victim: 'Silver', source: 'CK Hutchison', timeframe: '1h',
    from: '2026-09-02 07:00:00', to: '2026-09-17 07:00:00',
    adjudication: 'Silver reads 68.4-69.8 through 09-03..09-16, matching CK Hutchison day for day, and breaks its own downtrend (68.92 -> 64.39 before, 66.52 -> 65.45 after). CK Hutchison holds 67-70 across the whole period.',
  },
  {
    victim: 'Gasoline', source: 'SGX', timeframe: '1h',
    from: '2026-09-08 01:00:00', to: '2026-09-17 08:00:00',
    adjudication: 'Gasoline reads 22.2-24.9 against 3.01-3.21 on both sides, and the block carries only ~7 bars per session against 21-23 on its own days — a DIFFERENT INSTRUMENT\'S SESSION, not a price move. SGX holds 22.0-24.9 throughout.',
  },
  {
    victim: 'Sinopec', source: 'Gold', timeframe: '1h',
    from: '2026-09-23 08:00:00', to: '2026-09-23 12:00:00',
    adjudication: 'Sinopec reads 4300-4322 against 4.4-4.9 on every other day (2157.8 is its corrupted 09-23 daily mean). Gold\'s own 1h bars are intact at that level.',
  },
  {
    victim: 'Sinopec', source: 'Gold', timeframe: '1d',
    from: '2026-09-19 00:00:00', to: '2026-09-24 00:00:00',
    adjudication: 'Sinopec 1d 2026-09-20 reads 4376.40/4381.44/4368.45/4372.39 against 4.4-4.9 elsewhere. NOT a plain copy: its 09-23 row WELDS Sinopec\'s real open (4.470) to Gold\'s high/close (4322.400/4300.930), because the daily aggregation consumed the poisoned 1h rows above.',
  },
  {
    victim: 'Sands China', source: 'Gold', timeframe: '1d',
    from: '2026-09-19 00:00:00', to: '2026-09-24 00:00:00',
    adjudication: 'Sands China 1d 2026-09-20 is byte-identical to Sinopec\'s same-day row (ids 1681295 and 1681296, CONSECUTIVE — one pass), against 12.0-12.8 on every other day.',
  },
];

// Flag only rows byte-identical to the named source at the same venue/timeframe/barStart, inside the block.
// ⚠ NO `INTO @touched` AND NO `DECLARE`. A table variable would need a DECLARE ahead of the UPDATE, which
// would stop COUNT_SQL's rewrite (it anchors on `^\s*UPDATE`) from matching — and then the DRY RUN would
// execute the real UPDATE. `OUTPUT inserted.*` without INTO returns a recordset directly, and it sits inside
// the span that rewrite removes, so the read-only path stays provably read-only.
const FLAG_SQL = `
  UPDATE a SET a.flagged = 1
  OUTPUT inserted.id, inserted.symbol, inserted.timeframe, inserted.barStart
  FROM PriceBars a
  JOIN PriceBars b
    ON b.userId = a.userId AND b.venue = a.venue AND b.timeframe = a.timeframe
   AND b.barStart = a.barStart AND b.symbol = @source
   AND b.openPrice = a.openPrice AND b.high = a.high
   AND b.low = a.low AND b.closePrice = a.closePrice
  WHERE a.userId = @user AND a.venue = 'plus500_chart' AND a.symbol = @victim
    AND a.timeframe = @timeframe AND a.flagged = 0
    AND a.barStart >= @from AND a.barStart <= @to`;

// ⚠ THE ROWS THE COPY PREDICATE CANNOT REACH, AND WHY THEY EXIST AT ALL.
// A row welded from a partly-poisoned period is not a copy of any single source bar, so the exact-copy join
// does not match it — by construction, not by oversight. Two shapes, both downstream of the blocks above:
//
//   1. THE WELDED DAILY. `upsertDailyBars` aggregated a day whose hours were contaminated, so the daily row
//      blends the victim's real open with the source's high and close.
//   2. THE FORMING HOUR. A forming bar is a SNAPSHOT of the aggregation as of when it last ran, so it does
//      not equal the source's now-complete bar for the same hour. These are single leftover rows and they
//      are the only reason a healed symbol's daily mean stays absurd — Sinopec read 618.2 on 2026-09-23
//      after its six copied hours were flagged, because this one row survived.
//
// These are keyed by the UNIQUE constraint (userId, venue, symbol, timeframe, barStart), which identifies
// exactly ONE row, so an explicit entry here cannot sweep up a neighbour. Each carries the arithmetic that
// identifies it, so a later reader can re-derive it rather than trust it.
const WELDS = [
  {
    victim: 'Sinopec', source: 'Gold', timeframe: '1d', barStart: '2026-09-23 00:00:00',
    adjudication: 'high 4322.400 equals Gold 1h 08:00 high exactly, while open 4.470 is Sinopec\'s own level; '
      + 'high/low = 977 against a trailing daily reference of ~4.45. A blended row, so not byte-identical to any source bar.',
  },
  {
    victim: 'Sinopec', source: 'Gold', timeframe: '1h', barStart: '2026-09-23 13:00:00',
    adjudication: 'reads 4309.48/4310.05/4297.79/4300.93 against Sinopec\'s own trailing reference of 4.442 — '
      + 'a 968x level break. It is the FORMING hour, captured mid-aggregation, which is why it differs from Gold\'s '
      + 'now-complete 13:00 bar and escaped the byte-identical join. Found by the trailing-reference scan after the '
      + 'first pass, and it was the ONLY visible level anomaly left across every plus500 symbol.',
  },
];

// Flag one row by its UNIQUE key. Narrow on purpose: the key identifies a single row.
const WELD_SQL = `
  UPDATE a SET a.flagged = 1
  OUTPUT inserted.id, inserted.symbol, inserted.timeframe, inserted.barStart
  FROM PriceBars a
  WHERE a.userId = @user AND a.venue = 'plus500_chart' AND a.symbol = @victim
    AND a.timeframe = @timeframe AND a.barStart = @barStart AND a.flagged = 0`;

// The same join, read-only, for the dry run and the after-check.
const COUNT_SQL = FLAG_SQL.replace(/^\s*UPDATE a SET a\.flagged = 1[\s\S]*?FROM PriceBars a/,
  'SELECT COUNT(*) AS n FROM PriceBars a');

(async () => {
  const pool = await getPool();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = { at: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', user: USER, blocks: [] };
  let total = 0;

  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — venue plus500_chart, userId ${USER}\n`);

  for (const b of BLOCKS) {
    const params = () => {
      const r = pool.request();
      r.input('user', sql.Int, USER);
      r.input('victim', sql.NVarChar, b.victim);
      r.input('source', sql.NVarChar, b.source);
      r.input('timeframe', sql.NVarChar, b.timeframe);
      // ⚠ THE BOUNDS MUST BE BUILT AS UTC, AND THIS IS NOT COSMETIC.
      // `barStart` is stored in UTC. A JS STRING handed to sql.DateTime2 is parsed as LOCAL time, so
      // '2026-09-23 08:00:00' on an SGT (+8) box reaches SQL as 2026-09-23 00:00 UTC — the window slides
      // 8 hours off the data. That is silent: the first version of this script reported a 5-hour block as
      // "ZERO MATCHES", which reads exactly like "already clean", and it quietly trimmed the leading rows
      // off every wider block (Silver 61 of 67, Gasoline 49 of 56). Appending Z pins the interpretation.
      r.input('from', sql.DateTime2, new Date(b.from.replace(' ', 'T') + 'Z'));
      r.input('to', sql.DateTime2, new Date(b.to.replace(' ', 'T') + 'Z'));
      return r;
    };

    const counted = await params().query(COUNT_SQL);
    const n = counted.recordset[0].n;
    total += n;
    console.log(`  ${String(n).padStart(4)} row(s)  ${b.victim.padEnd(13)} ${b.timeframe}  <- ${b.source}`);
    if (n === 0) {
      // A block that matches nothing is a STALE BLOCK, not a clean one — say so loudly.
      console.log('        ⚠ ZERO MATCHES — either already flagged, or the evidence has changed. Do not read as "clean".');
    }

    if (APPLY && n > 0) {
      const applied = await params().query(FLAG_SQL);
      const rows = applied.recordset || [];
      backup.blocks.push({ ...b, flagged: rows.length, ids: rows.map((r) => r.id) });
      console.log(`        flagged ${rows.length}`);
    } else {
      backup.blocks.push({ ...b, flagged: 0, ids: [] });
    }
  }

  // The welded rows: keyed by UQ, not by an OHLC join, so they are reported in their own section.
  for (const w of WELDS) {
    const req = () => {
      const r = pool.request();
      r.input('user', sql.Int, USER);
      r.input('victim', sql.NVarChar, w.victim);
      r.input('timeframe', sql.NVarChar, w.timeframe);
      r.input('barStart', sql.DateTime2, new Date(w.barStart.replace(' ', 'T') + 'Z'));
      return r;
    };
    const n = (await req().query(WELD_SQL.replace(/^\s*UPDATE a SET a\.flagged = 1[\s\S]*?FROM PriceBars a/, 'SELECT COUNT(*) AS n FROM PriceBars a'))).recordset[0].n;
    total += n;
    console.log(`  ${String(n).padStart(4)} row(s)  ${w.victim.padEnd(13)} ${w.timeframe}  <- ${w.source}  (WELD)`);
    if (n === 0) console.log('        ⚠ ZERO MATCHES — already flagged, or the evidence has changed.');
    if (APPLY && n > 0) {
      const rows = (await req().query(WELD_SQL)).recordset || [];
      backup.blocks.push({ ...w, flagged: rows.length, ids: rows.map((r) => r.id) });
      console.log(`        flagged ${rows.length}`);
    } else {
      backup.blocks.push({ ...w, flagged: 0, ids: [] });
    }
  }

  console.log(`\n  TOTAL ${APPLY ? 'flagged' : 'to flag'}: ${total}`);

  if (!APPLY) {
    console.log('\n  Dry run. Nothing written. Re-run with --yes to apply.');
    console.log('  ⚠ The exact-copy predicate is a LOWER BOUND: boundary bars built from a mixture, and rows\n'
      + '    whose source is itself corrupt, are not matched. No total is claimed.');
  } else {
    fs.mkdirSync(path.join(__dirname, '../reports'), { recursive: true });
    const file = path.join(__dirname, `../reports/instrument-swap-flagged-${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(backup, null, 2));
    console.log(`\n  Backup written: ${path.relative(path.join(__dirname, '../..'), file)}`);
    console.log('  Roll back with: UPDATE PriceBars SET flagged = 0 WHERE id IN (<the ids above>)');
    console.log('  Then rebuild daily/hourly from ticks via POST /api/trading/bars/rebuild.');
  }

  await pool.close();
})().catch((e) => { console.error(e); process.exit(1); });
