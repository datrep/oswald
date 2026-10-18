// trading/connector/paper.js — the synthetic paper broker as a connector.
// Same interface as browser.js so the wake/executor paths are venue-agnostic.
'use strict';

const store = require('../store');
const paper = require('../agent/paper');
const { sessionState } = require('../agent/sessions');

// Paper quotes come from the best-price cascade (plus500 -> yahoo -> rest);
// a "quote" here is a mid-price resolution for sizing/marks.
async function getQuotes(userId, settings, { symbols = [] } = {}) {
  const prices = {};
  for (const s of symbols) {
    try { prices[s.symbol] = await paper.bestPrice(userId, settings, s.symbol); }
    catch { prices[s.symbol] = null; }
  }
  return { source: 'paper_broker', prices };
}

async function getAccount(userId, settings) {
  return paper.equity(userId, settings);
}

async function getPositions(userId) {
  return store.listPaperTrades(userId, { status: 'open', limit: 50 });
}

// sizePct optional: the paper broker sizes from equity when not given.
async function placeOrder(userId, settings, { symbol, direction, size = null }) {
  const r = await paper.openManual(userId, settings, { symbol, direction, sizePct: null });
  return { paperTradeId: r && r.id, opened: r, venue: 'paper' };
}

async function closeOrder(userId, settings, trade) {
  return paper.closeTrade(userId, settings, trade, {});
}

async function getSession(userId, symbol, venue = 'paper') {
  return sessionState(userId, symbol, venue, new Date());
}

module.exports = { name: 'paper', kind: 'sim', getQuotes, getAccount, getPositions, placeOrder, closeOrder, getSession, health: { isPaused: () => false } };
