// Download all 45 PDF preview images extracted from the .har capture.
// For the first images (pages 0-10 in the capture) the URL had &width=480;
// we drop that param so the original (full) resolution is returned.
// Usage: node scripts/download-har-images.js
const fs = require('fs');
const path = require('path');

const HAR = path.join(__dirname, '..', 'www.dropbox.com_Archive [26-08-15 23-54-45].har');
const OUT_DIR = path.join(__dirname, '..', 'downloads', 'images');

function parseBasePath() {
  const har = JSON.parse(fs.readFileSync(HAR, 'utf8'));
  for (const entry of har.log.entries) {
    const url = entry.request.url;
    if (url.includes('/p/pdf_img/')) {
      return url.split('?')[0];
    }
  }
  throw new Error('No pdf_img URL found in HAR');
}

const basePath = parseBasePath();
console.log('Base path:', basePath);
console.log('Output dir:', OUT_DIR);
fs.mkdirSync(OUT_DIR, { recursive: true });

async function fetchImage(page) {
  const url = `${basePath}?is_prewarmed=true&page=${page}`;
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const magic = buf.slice(0, 8).toString('hex');
  if (magic !== '89504e470d0a1a0a') throw new Error(`not a PNG (magic ${magic})`);
  return { buf, type: res.headers.get('content-type') };
}

(async () => {
  let ok = 0;
  const failed = [];
  for (let page = 0; page <= 44; page++) {
    const file = path.join(OUT_DIR, `page_${String(page).padStart(2, '0')}.png`);
    try {
      let r;
      try {
        r = await fetchImage(page);
      } catch (e) {
        await new Promise(r => setTimeout(r, 1000));
        r = await fetchImage(page); // one retry
      }
      fs.writeFileSync(file, r.buf);
      ok++;
      console.log(`page=${String(page).padStart(2)}  OK  ${r.buf.length} bytes  (${r.type})`);
    } catch (e) {
      failed.push(page);
      console.log(`page=${String(page).padStart(2)}  FAIL  ${e.message}`);
    }
  }
  console.log(`\nDone. ${ok}/45 downloaded to ${OUT_DIR}`);
  if (failed.length) console.log('Failed pages:', failed.join(', '));
  else console.log('All 45 images downloaded successfully.');
})();
