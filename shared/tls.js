// shared/tls.js — TLS cert loading + self-signed generation, shared by the
// Oswald dashboard and the fileserver (#70). Both services point at the SAME
// cert directory (fileserver/certs) so they serve one cert that's already
// trusted in the browser's Root store.
//
// FUTURE SCOPE: cert rotation, Let's Encrypt / ACME, or per-host certificates
// would be added here; keep the load-or-create contract stable for both apps.

const fs = require('fs');
const path = require('path');
const selfsigned = require('selfsigned');

/**
 * Load key.pem/cert.pem from certDir if present; otherwise generate a
 * self-signed cert (SANs cover host, localhost and 127.0.0.1 so browsers accept
 * both hostname and IP access) and persist it. Returns { key, cert }.
 * @param {object} opts
 * @param {string} opts.certDir
 * @param {string} [opts.host='localhost']
 */
async function loadOrCreateCert({ certDir, host = 'localhost' }) {
  fs.mkdirSync(certDir, { recursive: true });
  const keyPath = path.join(certDir, 'key.pem');
  const certPath = path.join(certDir, 'cert.pem');
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
  }
  // selfsigned 5.x is async — returns a promise.
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: host }, { name: 'organizationName', value: 'Oswald' }],
    {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: host },
            { type: 2, value: 'localhost' },
            { type: 7, value: host },
            { type: 7, value: '127.0.0.1' },
          ],
        },
      ],
    }
  );
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(certPath, pems.cert);
  return { key: pems.private, cert: pems.cert };
}

module.exports = { loadOrCreateCert };
