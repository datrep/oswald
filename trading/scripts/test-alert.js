// trading/scripts/test-alert.js — prove the alert path actually delivers (TRD-40).
//
// Why this exists: `telegramAlert` does NOT throw on failure — it returns
// `{ ok, error, description }` (lib/http.js:92). Every existing caller discards that return
// value inside a bare `try/catch`, so a revoked bot token, a wrong chat id, a rate limit or a
// missing credential produces NO error, NO log and NO page. The desk would be paging into the
// void and reporting success.
//
// A pager nobody has tested is not a pager. Run this after any change to the alert path, and
// before relying on the supervisor during a trading session.
//
// Usage:
//   node trading/scripts/test-alert.js             # send one clearly-labelled test page
//   node trading/scripts/test-alert.js --no-send   # check credentials + reachability only
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const { telegramAlert } = require('../lib/http');

(async () => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  console.log(`creds: TELEGRAM_BOT_TOKEN ${token ? `present (${token.length} chars)` : 'MISSING'}, TELEGRAM_CHAT_ID ${chatId ? `present (${String(chatId).length} chars)` : 'MISSING'}`);

  if (!token || !chatId) {
    console.error('FAIL: credentials missing — every alert is silently dropped. Fix .env first.');
    process.exit(1);
  }

  if (process.argv.includes('--no-send')) {
    // Reachability only: getMe tells us whether the TOKEN is valid without messaging anyone.
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`).catch((e) => ({ ok: false, err: e }));
    if (res.ok) {
      const j = await res.json();
      console.log(`PASS (no-send): token valid, bot @${j.result && j.result.username}`);
      process.exit(0);
    }
    console.error(`FAIL (no-send): token check failed — ${res.err ? res.err.message : `HTTP ${res.status}`}`);
    process.exit(1);
  }

  const now = new Date().toISOString();
  const text = [
    'OSWALD trading: TEST PAGE (no action needed)',
    `sent: ${now}`,
    'source: trading/scripts/test-alert.js',
    '',
    'If you can read this, the supervisor alert path delivers. The supervisor runs every 5 min',
    'and will message this chat only when the desk is DOWN, HUNG, or ALIVE BUT NOT TRADING.',
    'It does not restart the desk (report-only).',
  ].join('\n');

  const r = await telegramAlert(text);
  console.log('result:', JSON.stringify(r));

  if (r && r.ok) {
    console.log(`PASS: delivered (message_id ${r.messageId}) — check the Telegram chat.`);
    process.exit(0);
  }
  console.error(`FAIL: NOT delivered — ${r && (r.description || r.error)}`);
  console.error('Every alert from the desk is being dropped. This is the failure that would have hidden a real outage.');
  process.exit(1);
})().catch((e) => {
  console.error(`FAIL: ${String(e.stack || e.message || e)}`);
  process.exit(1);
});
