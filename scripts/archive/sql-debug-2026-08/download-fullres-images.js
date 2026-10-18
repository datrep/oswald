// Download all 45 PDF preview images at FULL resolution.
// The preview service returns discrete render levels; requesting width>=~2048
// yields the 2x (original) render (e.g. 2898x4096) instead of the 2048px preview.
// Usage: node scripts/download-fullres-images.js [width]
const fs = require('fs');
const path = require('path');

const HAR = path.join(__dirname, '..', 'www.dropbox.com_Archive [26-08-15 23-54-45].har');
const OUT_DIR = path.join(__dirname, '..', 'downloads', 'images');
const WIDTH = process.argv[2] || '4000';

function parseBasePath() {
  const har = JSON.parse(fs.readFileSync(HAR, 'utf8'));
  for (const entry of har.log.entries) {
    const url = entry.request.url;
    if (url.includes('/p/pdf_img/')) return url.split('?')[0];
  }
  throw new Error('No pdf_img URL found in HAR');
}

const basePath = parseBasePath();
console.log('Width param:', WIDTH);
console.log('Output dir:', OUT_DIR);
fs.mkdirSync(OUT_DIR, { recursive: true });

async function fetchImage(page) {
  const url = `${basePath}?is_prewarmed=true&page=${page}&width=${WIDTH}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 10000) throw new Error(`suspiciously small (${buf.length} bytes)`);
  return buf;
}

(async () => {
  let ok = 0;
  const failed = [];
  let total = 0;
  for (let page = 0; page <= 44; page++) {
    const file = path.join(OUT_DIR, `page_${String(page).padStart(2, '0')}.png`);
    try {
      let buf;
      try { buf = await fetchImage(page); }
      catch (e) { await new Promise(r => setTimeout(r, 1000)); buf = await fetchImage(page); }
      fs.writeFileSync(file, buf);
      const w = buf.readUInt32BE(16), h = buf.readUInt32BE(20);
      ok++; total += buf.length;
      console.log(`page=${String(page).padStart(2)}  OK  ${w}x${h}  ${(buf.length/1024/1024).toFixed(2)} MB`);
    } catch (e) {
      failed.push(page);
      console.log(`page=${String(page).padStart(2)}  FAIL  ${e.message}`);
    }
  }
  console.log(`\nDone. ${ok}/45 downloaded.`);
  console.log(`Total size: ${total} bytes = ${(total/1024/1024).toFixed(2)} MB`);
  if (failed.length) console.log('Failed pages:', failed.join(', '));
})();
