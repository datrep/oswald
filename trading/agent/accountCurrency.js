// trading/agent/accountCurrency.js — TRD-PNL-4 (#1484): the unit the desk's money is in.
//
// THE GAP THIS CLOSES. The desk stored an equity number and never stored what it is denominated in: searched
// TradingSettings for any currency key (none), and the `account` event payload carried only
// {available, equity, margin, pnl, at}. Every report therefore quoted figures like 4063.37 with no unit, and a
// CNY cost could not be reconciled against it without a human supplying the rate.
//
// ⚠⚠ AND IT WAS NOT ONLY A REPORTING GAP — it had already corrupted data. Because nothing recorded that the
// venue pays P&L in the ACCOUNT's currency while `openPrice`/`size` are the INSTRUMENT's,
// `closeFill.js` divided one by the other and produced a fill ~1.2812x (USD/SGD) too far from the entry on all
// 60 venue closes (TRD-PNL-5 / #1496). The stopgap there REFUSES the derivation; this file is where the fact
// that would let it be correct gets recorded.
//
// ONE SOURCE. The account currency is DECLARED in `settings.account.currency` and read through here — never as a
// literal in a caller, because a second literal is how two answers to one question start. The live setting was
// written 2026-09-30 as 'SGD', on the venue's own statement printing "S$" beside both P&L figures.
//
// ⚠ PURE: settings in, value out. No store, no clock, no cache — the cache belongs to the caller that already
// has the settings in hand (accountPoller does), so this cannot go stale behind anyone's back.
'use strict';

// The ACCOUNT's currency, or null when it is not recorded. Null is a real answer — it means "nobody has said",
// which is materially different from a wrong unit, and every reader must be able to tell them apart.
function currencyOf(settings) {
  const c = settings && settings.account && settings.account.currency;
  return typeof c === 'string' && c.trim() ? c.trim().toUpperCase() : null;
}

// The INSTRUMENT's quote currency, or null when it is not recorded. ⚠ AN UNRECORDED INSTRUMENT IS NOT USD BY
// DEFAULT: the whole defect above came from assuming a currency, so a missing entry must REFUSE rather than
// guess. An empty map is therefore the safe state, and it is the state the desk is in for every instrument
// except the ones explicitly named.
function instrumentCurrencyOf(settings, symbol) {
  const m = settings && settings.account && settings.account.instrumentCurrency;
  if (!symbol || !m || typeof m !== 'object') return null;
  const raw = m[String(symbol)];
  return typeof raw === 'string' && raw.trim() ? raw.trim().toUpperCase() : null;
}

// THE HONEST ANSWER TO "CAN A P&L BE CONVERTED INTO A PRICE MOVE?" Both currencies must be recorded AND equal.
// ⚠ AND THERE IS A SECOND, INDEPENDENT GAP BEHIND THIS ONE, which is why this function is not the whole fix:
// even with both currencies recorded they DIFFER for every USD-quoted instrument on this SGD account, so a
// conversion would need the fx rate AT THE MOMENT OF THE CLOSE — a rate the desk does not record. Recording the
// currencies therefore makes the question answerable, not the answer computable. Stated here rather than
// discovered later, because it is the reason `closeFillPrice` still refuses after this row lands.
function sameCurrency(a, b) {
  const x = typeof a === 'string' ? a.trim().toUpperCase() : null;
  const y = typeof b === 'string' ? b.trim().toUpperCase() : null;
  return !!x && !!y && x === y;
}

function convertible(settings, symbol) {
  return sameCurrency(currencyOf(settings), instrumentCurrencyOf(settings, symbol));
}

// ★★ P2 (2026-10-01) — THE CONVERSION ITSELF, and the first one in this codebase.
//
// WHY IT IS HERE. This module already owns the question "what unit is this?", and it already documents that
// recording two currencies makes the question ANSWERABLE but not COMPUTABLE, because a conversion needs a rate.
// The rate now exists (`agent/fxRate.js`, derived from the venue's own position rows), so the last piece this
// module was deliberately missing can be added — in the one place, rather than at four call sites.
//
// ⚠ IT REFUSES. `convertible()` returning false was the whole fix for the venue-close fill (#1496), and that
// discipline does not expire now that a rate is available: a rate is not the same thing as a rate FOR THIS
// CONVERSION. A missing amount, a missing currency, or a missing/nonsensical rate each return a NAMED reason
// rather than a number, so a caller cannot convert by accident. What a caller DOES with a refusal is a policy
// decision and belongs to the caller — see `risk.js`'s `fxFactorFor`, which is deliberately asymmetric.
//
// SAME CURRENCY IS A FIRST-CLASS ANSWER, not a degenerate case: for the one SGD-quoted instrument the factor is
// exactly 1, and it is reported as `basis: 'same_currency'` so that "the factor is 1 because the currencies
// match" is distinguishable from "the factor defaulted to 1 because nobody supplied a rate".
function convertToAccount({ amount, from, to, rate } = {}) {
  if (amount == null || amount === '') return { ok: false, reason: 'amount_unrecorded' };
  const a = Number(amount);
  if (!Number.isFinite(a)) return { ok: false, reason: 'amount_not_a_number' };
  if (!sameCurrency(from, from) || !sameCurrency(to, to)) return { ok: false, reason: 'currency_unrecorded' };
  const f = String(from).trim().toUpperCase();
  const t = String(to).trim().toUpperCase();
  if (f === t) return { ok: true, amount: a, rate: 1, basis: 'same_currency' };
  if (rate == null || rate === '') return { ok: false, reason: 'rate_unavailable' };
  const r = Number(rate);
  if (!Number.isFinite(r) || r <= 0) return { ok: false, reason: 'rate_not_usable' };
  return { ok: true, amount: a * r, rate: r, basis: 'converted' };
}

module.exports = { currencyOf, instrumentCurrencyOf, sameCurrency, convertible, convertToAccount };
