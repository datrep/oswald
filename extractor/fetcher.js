'use strict';
// extractor/fetcher.js — safe, generic image fetching.
//
// No host allowlist (the tool targets any site), so safety comes from rails:
// http/https only, redirect cap, timeout, response size cap, image magic-byte
// sniffing, and an optional private-IP block (toggle in settings.json).

const dns = require('dns');
const { promisify } = require('util');

const dnsLookup = promisify(dns.lookup);

// Query params that, when stripped, often restore the original/full image.
const SIZE_PARAMS = new Set([
  'width', 'height', 'w', 'h', 'size', 's',
  'maxwidth', 'maxheight', 'maxw', 'maxh', 'thumb', 'thumbnail',
]);

function toUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid URL: ${String(raw).slice(0, 120)}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http/https URLs are allowed');
  }
  return u;
}

// transform: { mode: 'original' | 'strip', setParams?: { [k]: v } }
function applyTransform(urlString, transform = {}) {
  const u = new URL(urlString);
  if (transform.mode === 'strip') {
    for (const key of [...u.searchParams.keys()]) {
      if (SIZE_PARAMS.has(key.toLowerCase())) u.searchParams.delete(key);
    }
  }
  if (transform.setParams) {
    for (const [k, v] of Object.entries(transform.setParams)) {
      u.searchParams.set(k, String(v));
    }
  }
  return u.toString();
}

function isPrivateIpv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => Number.isNaN(n))) return false;
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(ip) {
  const s = ip.toLowerCase();
  if (s === '::' || s === '::1') return true;
  if (s.startsWith('fc') || s.startsWith('fd')) return true; // fc00::/7
  if (s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb')) {
    return true; // fe80::/10
  }
  return false;
}

async function assertHostAllowed(hostname) {
  try {
    const addrs = await dnsLookup(hostname, { all: true });
    for (const a of addrs) {
      const ip = a.address;
      const blocked = ip.includes(':') ? isPrivateIpv6(ip) : isPrivateIpv4(ip);
      if (blocked) throw new Error(`Blocked private host ${hostname} (${ip})`);
    }
  } catch (err) {
    if (err.message.startsWith('Blocked private host')) throw err;
    // DNS failure: let fetch() surface the real error.
  }
}

// Identify an image by magic bytes; returns { type, mime, width, height } or null.
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    if (buf.length < 24) return null;
    return { type: 'png', mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { type: 'jpeg', mime: 'image/jpeg', width: null, height: null };
  }
  if (buf.toString('ascii', 0, 4) === 'GIF8') {
    if (buf.length < 10) return null;
    return { type: 'gif', mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { type: 'webp', mime: 'image/webp', width: null, height: null };
  }
  if (
    buf.toString('ascii', 4, 8) === 'ftyp' &&
    (buf.toString('ascii', 8, 12) === 'avif' || buf.toString('ascii', 8, 12) === 'avis')
  ) {
    return { type: 'avif', mime: 'image/avif', width: null, height: null };
  }
  return null;
}

const EXT_BY_TYPE = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', avif: 'avif' };

/**
 * Fetch an image URL into a Buffer with safety rails.
 * @returns {{ buf:Buffer, mime:string, type:string|null, width:number|null,
 *             height:number|null, finalUrl:string, status:number }}
 */
async function fetchImageBuffer(rawUrl, opts = {}) {
  const {
    maxBytes = 50 * 1024 * 1024,
    timeoutMs = 15000,
    maxRedirects = 5,
    blockPrivateIps = false,
  } = opts;

  let current = rawUrl;
  let res = null;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const u = toUrl(current);
    if (blockPrivateIps) await assertHostAllowed(u.hostname);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let r;
    try {
      r = await fetch(u.toString(), {
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { Accept: 'image/*, */*;q=0.8' },
      });
    } finally {
      clearTimeout(timer);
    }

    const loc = r.headers.get('location');
    if (r.status >= 300 && r.status < 400 && loc) {
      if (hop === maxRedirects) throw new Error('Too many redirects');
      current = new URL(loc, u).toString();
      continue;
    }
    res = r;
    break;
  }

  if (!res) throw new Error('No response');
  if (res.status >= 300) throw new Error(`HTTP ${res.status}`);

  // Stream the body with a hard size cap (don't trust Content-Length).
  const reader = res.body ? res.body.getReader() : null;
  if (!reader) throw new Error('Empty response body');
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      try { reader.cancel(); } catch { /* ignore */ }
      throw new Error(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);

  const sniff = sniffImage(buf);
  const contentType = (res.headers.get('content-type') || '').toLowerCase();
  if (!sniff && !contentType.startsWith('image/')) {
    throw new Error(`Not an image (${contentType || 'unknown content-type'})`);
  }

  return {
    buf,
    mime: sniff ? sniff.mime : contentType,
    type: sniff ? sniff.type : null,
    width: sniff ? sniff.width : null,
    height: sniff ? sniff.height : null,
    finalUrl: res.url || current,
    status: res.status,
  };
}

module.exports = {
  toUrl,
  applyTransform,
  fetchImageBuffer,
  sniffImage,
  EXT_BY_TYPE,
  SIZE_PARAMS,
};
