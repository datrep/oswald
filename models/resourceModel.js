const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('EdictResources');

async function nextOrder(edictId) {
  const row = await repo.one(
    `SELECT ISNULL(MAX(sortOrder), -1) + 1 AS nextOrder FROM EdictResources WHERE edictId = @edictId`,
    (req) => req.input('edictId', sql.Int, edictId)
  );
  return row?.nextOrder ?? 0;
}

async function createResource(edictId, description, filePath) {
  const sortOrder = await nextOrder(edictId);
  await repo.query(
    `INSERT INTO EdictResources (edictId, resourcePath, description, sortOrder)
     VALUES (@edictId, @resourcePath, @description, @sortOrder)`,
    (req) => req
      .input('edictId', sql.Int, edictId)
      .input('resourcePath', sql.NVarChar, filePath)
      .input('description', sql.NVarChar, description)
      .input('sortOrder', sql.Int, sortOrder)
  );
}

async function getResourcesByEdict(edictId) {
  return repo.all({
    columns: 'id, edictId, resourcePath, description, sortOrder',
    where: 'edictId = @edictId',
    order: 'sortOrder, id',
    bind: (req) => req.input('edictId', sql.Int, edictId),
  });
}

async function getResourcePathById(id) {
  return repo.one(
    `SELECT resourcePath FROM EdictResources WHERE id = @id`,
    (req) => req.input('id', sql.Int, id)
  );
}

// List every resource across all policies (with the owning policy name), optionally filtered.
async function getAllResources(search, { limit, offset } = {}) {
  const where = search ? 'r.resourcePath LIKE @q OR r.description LIKE @q' : '';
  const paginate = Number.isInteger(limit) && limit > 0;
  let query = `
    SELECT r.id, r.edictId, r.resourcePath, r.description, e.name AS edictName
    FROM EdictResources r
    LEFT JOIN Edicts e ON e.id = r.edictId
    ${where ? `WHERE ${where}` : ''}
    ORDER BY r.resourcePath ASC`;
  if (paginate) query += ` OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`;
  return repo.query(query, (req) => {
    if (search) req.input('q', sql.NVarChar, `%${search}%`);
    if (paginate) {
      req.input('limit', sql.Int, limit);
      req.input('offset', sql.Int, offset || 0);
    }
  });
}

// Attach an EXISTING file (resourcePath already on disk, e.g. in public/resources)
// to a policy — used by the "pull from Oswald's /resources" picker.
// Returns the new row id.
async function attachResource(edictId, description, resourcePath) {
  const sortOrder = await nextOrder(edictId);
  return repo.create([
    { column: 'edictId', param: 'edictId', type: sql.Int, value: edictId },
    { column: 'resourcePath', param: 'resourcePath', type: sql.NVarChar, value: resourcePath },
    { column: 'description', param: 'description', type: sql.NVarChar, value: description },
    { column: 'sortOrder', param: 'sortOrder', type: sql.Int, value: sortOrder },
  ]);
}

// Persist a manual ordering for resources within an edict (drag-to-reorder).
async function reorderResources(edictId, orderedIds) {
  await repo.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .request()
        .input('id', sql.Int, orderedIds[i])
        .input('sortOrder', sql.Int, i)
        .input('edictId', sql.Int, edictId)
        .query(`UPDATE EdictResources SET sortOrder = @sortOrder WHERE id = @id AND edictId = @edictId`);
    }
  });
}

async function deleteResourceById(id) {
  return repo.remove(id);
}

// Update only the metadata (description) of an existing resource — the file on
// disk is untouched, so editing a resource no longer requires re-selecting it.
async function updateResource(id, description) {
  return repo.execute(
    `UPDATE EdictResources SET description = @description WHERE id = @id`,
    (req) => req.input('id', sql.Int, id).input('description', sql.NVarChar, description)
  );
}

module.exports = {
  createResource,
  getResourcesByEdict,
  getResourcePathById,
  getAllResources,
  attachResource,
  deleteResourceById,
  updateResource,
  reorderResources,
};
