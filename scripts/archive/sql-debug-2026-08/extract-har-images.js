// Parse the .har capture and extract the Dropbox PDF preview image URLs.
// Usage: node scripts/extract-har-images.js
const fs = require('fs');
const path = require('path');

const harPath = path.join(__dirname, '..', 'www.dropbox.com_Archive [26-08-15 23-54-45].har');
const raw = fs.readFileSync(harPath, 'utf8');
const har = JSON.parse(raw);

const entries = har.log.entries;
const seen = new Set();        // exact URL dedupe
const pages = new Map();       // pageNumber -> { withWidth, withoutWidth, url }

for (const entry of entries) {
  const url = entry.request.url;
  if (!url.includes('/p/pdf_img/')) continue;
  const m = url.match(/[?&]page=(\d+)/);
  if (!m) continue;
  const page = parseInt(m[1], 10);
  const hasWidth = /[?&]width=/.test(url);
  if (!pages.has(page)) pages.set(page, { withWidth: null, withoutWidth: null });
  const rec = pages.get(page);
  if (hasWidth) rec.withWidth = url;
  else rec.withoutWidth = url;
  seen.add(url);
}

const pageNums = [...pages.keys()].sort((a, b) => a - b);
console.log('Total pdf_img entries:', entries.filter(e => e.request.url.includes('/p/pdf_img/')).length);
console.log('Unique pages found:', pageNums.length);
console.log('Page range:', pageNums[0], '..', pageNums[pageNums.length - 1]);
console.log('Missing pages:', (() => {
  const miss = [];
  for (let p = 0; p <= 44; p++) if (!pages.has(p)) miss.push(p);
  return miss;
})());
console.log('\nPer-page breakdown:');
for (const p of pageNums) {
  const rec = pages.get(p);
  console.log(`page=${String(p).padStart(2)}  withWidth=${rec.withWidth ? 'yes' : ' no'}  withoutWidth=${rec.withoutWidth ? 'yes' : ' no'}`);
}

// Build the base path (everything before the query string) — should be identical for all pages.
const anyUrl = pages.get(pageNums[0]).withWidth || pages.get(pageNums[0]).withoutWidth;
const basePath = anyUrl.split('?')[0];
console.log('\nBase path (shared):', basePath);

// Emit a manifest JSON for the downloader.
const manifest = [];
for (let p = 0; p <= 44; p++) {
  const rec = pages.get(p);
  // URL to actually request: for the first 10 pages (0-9) we drop width=480.
  let url;
  if (p <= 9) {
    url = rec.withoutWidth || (rec.withWidth ? rec.withWidth.replace(/&width=\d+/, '') : null);
  } else {
    url = rec.withoutWidth || (rec.withWidth ? rec.withWidth.replace(/&width=\d+/, '') : null);
  }
  if (!url) {
    // Reconstruct from base path if the page is missing from the capture.
    url = `${basePath}?is_prewarmed=true&page=${p}`;
  }
  manifest.push({ page: p, url });
}

const outPath = path.join(__dirname, 'har-image-manifest.json');
fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
console.log('\nWrote manifest to', outPath, 'with', manifest.length, 'URLs');
