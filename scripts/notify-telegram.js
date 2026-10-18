// scripts/notify-telegram.js — send one message from a file through the desk's OWN alert path.
//
// WHY A FILE AND NOT A COMMAND-LINE ARGUMENT: these messages are multi-line with quotes, emoji, `%` and
// trailing `-`, and PowerShell 5.1 mangles all four. Writing the text to a file and passing a path removes
// every quoting question, and the file is also the record of exactly what was sent.
//
// WHY IT EXITS NON-ZERO: `telegramAlert` RETURNS `{ ok, error, description }` instead of throwing (TRD-40), so
// a caller that ignores the return value reports success into the void. An unattended run that thinks it
// notified somebody when it did not is worse than one that never tried, so a failed send is a hard failure here.
//
//   node scripts/notify-telegram.js temp/msg.txt
'use strict';

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { telegramAlert, lastAlertOkAt, alertFailures } = require('../trading/lib/http');

// Telegram's hard limit is 4096 characters; the desk's heap of context should never approach it, but a
// truncated send is a silent lie, so the limit is enforced here rather than left to the API's 400.
const LIMIT = 4096;

(async () => {
  const file = process.argv[2];
  if (!file) { console.error('usage: node scripts/notify-telegram.js <path-to-message-file>'); process.exit(2); }
  if (!fs.existsSync(file)) { console.error(`message file not found: ${file}`); process.exit(2); }
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) { console.error('message file is empty — refusing to send a blank page'); process.exit(2); }
  if (text.length > LIMIT) { console.error(`message is ${text.length} chars, over Telegram's ${LIMIT} limit — refusing to send a truncated page`); process.exit(2); }

  const r = await telegramAlert(text);
  if (r && r.ok) {
    console.log(`DELIVERED message_id=${r.messageId} chars=${text.length}`);
    process.exit(0);
  }
  console.error(`NOT DELIVERED — ${(r && (r.description || r.error)) || 'unknown'}`);
  console.error(`last successful alert: ${lastAlertOkAt() || 'never'}`);
  const fails = alertFailures();
  if (fails.length) console.error(`recorded alert failures: ${fails.length}, latest: ${JSON.stringify(fails[fails.length - 1])}`);
  process.exit(1);
})();
