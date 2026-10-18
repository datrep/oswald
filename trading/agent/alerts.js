// trading/agent/alerts.js — human-readable Telegram messages (TRD-8).
// The old one-liners ("kill switch -> HARD (disaster floor: equity 3983.57 vs
// initial 2685.76)") were operator-hostile. Every alert is now a short
// plain-language paragraph: what happened, why, what it means, what to do.
'use strict';

const { telegramAlert } = require('../lib/http');

const fmt = (n, digits = 2) => {
  const v = Number(n);
  return Number.isFinite(v)
    ? v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    : String(n ?? '?');
};

// --- kill switch -------------------------------------------------------------

function humanReason(reason) {
  const r = String(reason || 'manual');

  const floor = r.match(/disaster\s*floor\s*:\s*equity\s+([\d.,]+)\s+vs\s+initial\s+([\d.,]+)/i);
  if (floor) {
    const equity = parseFloat(String(floor[1]).replace(/,/g, ''));
    const initial = parseFloat(String(floor[2]).replace(/,/g, ''));
    const pct = initial > 0 ? (((equity - initial) / initial) * 100).toFixed(1) : null;
    const dir = pct && Number(pct) < 0 ? 'fell' : 'changed';
    return `the demo account equity ${dir} to ${fmt(equity)} (${pct}% vs the starting equity of ${fmt(initial)}), which breaches the disaster floor`;
  }

  const cb = r.match(/circuit\s*breaker\s*:\s*(\d+)\s+rejected orders? in\s+(\d+)\s*min/i);
  if (cb) {
    return `${cb[1]} order attempts were rejected by the venue in ${cb[2]} minutes, which tripped the circuit breaker`;
  }

  if (/dashboard/i.test(r)) return 'set from the Oswald dashboard';
  if (/^manual$/i.test(r)) return 'triggered manually';
  return `reason: ${r}`;
}

function killSwitchText(tier, reason) {
  const why = humanReason(reason);
  if (tier === 'soft') {
    return [
      '⚠️ Trading Agent — new orders PAUSED',
      '',
      `Why: ${why}.`,
      '',
      'What this means:',
      '• No new trades will be opened.',
      '• Open positions keep running normally.',
      '',
      'Trading stays paused until you clear it on the Trading Agent dashboard (Kill switch → Resume).',
    ].join('\n');
  }
  if (tier === 'hard') {
    return [
      '🛑 Trading Agent — EMERGENCY STOP',
      '',
      `Why: ${why}.`,
      '',
      'What this means:',
      '• No new trades will be opened.',
      '• All open positions will be closed automatically.',
      '',
      'The agent is locked until you clear it on the Trading Agent dashboard (Kill switch → Resume).',
    ].join('\n');
  }
  return [
    '✅ Trading Agent — safety switch cleared',
    '',
    `The kill switch was released (${why}). Trading is back to normal.`,
  ].join('\n');
}

async function sendKillAlert(tier, reason) {
  return telegramAlert(killSwitchText(tier, reason));
}

// --- watchdog (zombie) alerts ------------------------------------------------

function loginDeathText() {
  return [
    '🔐 Trading Agent — Plus500 signed out',
    '',
    'The bridge can no longer see the Plus500 account, so the agent cannot check prices or trade right now.',
    '',
    'What to do:',
    '• Open the Trading Agent dashboard and log Plus500 back in (demo account).',
    '• The agent will detect the login again and carry on automatically.',
  ].join('\n');
}

function loginRecoveredText() {
  return [
    '✅ Trading Agent — Plus500 session restored',
    '',
    'The bridge sees the Plus500 login again. Price capture and trading can resume.',
  ].join('\n');
}

// TRD-51 fix 3: the age passed in is now the age of the last SUCCESSFUL wake, not the last
// attempt. When the desk has never completed a wake since it started, saying so is the whole
// message — "no wake cycle has completed" is literally true and the old text implied a busy
// loop. `clock` is the wakerStaleness() result.
function staleWakerText(minutesStale, normalMinutes, clock = null) {
  const lines = [
    '🧟 Trading Agent — the loop looks stuck',
    '',
    `No wake cycle has COMPLETED in the last ${Math.round(minutesStale)} minutes (it normally runs every ${normalMinutes} minutes), so the agent is not checking the market.`,
  ];
  if (clock && clock.attemptAgeMin != null && clock.successAgeMin != null && clock.successAgeMin > clock.attemptAgeMin * 1.5) {
    // The signature of the 2026-09-14 outage: the loop is still TRYING, and every attempt is
    // failing. Without this line the reader assumes the loop is stopped.
    lines.push('', `The loop is still attempting: the last ATTEMPT was ${Math.round(clock.attemptAgeMin)} minutes ago. It is the attempts that are failing, not the schedule.`);
  }
  if (clock && clock.neverSucceeded) {
    lines.push('', 'This desk has not completed a single wake since it started — check the wake list for FAILED rows and the error log.');
  }
  lines.push('', 'Check the Trading Agent dashboard → Waker card. If the service was just busy or the market is closed, this can be a false alarm.');
  return lines.join('\n');
}

// --- pair lifecycle alerts (TRD-24) ------------------------------------------

function pairFailedText(pairId, legA, reason, unwound) {
  return [
    '❗️ Trading Agent — pair trade failed',
    '',
    `Pair ${pairId}: leg A (${legA.symbol} ${legA.direction}) filled, but leg B could not be opened (${reason || 'rejected'}).`,
    unwound
      ? 'The first leg was unwound, so there is no naked exposure.'
      : '⚠️ The unwind of leg A did NOT confirm — check the Positions tab for naked exposure.',
    '',
    'No action needed unless the unwind warning above is showing.',
  ].join('\n');
}

function pairUnhedgedText(pairId, survivor, minutes, closed) {
  return [
    '⚠️ Trading Agent — pair trade lost one leg',
    '',
    `Pair ${pairId}: only ${survivor.symbol} ${survivor.direction} is still open (the other leg closed, e.g. via stop or venue rollover) and it has been alone for ${minutes} minutes.`,
    closed
      ? 'The lone leg was closed automatically to remove the unhedged exposure.'
      : '❗️ The automatic close did NOT confirm — close the lone leg manually from the Positions tab.',
    '',
    'Once both legs are flat the pair is finished; a fresh pair can be opened deliberately.',
  ].join('\n');
}

function pairHalfClosedText(pairId, divergencePct) {
  return [
    '⚠️ Trading Agent — pair legs no longer matched',
    '',
    `Pair ${pairId}: the two legs differ in size by ${divergencePct}% (more than the allowed drift), which usually means one leg was partially closed (half-close) or resized at the venue.`,
    '',
    'Check the Positions tab and equalize or close the pair — an unhedged remainder behaves like a naked position.',
  ].join('\n');
}

async function sendPairAlert(text) {
  return telegramAlert(text);
}

module.exports = {
  humanReason, killSwitchText, sendKillAlert,
  loginDeathText, loginRecoveredText, staleWakerText,
  pairFailedText, pairUnhedgedText, pairHalfClosedText, sendPairAlert,
};
