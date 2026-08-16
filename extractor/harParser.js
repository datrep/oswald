'use strict';
// extractor/harParser.js — generic HAR -> image plan parser.
//
// Works against any site's HAR: it keeps only the request URLs plus a little
// metadata useful for logging/debugging (status, mime, size, timings).
// Response bodies are never retained, so memory stays flat even for huge HARs.

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp)$/i;

function isImageMime(mime) {
  return typeof mime === 'string' && mime.toLowerCase().startsWith('image/');
}

function isImageUrl(url) {
  try {
    return IMAGE_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/**
 * Parse a HAR (object, JSON string, or Buffer) into an image plan.
 * @returns {{ entryCount:number, imageCount:number, otherCount:number,
 *             images:Array, templates:Array }}
 */
function parseHar(input) {
  let har = input;
  if (typeof input === 'string') har = JSON.parse(input);
  else if (Buffer.isBuffer(input)) har = JSON.parse(input.toString('utf8'));

  const entries = Array.isArray(har && har.log && har.log.entries) ? har.log.entries : [];
  const images = [];
  let otherCount = 0;

  for (const e of entries) {
    const req = e.request || {};
    const res = e.response || {};
    const url = req.url || '';
    if (!url) continue;

    const mime = res.content && res.content.mimeType ? res.content.mimeType : null;
    const size =
      res.content && res.content.size != null
        ? res.content.size
        : res.bodySize != null
          ? res.bodySize
          : null;

    if (!isImageMime(mime) && !isImageUrl(url)) {
      otherCount++;
      continue;
    }

    images.push({
      id: `e${images.length}`,
      url,
      method: req.method || 'GET',
      mimeType: mime || null,
      status: res.status != null ? res.status : null,
      size,
      startedDateTime: e.startedDateTime || null,
      time: e.time != null ? e.time : null,
    });
  }

  // Dedupe by URL, keeping first occurrence.
  const seen = new Set();
  const unique = [];
  for (const img of images) {
    if (seen.has(img.url)) continue;
    seen.add(img.url);
    unique.push(img);
  }

  return {
    entryCount: entries.length,
    imageCount: unique.length,
    otherCount,
    images: unique,
    templates: detectTemplates(unique),
  };
}

// Detect a URL template — a numeric query value shared by >=2 image URLs
// (e.g. `...p.png?page=0`, `?page=1`, ...). Lets the UI reconstruct missing
// pages, like page 11 in the Dropbox capture.
function detectTemplates(images) {
  const buckets = new Map();
  for (const img of images) {
    let u;
    try {
      u = new URL(img.url);
    } catch {
      continue;
    }
    for (const key of u.searchParams.keys()) {
      const val = u.searchParams.get(key);
      if (/^\d+$/.test(val)) {
        const probe = new URL(u.toString());
        probe.searchParams.set(key, '{n}');
        const base = probe.toString();
        if (!buckets.has(base)) buckets.set(base, { paramName: key, values: new Set() });
        buckets.get(base).values.add(parseInt(val, 10));
        break; // one numeric param per URL is enough for template detection
      }
    }
  }

  const templates = [];
  for (const [base, b] of buckets) {
    if (b.values.size < 2) continue;
    const values = [...b.values].sort((a, c) => a - c);
    const min = values[0];
    const max = values[values.length - 1];
    const missing = [];
    for (let i = min; i <= max; i++) if (!b.values.has(i)) missing.push(i);
    templates.push({ base, paramName: b.paramName, count: values.length, min, max, missing });
  }
  return templates;
}

module.exports = { parseHar, isImageMime, isImageUrl };
