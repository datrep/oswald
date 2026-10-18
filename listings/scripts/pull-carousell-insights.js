// listings/scripts/pull-carousell-insights.js
// Pulls Carousell Insights (account stats + search keyword reach) into JSON.
//
// Session reuse: attaches to a Chrome/Edge instance on the debug port. If none
// is running, launches a persistent-profile Chromium so the Carousell login
// survives between runs. Spawned by POST /api/listings/insights/pull; prints a
// single JSON object to stdout (diagnostics go to stderr).
//
// Config via env (optional, defaults shown):
//   CAROUSELL_DEBUG_PORT=9222
//   CAROUSELL_PROFILE_DIR=<listings>/.chrome-profile
//   CAROUSELL_EXECUTABLE=<path to chrome.exe/msedge.exe>
'use strict';

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const PORT = Number(process.env.CAROUSELL_DEBUG_PORT || 9222);
const PROFILE_DIR = process.env.CAROUSELL_PROFILE_DIR || path.join(__dirname, '..', '.chrome-profile');
const INSIGHTS_URL = 'https://www.carousell.sg/my-account/insights?source=me_page';
const MANAGE_URL = 'https://www.carousell.sg/manage-listings';

function findBrowser() {
  const candidates = [
    process.env.CAROUSELL_EXECUTABLE,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : null,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

function cdpUp() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/json/version', timeout: 1500 }, () => {
      req.destroy(); resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

async function connectOrLaunch() {
  if (await cdpUp()) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      return { browser, launched: false, child: null };
    } catch (e) {
      console.error(`[puller] existing CDP endpoint found but connect failed (${e.message}); launching fresh`);
    }
  }
  const exe = findBrowser();
  if (!exe) {
    throw new Error('No Chrome/Edge found. Set CAROUSELL_EXECUTABLE to a Chromium browser path.');
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  // Launch Chrome DIRECTLY (not via Playwright) so Google sees a normal browser.
  // Playwright-launched browsers carry automation flags that make Google OAuth
  // reject sign-in with "This browser or app may not be secure".
  const child = spawn(exe, [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,900',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: false, detached: false });

  let up = false;
  for (let i = 0; i < 60; i++) {
    if (await cdpUp()) { up = true; break; }
    await sleep(500);
  }
  if (!up) {
    throw new Error('Chrome launched but its debug port did not open. Close any leftover Chrome window from a previous attempt and retry.');
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  return { browser, launched: true, child };
}

function extract() {
  const toInt = (s) => {
    const m = String(s == null ? '' : s).replace(/,/g, '').match(/\d+/);
    return m ? parseInt(m[0], 10) : null;
  };

  function labelValue(root, label) {
    const leaves = [...root.querySelectorAll('p,span,div')].filter((e) => e.children.length === 0);
    const lbl = leaves.find((e) => e.textContent.trim() === label);
    if (!lbl) return null;
    let node = lbl.nextElementSibling;
    for (let i = 0; i < 4 && node; i++) {
      const t = node.textContent.trim();
      if (t && /\d/.test(t)) return t;
      node = node.nextElementSibling;
    }
    return null;
  }

  const account = {
    totalListingClicks: toInt(labelValue(document, 'Total listing clicks')),
    accountVisits: toInt(labelValue(document, 'Account visits')),
    chats: toInt(labelValue(document, 'Chats')),
    totalSpend: (labelValue(document, 'Total spend') || '').trim(),
  };

  const skipExact = new Set([
    'Buyers searching', 'Buyers reached', 'Promote', 'Reach more buyers',
    'Promote to stay ahead of competitors', "Maximise your listings' potential and grow your customer pool",
  ]);

  // The keyword name and the "Buyers searching"/"Buyers reached" numbers are
  // SIBLING subtrees, not ancestor/descendant — so walk the flat list of leaf
  // nodes in document order: the keyword is the nearest preceding non-numeric
  // leaf before each "Buyers searching" label.
  const leaves = [...document.querySelectorAll('p,span,div')].filter((e) => e.children.length === 0);
  const searchLabels = leaves.filter((e) => e.textContent.trim() === 'Buyers searching');

  const keywords = [];
  const seen = new Set();
  for (const lbl of searchLabels) {
    let statsRoot = lbl;
    for (let i = 0; i < 8 && statsRoot; i++) {
      statsRoot = statsRoot.parentElement;
      if (!statsRoot) break;
      if (statsRoot.textContent.includes('Buyers reached')) break;
    }
    const buyersSearching = toInt(labelValue(statsRoot || document, 'Buyers searching'));
    const buyersReached = toInt(labelValue(statsRoot || document, 'Buyers reached'));

    const idx = leaves.indexOf(lbl);
    let keyword = null;
    for (let j = idx - 1; j >= Math.max(0, idx - 10); j--) {
      const t = leaves[j].textContent.trim();
      if (!t) continue;
      if (skipExact.has(t)) continue;
      if (/^\d+$/.test(t)) continue;
      if (/^You have /.test(t)) continue;
      if (/^Buyers /.test(t) || /^Reach /.test(t) || /^Promote/.test(t)) continue;
      keyword = t;
      break;
    }
    if (!keyword || seen.has(keyword)) continue;
    seen.add(keyword);
    keywords.push({ keyword, buyersSearching, buyersReached });
  }

  return { account, keywords };
}

// ---------------------------------------------------------------------------
// Manage listings + per-listing "Listing Insights" dialog
// ---------------------------------------------------------------------------
// Poll for `needle` in the body text. If the renderer freezes (evaluates keep
// timing out — a load-time deadlock on these SPAs: no CPU burn, no JS dialog),
// reload the page once, which reliably revives it.
async function waitForBodyText(page, needle, pollMs, tries, label) {
  let timeouts = 0, reloaded = 0;
  for (let i = 0; i < tries; i++) {
    const t0 = Date.now();
    let ok = false;
    try { ok = await page.evaluate((n) => document.body.innerText.includes(n), needle, { timeout: 5000 }); } catch { ok = false; }
    if (ok) return true;
    if (Date.now() - t0 > 4500) timeouts++; else timeouts = 0;
    if (timeouts >= 3 && reloaded < 1) {
      reloaded++; timeouts = 0;
      console.error(`[puller] ${label} renderer frozen — reloading page`);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      await sleep(3000);
      continue;
    }
    await sleep(pollMs);
  }
  return false;
}

async function scrapeListings(page) {
  await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
  if (!(await waitForBodyText(page, 'View insights', 1000, 40, 'manage-listings'))) return [];

  const rows = await page.evaluate(() => {
    const out = [];
    for (const tr of document.querySelectorAll('table tr')) {
      const cells = [...tr.querySelectorAll('td')];
      if (cells.length < 6) continue;
      if (!cells.some((c) => c.textContent.includes('View insights'))) continue;
      const link = tr.querySelector('a[href*="/p/"]');
      const titleCell = cells[1];
      const titleText = (titleCell && titleCell.querySelector('p') ? titleCell.querySelector('p').textContent : titleCell ? titleCell.textContent : '').trim();
      const bumped = ((titleCell ? titleCell.textContent : '').match(/Bumped [^\n]*/) || [null])[0];
      out.push({
        title: titleText,
        url: link ? new URL(link.getAttribute('href'), location.origin).href : null,
        listedOn: (cells[2] ? cells[2].textContent : '').trim(),
        price: (cells[3] ? cells[3].textContent : '').trim(),
        likes: (cells[4] ? cells[4].textContent : '').trim(),
        bumped: bumped || null,
      });
    }
    return out;
  });

  const result = [];
  for (let i = 0; i < rows.length; i++) {
    let detail;
    try {
      detail = await scrapeListingDialog(page, i, rows[i].title);
    } catch (e) {
      detail = { error: String((e && e.message) || e).slice(0, 200) };
    }
    result.push({ ...rows[i], ...detail });
  }
  return result;
}

async function scrapeListingDialog(page, index, titleKey) {
  // A listing's dialog can overlap the PREVIOUS listing's closing dialog (the
  // old one fades out for ~1s). Always target the LAST dialog in the DOM (new
  // dialogs are appended) and verify it matches THIS listing's title — reading
  // the stale dialog was why every listing after the first had null stats.
  const want = String(titleKey || '').replace(/\s+/g, ' ').slice(0, 24);

  // Wait for any previous dialog to fully close first.
  for (let i = 0; i < 10; i++) {
    const anyOpen = await page.evaluate(() => !!document.querySelector('[role="dialog"]')).catch(() => false);
    if (!anyOpen) break;
    await sleep(400);
  }

  const opened = await page.evaluate((idx) => {
    const btns = [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'View insights');
    if (!btns[idx]) return false;
    btns[idx].click();
    return true;
  }, index);
  if (!opened) return { impressions: null, clicks: null, chats: null, listingKeywords: [], spotlightActive: null, error: 'no insights button' };

  let has = false;
  for (let i = 0; i < 30; i++) {
    has = await page.evaluate((w) => {
      const ds = [...document.querySelectorAll('[role="dialog"]')];
      const d = ds[ds.length - 1];
      if (!d) return false;
      const txt = d.innerText.replace(/\s+/g, ' ');
      return (w ? txt.includes(w) : true) && txt.includes('General insights');
    }, want).catch(() => false);
    if (has) break;
    await page.waitForTimeout(500);
  }
  if (!has) return { impressions: null, clicks: null, chats: null, listingKeywords: [], spotlightActive: null, error: 'dialog did not open' };

  const clickTab = async (name, needle) => {
    // Keep clicking the tab until its content actually renders. A single click
    // is NOT enough: the dialog re-renders lazily and can swallow the first
    // click, leaving the previous tab active — the bug that left
    // impressions/clicks/chats null for every listing whose dialog opened on
    // the Keyword insights tab. Re-click whenever the needle is still missing.
    const deadline = Date.now() + 12000;
    let selectedStreak = 0;
    while (Date.now() < deadline) {
      const state = await page.evaluate((nm) => {
        const ds = [...document.querySelectorAll('[role="dialog"]')];
        const d = ds[ds.length - 1];
        if (!d) return null;
        const b = [...d.querySelectorAll('button')].find((x) => x.textContent.trim() === nm);
        if (!b) return null;
        const selected = b.getAttribute('aria-selected') === 'true' || /\bD_GR\b/.test(String(b.className));
        if (!selected) b.click();
        return { selected };
      }, name).catch(() => null);
      if (!state) { await sleep(400); continue; }
      if (!needle) { await sleep(1400); break; }
      const ok = await page.evaluate((n) => {
        const ds = [...document.querySelectorAll('[role="dialog"]')];
        const d = ds[ds.length - 1];
        return d ? d.innerText.includes(n) : false;
      }, needle).catch(() => false);
      if (ok) break;
      selectedStreak = state.selected ? selectedStreak + 1 : 0;
      // The tab is active but its content never shows the needle: the panel is
      // genuinely empty for this listing — stop retrying and move on.
      if (selectedStreak >= 4) break;
      await sleep(400);
    }
    await sleep(needle ? 800 : 1000);
  };

  try {
    // General insights — 7-day impressions / clicks / chats.
    await clickTab('General insights', 'Impressions');
    // The labels render before their numbers — wait until at least one actual
    // value (Impressions/Clicks/Chat) has popped in before reading anything.
    const statValue = () => page.evaluate(() => {
      const ds = [...document.querySelectorAll('[role="dialog"]')];
      const d = ds[ds.length - 1];
      if (!d) return null;
      const leaves = [...d.querySelectorAll('p,span,div')].filter((e) => e.children.length === 0);
      for (const label of ['Impressions', 'Clicks', 'Chat']) {
        const lbl = leaves.find((e) => e.textContent.trim() === label);
        if (!lbl) continue;
        let n = lbl.previousElementSibling;
        for (let i = 0; i < 3 && n; i++) { const t = n.textContent.trim(); if (/^\d[\d,]*$/.test(t)) return t; n = n.previousElementSibling; }
        n = lbl.nextElementSibling;
        for (let i = 0; i < 3 && n; i++) { const t = n.textContent.trim(); if (/^\d[\d,]*$/.test(t)) return t; n = n.nextElementSibling; }
      }
      return null;
    }).catch(() => null);
    for (let i = 0; i < 10; i++) {
      if (await statValue()) break;
      await sleep(500);
    }
    const general = await page.evaluate(() => {
      const ds = [...document.querySelectorAll('[role="dialog"]')];
      const d = ds[ds.length - 1];
      if (!d) return {};
      const leaves = [...d.querySelectorAll('p,span,div')].filter((e) => e.children.length === 0);
      const numNear = (label) => {
        const lbl = leaves.find((e) => e.textContent.trim() === label);
        if (!lbl) return null;
        let n = lbl.previousElementSibling;
        for (let i = 0; i < 3 && n; i++) { const t = n.textContent.trim(); if (/^\d[\d,]*$/.test(t)) return t; n = n.previousElementSibling; }
        n = lbl.nextElementSibling;
        for (let i = 0; i < 3 && n; i++) { const t = n.textContent.trim(); if (/^\d[\d,]*$/.test(t)) return t; n = n.nextElementSibling; }
        return null;
      };
      // If the general tab is genuinely empty for this listing, capture the
      // empty-state wording so the UI can explain the dashes.
      const txt = (d.innerText || '').replace(/\s+/g, ' ');
      let note = null;
      if (!txt.includes('Popular related searches')) {
        const m = txt.match(/(not enough (views|data)[^.]*|no insights[^.]*|you have no insights[^.]*|insights (will|should) (show|appear)[^.]*)/i);
        if (m) note = m[0].slice(0, 160);
      }
      return { impressions: numNear('Impressions'), clicks: numNear('Clicks'), chats: numNear('Chat'), note, txt };
    });

    // Keyword insights — popular related searches + this listing's ranking.
    await clickTab('Keyword insights', 'searchers in the past week');
    // Keyword cards also lag — wait until a "N searchers in the past week"
    // line with real numbers has rendered.
    for (let i = 0; i < 10; i++) {
      const kwReady = await page.evaluate(() => {
        const ds = [...document.querySelectorAll('[role="dialog"]')];
        const d = ds[ds.length - 1];
        return d ? /\d+\s+searchers in the past week/i.test(d.innerText) : false;
      }).catch(() => false);
      if (kwReady) break;
      await sleep(500);
    }
    const listingKeywords = await page.evaluate(() => {
      const ds = [...document.querySelectorAll('[role="dialog"]')];
      const d = ds[ds.length - 1];
      if (!d) return [];
      const out = [];
      const kwLeaves = [...d.querySelectorAll('p,span,div')].filter((e) => e.children.length === 0 && /^‘.+’$/.test(e.textContent.trim()));
      for (const kwEl of kwLeaves) {
        const keyword = kwEl.textContent.trim().slice(1, -1);
        let box = kwEl;
        for (let i = 0; i < 8 && box; i++) { box = box.parentElement; if (!box) break; if (box.textContent.includes('searchers in the past week') && box.textContent.includes("This listing's ranking")) break; }
        let searchers = null, rank = null;
        if (box) {
          const se = [...box.querySelectorAll('p,span,div')].find((e) => e.children.length === 0 && /searchers in the past week/.test(e.textContent.trim()));
          if (se) { const m = se.textContent.trim().match(/\d+/); searchers = m ? parseInt(m[0], 10) : null; }
          const rankEl = [...box.querySelectorAll('p,span,div')].find((e) => e.children.length === 0 && e.textContent.trim() === "This listing's ranking");
          if (rankEl && rankEl.previousElementSibling) rank = rankEl.previousElementSibling.textContent.trim();
        }
        out.push({ keyword, searchers, rank });
      }
      return out;
    });

    // Spotlight insights — active or not.
    await clickTab('Spotlight insights');
    const spotlightActive = await page.evaluate(() => {
      const ds = [...document.querySelectorAll('[role="dialog"]')];
      const d = ds[ds.length - 1];
      return d ? !d.innerText.includes('No Spotlights active') : null;
    });

    const toNum = (s) => {
      const n = parseInt(String(s || '').replace(/,/g, ''), 10);
      return Number.isFinite(n) ? n : null;
    };
    const impressions = toNum(general.impressions);
    const clicks = toNum(general.clicks);
    const chats = toNum(general.chats);
    const noStats = impressions === null && clicks === null && chats === null;
    // Diagnostic capture when the general stats are missing: what did the
    // dialog actually contain after the General insights tab was clicked?
    let debug;
    if (noStats) {
      const tabInfo = await page.evaluate(() => {
        const ds = [...document.querySelectorAll('[role="dialog"]')];
        const d = ds[ds.length - 1];
        if (!d) return { dialogCount: ds.length, tabs: [] };
        return {
          dialogCount: ds.length,
          tabs: [...d.querySelectorAll('button')].map((b) => ({ t: b.textContent.trim().slice(0, 30), sel: b.getAttribute('aria-selected') })),
        };
      }).catch(() => ({ dialogCount: -1, tabs: [] }));
      debug = { ...tabInfo, generalText: String(general.txt || '').slice(0, 500) };
    }
    return {
      impressions,
      clicks,
      chats,
      listingKeywords,
      spotlightActive,
      generalNote: general.note || null,
      error: (noStats && !general.note) ? 'no general insights in dialog' : undefined,
      debug,
    };
  } finally {
    // Close the dialog: Escape first, then the header Close button, then keep
    // clearing until no dialog remains so the next listing starts clean.
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
    for (let i = 0; i < 10; i++) {
      const gone = await page.evaluate(() => !document.querySelector('[role="dialog"]')).catch(() => false);
      if (gone) break;
      await page.evaluate(() => {
        const ds = [...document.querySelectorAll('[role="dialog"]')];
        const d = ds[ds.length - 1];
        const firstBtn = d && d.querySelector('button');
        if (firstBtn) firstBtn.click();
      }).catch(() => {});
      await page.waitForTimeout(400);
    }
  }
}

async function main() {
  const { browser, launched, child } = await connectOrLaunch();
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const page = context.pages()[0] || (await context.newPage());
    // Never let a JS dialog wedge the scrape.
    page.on('dialog', async (d) => { try { await d.dismiss(); } catch { /* ignore */ } });
    await page.goto(INSIGHTS_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    // Poll for the insights content. On first run this lands on the login page;
    // keep waiting so the user can sign in (up to ~3 min), then proceed once
    // "Total listing clicks" appears. waitForBodyText reloads the page once if
    // the renderer freezes (the SPA occasionally deadlocks during load).
    const ready = await waitForBodyText(page, 'Total listing clicks', 1000, 180, 'insights');
    if (!ready) {
      const onLogin = await page.evaluate(() => document.body.innerText.includes('Sign in') || location.pathname.includes('/login')).catch(() => false);
      throw new Error(onLogin
        ? 'Sign-in was not completed in time. Click "Pull now" again and sign in when the browser opens.'
        : 'Insights page did not load. Try again.');
    }
    // The Search insights keyword cards render lazily below the fold — scroll to
    // trigger them, then give them a few seconds (best-effort; empty keywords is OK).
    try {
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(1200);
      }
      await page.waitForTimeout(1500);
    } catch { /* ignore */ }
    const data = await page.evaluate(extract);

    // Per-listing insights: Manage listings table + each listing's dialog.
    let listings = [];
    try {
      listings = await scrapeListings(page);
    } catch (e) {
      console.error('[puller] listings scrape failed: ' + (e.message || e));
    }

    process.stdout.write(JSON.stringify({ capturedAt: new Date().toISOString(), ...data, listings }));
  } finally {
    if (launched) {
      // Gracefully close the Chrome we started (the session is already persisted
      // to the profile dir, so the login survives). Fall back to killing it.
      try {
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send('Browser.close');
      } catch { /* ignore */ }
      await sleep(800);
      if (child && child.exitCode === null) {
        try { child.kill(); } catch { /* ignore */ }
      }
    } else {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
}

main().catch((e) => {
  console.error(e.message || String(e));
  process.exit(1);
});
