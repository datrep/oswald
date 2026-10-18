// trading/scripts/repro/exit-counterfactual.js — TRD-EXI-1 (#1490).
//
// Records the exit CLASS and the post-close COUNTERFACTUAL for every closed trade, then prints the table the
// "cut before hit" rule has to be judged on. It recomputes DIAGNOSIS fields only: no level moves, no metric is
// changed, and nothing here decides anything. The point is that the decision can be made from a recorded number
// instead of from whichever trades someone happened to look at first.
'use strict';

const store = require('../../store');
const autopsy = require('../../agent/autopsy');

const USER_ID = Number(process.env.TRADING_USER_ID || 1);

(async () => {
  const res = await autopsy.backfill(USER_ID, { limit: Number(process.env.LIMIT || 400), force: true });
  console.log('backfill:', JSON.stringify(res).slice(0, 600));
  process.exit(0);
})().catch((e) => {
  console.error('failed:', e && e.message ? e.message : e);
  process.exit(1);
});
