// trading/agent/analysesVision.js — TRD-PRM-1 VISION LANE (owner-directed 2026-10-04: the premium
// analyses "should have an image analyzer, thats fed to the llm... even with the extra cost").
//
// The deterministic text lane (analysesParser) stays PRIMARY. This lane feeds a per-view SCREENSHOT
// to the LLM and stores the extraction as its OWN append-only evidence row (source='capture-vision',
// model + prompt version stamped). The pre-registered study may only consume this lane via a further
// dated pre-registration (brief Rev 2 §2 P3 discipline). Budget: own consumer `analyses-vision`
// (soft gate; cap written to settings 2026-10-04). Vision capability verified live 2026-10-04
// (HTTP 200 on a real analyses screenshot; ~1.1k prompt tokens per downscaled test image).
'use strict';
const fs = require('fs');
const path = require('path');

const IMG_DIR = path.join(__dirname, '..', 'data', 'analyses-img');
const PROMPT_VERSION = 'analyses-vision-v1-2026-10-04';
const PROMPT = [
  'You are reading a screenshot of the Plus500 "Premium Market Analyses" page (rendered inside a cross-origin iframe).',
  'Extract ONLY what is visibly present, as STRICT JSON:',
  '{"readable": true|false, "title": "<article title or empty>", "levels": [{"price": <number>, "label": "<as stated, e.g. September 29th low>", "kind": "resistance|support|pivot|target|level"}], "events": ["named events/dates mentioned, short"], "note": "layout/quality caveats, <=200 chars"}',
  'Rules: prices exactly as printed (numbers; thousands commas allowed); never invent; if the text is unreadable, set readable=false and explain in note; include EVERY price named as a LEVEL in the text (do NOT include the sell/buy quote, the day high/low box, or chart axis labels).',
].join(' ');

async function runView(userId, settings, { page, view, symbol }) {
  const budget = require('./budget');
  const allow = await budget.allow(userId, settings, 'analyses-vision');
  if (!allow.allowed) return { skipped: allow.reason };

  // Screenshot the IFRAME ELEMENT when possible (a full-resolution crop of the content); fall back
  // to the viewport. The image is kept on disk as the lane's raw evidence; its path is stamped on
  // the note row.
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(IMG_DIR, `${stamp}-${String(view).replace(/[^a-z0-9-]/gi, '_')}.png`);
  let shotHow = 'iframe';
  try {
    const el = await page.$('iframe[src*="premiumhub"]');
    if (el) await el.screenshot({ path: file });
    else { shotHow = 'viewport'; await page.screenshot({ path: file }); }
  } catch { shotHow = 'viewport'; await page.screenshot({ path: file }); }

  const b64 = fs.readFileSync(file).toString('base64');
  const deepseek = require('./deepseek');
  const ask = (maxTokens) => deepseek.callChat([
    { role: 'user', content: [{ type: 'text', text: PROMPT }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] },
  ], { temperature: 0, maxTokens, timeoutMs: 90000, jsonMode: true, userId, label: 'analyses_vision' });
  // Both served DeepSeek tiers are THINKING models — reasoning bills INSIDE max_tokens, so a heavy
  // image can burn the whole budget and return EMPTY content at finish_reason=length (the desk's
  // isTruncatedEmpty class; measured on Natural Gas, 2026-10-04). ONE retry at a doubled cap.
  let r = await ask(3200);
  if (!String(r.text || '').trim()) r = await ask(6000);
  require('./budget').record(userId, 'analyses-vision', r.usage, { settings }).catch(() => {});

  let parsed = null;
  try { parsed = JSON.parse(r.text); } catch { parsed = null; }
  const store = require('../store');
  const id = await store.insertAnalysesNote(userId, {
    kind: view === 'weekly' ? 'weekly' : 'instrument',
    symbol: symbol || null,
    title: parsed && parsed.title ? String(parsed.title).slice(0, 200) : `vision: ${view}`,
    url: page.url(),
    source: 'capture-vision',
    rawText: String(r.text || '').slice(0, 100000),
    parseStatus: parsed ? 'vision' : 'vision_unparsed',
    note: `vision lane; image=${path.relative(path.join(__dirname, '..'), file)}; model=${r.model}; prompt=${PROMPT_VERSION}; shot=${shotHow}; fin=${r.finishReason || '-'}`,
  });
  // Levels: instrument views only — the weekly view stores NO levels (consistent with the text
  // lane's design: weekly = context, its named levels ride the note's rawText). AnalysisLevels.symbol
  // is NOT NULL, so a weekly row is impossible by construction — the 2026-10-04 sweep #2 caught the
  // insert failing on the weekly view; this guard is the fix.
  let levels = 0;
  if (symbol && parsed && Array.isArray(parsed.levels)) {
    const mapped = parsed.levels
      .filter((l) => l && Number.isFinite(Number(l.price)))
      .slice(0, 16)
      .map((l) => ({
        symbol: symbol || null,
        price: Number(l.price),
        levelKind: ['resistance', 'support', 'pivot', 'target'].includes(String(l.kind)) ? String(l.kind) : 'level',
        label: String(l.label || '').slice(0, 120),
        timeframeHint: null,
        snippet: `[vision] ${String(l.label || '').slice(0, 120)}`,
      }));
    if (mapped.length) { await store.insertAnalysisLevels(userId, id, mapped); levels = mapped.length; }
  }
  return { stored: id, levels, readable: parsed ? parsed.readable !== false : null, shot: shotHow };
}

module.exports = { runView, PROMPT_VERSION };
