// trading/connector/fake.js — in-memory broker double for unit tests.
// Same CONTRACT as browser/paper; no DB, no browser, no venue. Deterministic.
'use strict';

const state = {
  account: { equity: 10000, available: 10000, margin: 0, pnl: 0 },
  positions: [],   // {id, symbol, direction, size, openPrice}
  quotes: {},      // symbol -> {bid, ask}
  seq: 0,
  failNext: { placeOrder: false, closeOrder: false },
};

function reset({ equity = 10000 } = {}) {
  state.account = { equity, available: equity, margin: 0, pnl: 0 };
  state.positions = [];
  state.quotes = {};
  state.seq = 0;
  state.failNext = { placeOrder: false, closeOrder: false };
}

function setQuote(symbol, bid, ask) { state.quotes[symbol] = { bid, ask }; }

async function getQuotes(userId, settings, { symbols = [] } = {}) {
  const prices = {};
  for (const s of symbols) prices[s.symbol] = state.quotes[s.symbol] || null;
  return { source: 'fake', prices };
}

async function getAccount() { return { ...state.account }; }

async function getPositions() { return { items: [...state.positions], empty: !state.positions.length }; }

async function placeOrder(settings, { symbol, direction, size }) {
  if (state.failNext.placeOrder) { state.failNext.placeOrder = false; throw new Error('fake rejection'); }
  state.seq += 1;
  const price = state.quotes[symbol] ? (state.quotes[symbol].ask + state.quotes[symbol].bid) / 2 : 100;
  const p = { id: state.seq, symbol, direction, size, openPrice: price };
  state.positions.push(p);
  return { positionId: String(state.seq), price, filledAt: new Date(), units: String(size) };
}

async function closeOrder(settings, trade) {
  if (state.failNext.closeOrder) { state.failNext.closeOrder = false; throw new Error('fake close rejection'); }
  const idx = state.positions.findIndex((p) => p.id === Number(trade.plus500PositionId || trade.id));
  if (idx === -1) throw new Error('fake: position not found');
  const p = state.positions[idx];
  const price = state.quotes[p.symbol] ? (state.quotes[p.symbol].bid + state.quotes[p.symbol].ask) / 2 : 100;
  state.positions.splice(idx, 1);
  const pnl = (price - p.openPrice) * p.size * (p.direction === 'buy' ? 1 : -1);
  return { price, closedAt: new Date(), pnl };
}

async function getSession() { return { isTraded: true }; }

module.exports = {
  name: 'fake', kind: 'fake',
  getQuotes, getAccount, getPositions, placeOrder, closeOrder, getSession,
  health: { isPaused: () => false },
  _state: state, _reset: reset, _setQuote: setQuote,
};
