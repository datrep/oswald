// fsMeta.js — DB metadata for the Oswald fileserver (FS-2).
// Reuses the dashboard's shared SQL Server pool (../config/db.js) — the
// fileserver process loads the same repo-root .env, so it connects to DB_Oswald.
const sql = require('mssql');
const { getPool } = require('../config/db');

// ---- Favorites --------------------------------------------------------------

async function getFavorites(userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .query(`SELECT rootId, filePath FROM FileFavorites WHERE userId = @userId ORDER BY filePath`);
  return result.recordset;
}

async function isFavorite(userId, rootId, filePath) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('rootId', sql.NVarChar, rootId)
    .input('filePath', sql.NVarChar, filePath)
    .query(`SELECT 1 AS x FROM FileFavorites WHERE userId=@userId AND rootId=@rootId AND filePath=@filePath`);
  return result.recordset.length > 0;
}

async function addFavorite(userId, rootId, filePath) {
  const pool = await getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('rootId', sql.NVarChar, rootId)
    .input('filePath', sql.NVarChar, filePath)
    .query(`INSERT INTO FileFavorites (userId, rootId, filePath) VALUES (@userId, @rootId, @filePath)`);
}

async function removeFavorite(userId, rootId, filePath) {
  const pool = await getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('rootId', sql.NVarChar, rootId)
    .input('filePath', sql.NVarChar, filePath)
    .query(`DELETE FROM FileFavorites WHERE userId=@userId AND rootId=@rootId AND filePath=@filePath`);
}

// ---- Tags -------------------------------------------------------------------

async function getTags(rootId, filePath) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('rootId', sql.NVarChar, rootId)
    .input('filePath', sql.NVarChar, filePath)
    .query(`SELECT tag FROM FileTags WHERE rootId=@rootId AND filePath=@filePath ORDER BY tag`);
  return result.recordset.map((r) => r.tag);
}

async function getTagsAll() {
  const pool = await getPool();
  const result = await pool
    .request()
    .query(`SELECT tag, COUNT(*) AS count FROM FileTags GROUP BY tag ORDER BY tag`);
  return result.recordset;
}

async function addTag(rootId, filePath, tag, createdBy) {
  const pool = await getPool();
  await pool
    .request()
    .input('rootId', sql.NVarChar, rootId)
    .input('filePath', sql.NVarChar, filePath)
    .input('tag', sql.NVarChar, tag)
    .input('createdBy', sql.Int, createdBy)
    .query(`INSERT INTO FileTags (rootId, filePath, tag, createdBy) VALUES (@rootId, @filePath, @tag, @createdBy)`);
}

async function removeTag(rootId, filePath, tag) {
  const pool = await getPool();
  await pool
    .request()
    .input('rootId', sql.NVarChar, rootId)
    .input('filePath', sql.NVarChar, filePath)
    .input('tag', sql.NVarChar, tag)
    .query(`DELETE FROM FileTags WHERE rootId=@rootId AND filePath=@filePath AND tag=@tag`);
}

// ---- Per-folder ACLs --------------------------------------------------------

// Most-specific ACL row for (user, root, folderPath): '' (whole root) or any
// ancestor-or-self of folderPath, longest match wins.
async function getMostSpecificAcl(userId, rootId, folderPath) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('rootId', sql.NVarChar, rootId)
    .input('folderPath', sql.NVarChar, folderPath || '')
    .query(`
      SELECT TOP 1 id, userId, rootId, folderPath, canRead, canWrite
      FROM FileServerACLs
      WHERE userId=@userId AND rootId=@rootId
        AND (folderPath = '' OR @folderPath = folderPath OR @folderPath LIKE folderPath + '/%')
      ORDER BY LEN(folderPath) DESC
    `);
  return result.recordset[0] || null;
}

async function getAclsForPath(userId, rootId, folderPath) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('rootId', sql.NVarChar, rootId)
    .input('folderPath', sql.NVarChar, folderPath || '')
    .query(`
      SELECT id, userId, rootId, folderPath, canRead, canWrite
      FROM FileServerACLs
      WHERE rootId=@rootId AND (folderPath='' OR @folderPath = folderPath OR @folderPath LIKE folderPath + '/%')
      ORDER BY folderPath
    `);
  return result.recordset;
}

// List all ACLs for a root (admin view).
async function getAcls(rootId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('rootId', sql.NVarChar, rootId)
    .query(`
      SELECT a.id, a.userId, u.username, a.rootId, a.folderPath, a.canRead, a.canWrite, a.createdAt
      FROM FileServerACLs a
      LEFT JOIN Users u ON u.id = a.userId
      WHERE a.rootId = @rootId
      ORDER BY a.folderPath, u.username
    `);
  return result.recordset;
}

async function upsertAcl(userId, rootId, folderPath, canRead, canWrite, createdBy) {
  const pool = await getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('rootId', sql.NVarChar, rootId)
    .input('folderPath', sql.NVarChar, folderPath || '')
    .input('canRead', sql.Bit, canRead ? 1 : 0)
    .input('canWrite', sql.Bit, canWrite ? 1 : 0)
    .input('createdBy', sql.Int, createdBy).query(`
      MERGE FileServerACLs AS target
      USING (SELECT @userId AS userId, @rootId AS rootId, @folderPath AS folderPath) AS src
        ON target.userId = src.userId AND target.rootId = src.rootId AND target.folderPath = src.folderPath
      WHEN MATCHED THEN
        UPDATE SET canRead = @canRead, canWrite = @canWrite, createdBy = @createdBy, createdAt = SYSDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (userId, rootId, folderPath, canRead, canWrite, createdBy)
        VALUES (@userId, @rootId, @folderPath, @canRead, @canWrite, @createdBy);
    `);
}

async function removeAcl(userId, rootId, folderPath) {
  const pool = await getPool();
  await pool
    .request()
    .input('userId', sql.Int, userId)
    .input('rootId', sql.NVarChar, rootId)
    .input('folderPath', sql.NVarChar, folderPath || '')
    .query(`DELETE FROM FileServerACLs WHERE userId=@userId AND rootId=@rootId AND folderPath=@folderPath`);
}

// ---- Users (for the admin access picker) ------------------------------------

async function getUsers() {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT id, username FROM Users ORDER BY username`);
  return result.recordset;
}

module.exports = {
  getFavorites,
  isFavorite,
  addFavorite,
  removeFavorite,
  getTags,
  getTagsAll,
  addTag,
  removeTag,
  getMostSpecificAcl,
  getAclsForPath,
  getAcls,
  upsertAcl,
  removeAcl,
  getUsers,
};
