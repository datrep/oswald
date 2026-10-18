// trading/scripts/discover-instruments.js — watchlist auto-fill v2 (URL-driven).
// Navigates the CATEGORY pages (URLs captured from the user's own click-through)
// and reads the .instrument-table-container DOM. No search box involved.
// Prints a single JSON object to stdout (diagnostics on stderr only).
'use strict';

const browser = require('../plus500/browser');
const webtrader = require('../plus500/webtrader');

// target -> category page URL (verified by the user's manual click-through).
const CATEGORIES = [
  { url: 'https://app.plus500.com/trade/cryptocurrencies', targets: ['Bitcoin', 'Ethereum', 'Solana', 'BNB'] },
  { url: 'https://app.plus500.com/trade/all-commodities', targets: ['Gold', 'Silver', 'Oil'] },
  { url: 'https://app.plus500.com/trade/singapore', targets: ['SGX'] },
  { url: 'https://app.plus500.com/trade/hong-kong', targets: ['SHEIN'], fallbackUrl: 'https://app.plus500.com/trade/hong-kong--s-z' },
];

async function tableFor(page, url) {
  await webtrader.withConnRetry(() => page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' }));
  return webtrader.waitForTable(page, 20000);
}

async function main() {
  const page = await browser.newPage();
  await page.goto('https://app.plus500.com/trade', { timeout: 45000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const loggedIn = await webtrader.isLoggedIn(page);
  if (!loggedIn) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'login_required — sign in to Plus500 in the opened Chrome window first' }));
    process.exit(1);
  }
  const demo = await webtrader.assertDemo(page, null);
  if (!demo.demo) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'not_demo: ' + demo.detail }));
    process.exit(1);
  }

  const candidates = [];
  for (const cat of CATEGORIES) {
    let table = await tableFor(page, cat.url);
    let usedFallback = false;
    if (cat.fallbackUrl) {
      const missing = cat.targets.some((t) => !webtrader.matchRow(table.rows, t));
      if (missing) {
        table = await tableFor(page, cat.fallbackUrl);
        usedFallback = true;
      }
    }
    for (const target of cat.targets) {
      const row = webtrader.matchRow(table.rows, target);
      candidates.push({
        target,
        category: cat.url.split('/').pop() + (usedFallback ? ' (fallback)' : ''),
        found: !!row,
        plus500Name: row ? row.name : null,
        buy: row ? row.buy : null,
        sell: row ? row.sell : null,
        change: row ? row.change : null,
      });
    }
  }
  await browser.disconnect();
  process.stdout.write(JSON.stringify({ ok: true, candidates }));
  process.exit(0);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String(e.message || e).slice(0, 300) }));
  process.exit(1);
});
