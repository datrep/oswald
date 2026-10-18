const fs = require('fs');
const path = require('path');
const { getPool } = require('../config/db');

function normalizeResourcePath(rawPath) {
  if (!rawPath) return null;
  let normalized = rawPath.replace(/\\/g, '/');
  normalized = normalized.replace(/^\/+/, '');
  if (normalized.startsWith('public/')) {
    normalized = normalized.slice('public/'.length);
  }
  normalized = normalized.replace(/^\/+/, '');
  if (!normalized.startsWith('resources/')) {
    normalized = path.posix.join('resources', path.posix.basename(normalized));
  }
  return normalized;
}

async function cleanupOrphans() {
  const pool = await getPool();
  const result = await pool.request().query('SELECT resourcePath FROM EdictResources');
  const referenced = new Set(
    result.recordset.map((r) => normalizeResourcePath(r.resourcePath)).filter(Boolean)
  );

  const resourcesDir = path.join(__dirname, '..', 'public', 'resources');
  if (!fs.existsSync(resourcesDir)) {
    console.log('Resources directory missing:', resourcesDir);
    return;
  }

  const files = fs.readdirSync(resourcesDir);
  let deleted = 0;
  // Iterate over files in resources directory and delete those not referenced in DB
  for (const file of files) {
    const filePath = path.join(resourcesDir, file);
    const stat = fs.statSync(filePath); // statSync is used to check if it's a file or directory
    if (!stat.isFile()) continue;
    const key = `resources/${file}`;
    if (!referenced.has(key)) {
      fs.unlinkSync(filePath);
      deleted += 1;
      console.log('Removed orphan file:', filePath);
    }
  }

  console.log(`Cleanup complete; deleted ${deleted} orphaned file(s).`);
}

cleanupOrphans()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('cleanup failed', err);
    process.exit(1);
  });
