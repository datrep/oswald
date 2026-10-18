// trading/connector/index.js — TRD-12 Phase 1: the venue abstraction.
// Every order/quote/position access in the desk goes through ONE interface:
//   { getQuotes, getAccount, getPositions, placeOrder, closeOrder, getSession, health }
// Implementations:
//   browser.js — the Plus500 Chrome CDP bridge (demo venue; the old
//                capture/webtrader/accountPoller paths, moved behind the wall)
//   paper.js   — the synthetic paper broker (sim desk)
//   fake.js    — in-memory double for unit tests (no browser, no venue)
'use strict';

const browserConn = require('./browser');
const paperConn = require('./paper');
const fakeConn = require('./fake');

const CONTRACT = ['getQuotes', 'getAccount', 'getPositions', 'placeOrder', 'closeOrder', 'getSession', 'health'];

// Auto-pick by desk mode: sim (settings.paper.enabled) -> paper broker;
// otherwise the Plus500 browser connector. Tests can force 'fake'.
function getConnector(settings, { force = null } = {}) {
  if (force === 'fake') return fakeConn;
  if (force === 'paper') return paperConn;
  if (force === 'browser') return browserConn;
  return settings && settings.paper && settings.paper.enabled ? paperConn : browserConn;
}

module.exports = { CONTRACT, getConnector, browser: browserConn, paper: paperConn, fake: fakeConn };
