const fs = require('fs');
const path = require('path');
const ping = require('ping');

async function readIPs() {
  const p = path.join(__dirname, '..', 'config', 'ips.txt');
  const txt = await fs.promises.readFile(p, 'utf8');
  return txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
}

exports.checkIPs = async (req, res) => {
  try {
    const ips = await readIPs();
    const results = await Promise.all(ips.map(async (ip) => {
      try {
        const r = await ping.promise.probe(ip, { timeout: 2 });
        return { ip, alive: r.alive, time: r.time };
      } catch (e) {
        return { ip, alive: false, error: e.message };
      }
    }));

    res.json({ ok: true, results });
  } catch (err) {
    console.error('[IP CHECK] error', err);
    res.status(500).json({ ok: false, error: err.message });
  }
};
