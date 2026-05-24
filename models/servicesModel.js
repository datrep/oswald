const sql = require("mssql");
const dbConfig = require("../config/db");

async function getAllServices() {

    const pool = await sql.connect(dbConfig);

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

    const pool = await sql.connect(dbConfig);
    //const serviceData = {
    const result = await pool.request()

    
        // Map service properties to SQL parameters
        .input("name", sql.NVarChar, serviceData.name)
        .input("description", sql.NVarChar, serviceData.description)
        .input("type", sql.NVarChar, serviceData.type)
        .input("target", sql.NVarChar, serviceData.target)
        .input("iconPath", sql.NVarChar, serviceData.iconPath)
        .input("enabled", sql.Bit, serviceData.enabled ?? true)
        .input("sortOrder", sql.Int, serviceData.sortOrder ?? 0)

        .query(
        `
        Insert into services (name, description, type, target, iconPath, enabled, sortOrder)
        VALUES (@name, @description, @type, @target, @iconPath, @enabled, @sortOrder)
        `
    );

    return result

}

module.exports = {
    getAllServices,
    createService
};