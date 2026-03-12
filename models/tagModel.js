const sql = require("mssql");
const dbConfig = require("../dbConfig");

// Get all tags with count
async function getAllTags() {
  try {
    console.log("[TagModel] Fetching all tags with their usage count...");
    const pool = await sql.connect(dbConfig);
    const result = await pool.request().query(`
      SELECT t.name, COUNT(it.tagId) AS count
      FROM Tags t
      LEFT JOIN ImageTags it ON t.id = it.tagId
      GROUP BY t.name
      ORDER BY count DESC
    `);
    console.log(`[TagModel] Retrieved ${result.recordset.length} tags.`);
    return result.recordset;
  } catch (error) {
    console.error("[TagModel] Error in getAllTags:", error);
    throw error;
  }
}

// Get tags for a specific image
async function getTagsByImageId(imageId) {
  try {
    console.log(`[TagModel] Fetching tags for image ID: ${imageId}`);
    const pool = await sql.connect(dbConfig);
    const result = await pool.request()
      .input("imageId", sql.Int, imageId)
      .query(`
        SELECT t.name
        FROM ImageTags it
        JOIN Tags t ON it.tagId = t.id
        WHERE it.imageId = @imageId
      `);
    console.log(`[TagModel] Found ${result.recordset.length} tags for image ID ${imageId}`);
    return result.recordset;
  } catch (error) {
    console.error(`[TagModel] Error in getTagsByImageId(${imageId}):`, error);
    throw error;
  }
}

module.exports = {
  getAllTags,
  getTagsByImageId,
};
