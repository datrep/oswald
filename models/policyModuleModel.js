// models/policyModuleModel.js
// Policy module-attachment framework (PREREQ): which modules are attached to a
// policy, via the PolicyModules table.
//
// FUTURE SCOPE: new module types (e.g. 'certificates') only need to be added to
// MODULE_TYPES here + the frontend registry in policy.js — no schema change.

const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('PolicyModules');

// Backend allowlist — the API rejects anything not listed here.
const MODULE_TYPES = ['jobs', 'career_files', 'certificates'];

async function getModulesByEdict(edictId) {
  return repo.all({
    columns: 'id, edictId, moduleType, config, createdAt',
    where: 'edictId = @edictId',
    order: 'id',
    bind: (req) => req.input('edictId', sql.Int, edictId),
  });
}

async function attachModule(edictId, moduleType) {
  await repo.query(
    `INSERT INTO PolicyModules (edictId, moduleType) VALUES (@edictId, @moduleType)`,
    (req) => req.input('edictId', sql.Int, edictId).input('moduleType', sql.NVarChar, moduleType)
  );
}

async function detachModule(edictId, moduleType) {
  return repo.execute(
    `DELETE FROM PolicyModules WHERE edictId = @edictId AND moduleType = @moduleType`,
    (req) => req.input('edictId', sql.Int, edictId).input('moduleType', sql.NVarChar, moduleType)
  );
}

module.exports = { MODULE_TYPES, getModulesByEdict, attachModule, detachModule };
