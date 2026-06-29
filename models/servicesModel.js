const sql = require("mssql");
const db = require("../config/db");

async function getAllServices() {
    const pool = await getPool();
    const result = await pool.request()
        .query(`
            SELECT *
            FROM Services
            WHERE enabled = 1
            ORDER BY sortOrder ASC, name ASC
        `);
    return result.recordset;
}

async function createService(serviceData) {
    const pool = await getPool();
    const result = await pool.request()
        // Map service properties to SQL parameters
        .input("name", sql.NVarChar, serviceData.name)
        .input("description", sql.NVarChar, serviceData.description)
        .input("type", sql.NVarChar, serviceData.type)
        .input("target", sql.NVarChar, serviceData.target)
        .input("iconPath", sql.NVarChar, serviceData.iconPath)
        .input("enabled", sql.Bit, serviceData.enabled ?? true)
        .input("sortOrder", sql.Int, serviceData.sortOrder ?? 0)
        .query(`
            Insert into services (name, description, type, target, iconPath, enabled, sortOrder)
            VALUES (@name, @description, @type, @target, @iconPath, @enabled, @sortOrder)
        `);
    return result;
}

async function getServiceById(id) {
    const pool = await getPool();
    const result = await pool.request()
        .input('id', sql.Int, id)
        .query(`
            SELECT *
            FROM Services
            WHERE id = @id
        `);
    return result.recordset[0] || null;
}

async function updateService(id, serviceData) {
    const pool = await getPool();

    // Only include fields that are being updated and exist in the serviceData
    const updates = [];
    const params = {};

    if (serviceData.name !== undefined) {
        updates.push("name = @name");
        params.name = { type: sql.NVarChar, value: serviceData.name };
    }
    if (serviceData.description !== undefined) {
        updates.push("description = @description");
        params.description = { type: sql.NVarChar, value: serviceData.description };
    }
    if (serviceData.type !== undefined) {
        updates.push("type = @type");
        params.type = { type: sql.NVarChar, value: serviceData.type };
    }
    if (serviceData.target !== undefined) {
        updates.push("target = @target");
        params.target = { type: sql.NVarChar, value: serviceData.target };
    }
    if (serviceData.iconPath !== undefined) {
        updates.push("iconPath = @iconPath");
        params.iconPath = { type: sql.NVarChar, value: serviceData.iconPath };
    }
    if (serviceData.enabled !== undefined) {
        updates.push("enabled = @enabled");
        params.enabled = { type: sql.Bit, value: serviceData.enabled };
    }
    if (serviceData.sortOrder !== undefined) {
        updates.push("sortOrder = @sortOrder");
        params.sortOrder = { type: sql.Int, value: serviceData.sortOrder };
    }

    if (updates.length === 0) {
        return { affectedRows: 0 };
    }

    params.id = { type: sql.Int, value: id };
    const result = await pool.request()
        .query(`
            UPDATE Services
            SET ${updates.join(', ')}
            WHERE id = @id
        `, params);
    return result;
}

async function deleteService(id) {
    const pool = await getPool();
    const result = await pool.request()
        .input('id', sql.Int, id)
        .query(`
            DELETE FROM Services
            WHERE id = @id
        `);
    return result;
}

module.exports = {
    getAllServices,
    createService,
    getServiceById,
    updateService,
    deleteService
};