// trading/agent/concierge.js — TRD-11: Telegram inbound concierge.
// Polls the Telegram bot for messages from the OWNER chat (TELEGRAM_CHAT_ID)
// and answers questions/commands. Outbound paging (alerts.js) uses the same
// bot — Telegram only reports INBOUND messages in getUpdates, so no echo.
// Commands: /status /wake /pause /resume /kill soft|hard|off /positions /help.
'use strict';

const fs = require('fs');
const path = require('path');
const { rawReq, telegramAlert } = require('../lib/http');
const store = require('../store');
const { runWake } = require('./waker');

const STATE_FILE = path.join(__dirname, '..', '.concierge-state.json');

let loopTimer = null;
let running = false;

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}; } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s)); } catch { /* best effort */ }
}
function loadOffset() {
  return readState().offset || 0;
}
function saveOffset(offset) {
  const s = readState();
  s.offset = offset;
  saveState(s);
}

async function telegram(method, payload, timeoutMs = 15000) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  try {
    const res = await rawReq('POST', `https://api.telegram.org/bot${token}/${method}`, payload, timeoutMs);
    return res.ok ? JSON.parse(res.text || '{}') : null;
  } catch { return null; }
}

function fmtMoney(v) {
  return v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// Build the "what's going on" digest from the single state tree.
async function buildStatus(userId = 1) {
  const t = await require('./stateTree').buildStateTree(userId);
  const lines = [];
  lines.push(`OSWALD trading desk — ${t.mode === 'sim' ? 'SIM mode (central AI + paper ledger)' : 'PLUS500 DEMO mode'}`);
  lines.push(`Kill: ${t.kill.tier.toUpperCase()} · waker: ${t.waker.paused ? 'PAUSED' : 'running'} (${t.waker.inProgress ? 'waking…' : 'idle'}) · interval ${t.waker.intervalMinutes}m`);
  lines.push(`Last wake: ${t.waker.lastWakeAt ? t.waker.lastWakeAt.replace('T', ' ').slice(0, 16) + 'Z' : 'never'} · next: ${t.waker.nextWakeAt ? t.waker.nextWakeAt.replace('T', ' ').slice(0, 16) + 'Z' : '—'}`);
  if (t.account) {
    lines.push(`Plus500 demo: available ${fmtMoney(t.account.available)} · equity ${fmtMoney(t.account.equity)} · margin ${fmtMoney(t.account.margin)} · P/L ${fmtMoney(t.account.pnl)}`);
  }
  if (t.paper) {
    lines.push(`Sim: equity ${fmtMoney(t.paper.equity)} (${t.paper.pnlPct >= 0 ? '+' : ''}${t.paper.pnlPct}%) · realized ${fmtMoney(t.paper.realized)} · ${t.paper.openPositions} open / ${t.paper.closedCount} closed`);
  }
  if (t.positions.demo.length) lines.push(`Demo open: ${t.positions.demo.map((p) => `${p.symbol} ${p.direction} ×${p.size}`).join(' · ')}`);
  if (t.positions.sim.length) lines.push(`Sim open: ${t.positions.sim.map((p) => `${p.symbol} ${p.direction} ×${p.size}`).join(' · ')}`);
  if (t.lastDecision) {
    const d = t.lastDecision;
    lines.push(`Last decision: ${d.mode === 'paper' ? `central ${d.stance} — ${d.headline || ''}` : `${d.action || d.skipped} ${d.reason || ''}`}`);
  }
  if (t.pulse && t.pulse.headline) lines.push(`Pulse: ${t.pulse.headline}`);
  if (t.central && t.central.parseFailure) lines.push('⚠ Central AI last run: PARSE FAILURE');
  if (t.alerts.active.length) lines.push(`Alerts active: ${t.alerts.active.map((a) => `${a.symbol} ${a.direction} ${a.threshold}`).join(' · ')}`);
  if (t.errors.length) {
    lines.push('Recent errors:');
    for (const e of t.errors.slice(0, 3)) lines.push(`- ${e.where}: ${e.error.slice(0, 140)}`);
  }
  return lines.join('\n');
}

async function handle(userId, text) {
  // Telegram appends "@botname" to commands in groups (/help@oswald_bot) — strip it so both
  // addressed and bare forms parse identically (2026-10-07: the owner chat is a supergroup
  // whose bot has privacy mode ON, so @-addressed commands are the only delivered form).
  const cmd = String(text || '').trim().toLowerCase().replace(/@[a-z0-9_]+/g, '');
  const settings = await store.getSettings(userId);
  if (cmd === '/status' || cmd === 'status' || cmd === '/s') {
    return buildStatus(userId);
  }
  if (cmd === '/help' || cmd === 'help' || cmd === '/start') {
    return 'Commands:\n/status — what is going on\n/wake — deliberate now\n/pause · /resume — stop/start scheduled wakes\n/kill soft|hard|off — kill switch\n/positions — open positions\n/help';
  }
  if (cmd === '/wake' || cmd === 'wake') {
    const r = await runWake(userId, 'telegram', { manual: true });
    const summary = r.skipped ? `wake skipped: ${r.skipped}`
      : r.mode === 'paper' ? `central: ${r.decision?.stance} conf ${r.decision?.confidence} — ${r.decision?.headline || ''}`
        : `decision: ${r.action || 'none'} ${r.reason || ''}`;
    return `${summary}\n${await buildStatus(userId)}`;
  }
  if (cmd === '/pause' || cmd === 'pause') {
    await store.saveSettings(userId, { ...settings, wake: { ...settings.wake, paused: true } });
    return 'Scheduled wakes PAUSED (manual /wake still works).';
  }
  if (cmd === '/resume' || cmd === 'resume') {
    await store.saveSettings(userId, { ...settings, wake: { ...settings.wake, paused: false } });
    return 'Scheduled wakes RESUMED.';
  }
  if (cmd.startsWith('/kill ') || cmd.startsWith('kill ')) {
    const tier = cmd.split(' ')[1];
    if (!['soft', 'hard', 'off'].includes(tier)) return 'Usage: /kill soft|hard|off';
    const killswitch = require('./killswitch');
    const next = await killswitch.setTier(userId, settings, tier, { reason: 'telegram concierge' });
    // F19 (2026-09-18): a remote hard kill makes the same promise the dashboard's dialog does, so it starts
    // the same sweep — and says so, because the tier alone is no longer the whole outcome. Not awaited: this
    // runs inside the Telegram poll loop, and the close waits on the shared page. The outcome arrives as a
    // `kill_auto_close` event, and the wake guard retries it on every wake while the tier stays hard.
    const sweeping = next.kill?.tier === 'hard' && !!next.kill?.autoClose;
    if (sweeping) {
      require('./executor').autoCloseSweep(userId, { caller: 'concierge:/kill', actor: 'human:telegram' });
    }
    return `Kill switch set to ${tier.toUpperCase()}.${sweeping ? ' Closing the open book now — /status for the outcome.' : ''}`;
  }
  if (cmd === '/positions' || cmd === 'positions') {
    const openLive = await store.getOpenTrades(userId);
    const openSim = settings.paper?.enabled ? await store.listPaperTrades(userId, { status: 'open', limit: 10 }) : [];
    if (!openLive.length && !openSim.length) return 'No open positions (demo or sim).';
    return [
      ...openLive.map((t) => `DEMO ${t.symbol} ${t.direction} ×${t.size} @ ${fmtMoney(t.openPrice)}`),
      ...openSim.map((t) => `SIM ${t.symbol} ${t.direction} ×${t.size} @ ${fmtMoney(t.openPrice)}`),
    ].join('\n');
  }
  return 'I understand: /status /wake /pause /resume /kill soft|hard|off /positions /help';
}

async function pollOnce(userId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ownerChat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !ownerChat) return 0;
  const offset = loadOffset();
  // Client timeout MUST exceed the long-poll timeout below (25 s) — a shorter one kills
  // every idle poll and leaves receipt to the next cycle (found 2026-10-07).
  // allowed_updates carries channel_post too: TELEGRAM_CHAT_ID is a CHANNEL ("oswald alerts",
  // type=channel, found 2026-10-07 via getChat) — the owner's posts there arrive as channel_post
  // updates, which a message-only filter silently discards. THAT was the real "commands not
  // received" root cause (the privacy-mode note applies to GROUPS only). DMs arrive as 'message'
  // and are admitted via the TELEGRAM_OWNER_USER_ID allowlist.
  const res = await telegram('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'channel_post'] }, 35000);
  const updates = (res && res.result) || [];
  const ownerUser = String(process.env.TELEGRAM_OWNER_USER_ID || '');
  for (const u of updates) {
    saveOffset(u.update_id + 1);
    const msg = u.message || u.channel_post || u.edited_message;
    if (!msg || !msg.text) continue;
    const chatId = String(msg.chat && msg.chat.id);
    const fromId = String((msg.from && msg.from.id) || '');
    // Owner = the alerts channel itself (channel posts) OR his private DM (user-id allowlist).
    const allowed = chatId === String(ownerChat) || (ownerUser && fromId === ownerUser);
    if (!allowed) {
      console.log('[trading.concierge] ignored message from chat', chatId, 'user', fromId, '-', String(msg.text).slice(0, 40));
      continue;
    }
    console.log('[trading.concierge] inbound:', String(msg.text).slice(0, 60), '(chat', chatId + ')');
    let reply;
    try { reply = await handle(userId, msg.text); }
    catch (e) { reply = `concierge error: ${String(e.message || e).slice(0, 200)}`; }
    // Reply to the ORIGIN chat (channel post -> channel; DM -> DM), not always the alerts channel.
    await telegram('sendMessage', { chat_id: chatId, text: String(reply).slice(0, 3900) });
  }
  return updates.length;
}

function start(userId = 1) {
  if (running) return;
  running = true;
  (async function loop() {
    while (running) {
      try { await pollOnce(userId); } catch { /* transient — retry on next tick */ }
      await new Promise((r) => setTimeout(r, 3000));
    }
  })();
  // One boot ping so the owner knows the concierge is alive — throttled to
  // once per 6h (restart storms were spamming the owner's Telegram).
  const PING_GAP_MS = 6 * 3600 * 1000;
  const st = readState();
  if (Date.now() - (Number(st.lastPingAt) || 0) > PING_GAP_MS) {
    telegramAlert('OSWALD concierge online — /status /wake /pause /resume /kill soft|hard|off /positions /help')
      .then((r) => { if (r && !r.ok) console.warn('[trading.concierge] ping failed:', r.error || r.description); })
      .catch(() => {});
    st.lastPingAt = Date.now();
    saveState(st);
  }
  console.log('[trading] telegram concierge started (owner-only)');
}

function stop() {
  running = false;
  if (loopTimer) clearTimeout(loopTimer);
}

module.exports = { start, stop, buildStatus, handle };
