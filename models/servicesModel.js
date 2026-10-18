const { Repository } = require('../shared/repository');
const { sql } = require('../shared/db');

const repo = new Repository('Services');

async function getAllServices() {
  return repo.all({ where: 'enabled = 1', order: 'sortOrder ASC, name ASC' });
}

async function createService(serviceData) {
  const id = await repo.create([
    { column: 'name', param: 'name', type: sql.NVarChar, value: serviceData.name },
    { column: 'description', param: 'description', type: sql.NVarChar, value: serviceData.description },
    { column: 'type', param: 'type', type: sql.NVarChar, value: serviceData.type },
    { column: 'target', param: 'target', type: sql.NVarChar, value: serviceData.target },
    { column: 'iconPath', param: 'iconPath', type: sql.NVarChar, value: serviceData.iconPath },
    { column: 'enabled', param: 'enabled', type: sql.Bit, value: serviceData.enabled ?? true },
    { column: 'sortOrder', param: 'sortOrder', type: sql.Int, value: serviceData.sortOrder ?? 0 },
  ]);
  return { id };
}

async function getServiceById(id) {
  return repo.byId(id);
}

const SERVICE_UPDATABLE = {
  name: sql.NVarChar,
  description: sql.NVarChar,
  type: sql.NVarChar,
  target: sql.NVarChar,
  iconPath: sql.NVarChar,
  enabled: sql.Bit,
  sortOrder: sql.Int,
};

async function updateService(id, serviceData) {
  const sets = [];
  const present = [];
  for (const [key, type] of Object.entries(SERVICE_UPDATABLE)) {
    if (serviceData[key] === undefined) continue;
    sets.push(`${key} = @p_${key}`);
    present.push([key, type]);
  }
  if (!sets.length) return 0;
  return repo.execute(
    `UPDATE Services SET ${sets.join(', ')} WHERE id = @id`,
    (req) => {
      req.input('id', sql.Int, id);
      for (const [key, type] of present) req.input(`p_${key}`, type, serviceData[key]);
    }
  );
}

async function deleteService(id) {
  return repo.remove(id);
}

module.exports = {
  getAllServices,
  createService,
  getServiceById,
  updateService,
  deleteService,
};
