const sql = require("mssql");
const dbConfig = require("../dbConfig");

// Get all images
async function getAllImages() {
  try {
    console.log("[ImageModel] Connecting to DB:", dbConfig.database);
    const pool = await sql.connect(dbConfig);
    const result = await pool.request().query("SELECT * FROM dbo.Images"); //const result = await pool.request().execute("GetAllImages"); TODO:// 
    console.log(`[ImageModel] Fetched ${result.recordset.length} images`); //calls procedure name GetAllImages
    return result.recordset;
  } catch (err) {
    console.error("[ImageModel][getAllImages] Error:", err);
    throw err;
  }
}

// Create new image
async function createImage(title, filepath, filename) {
  try {
    console.log(`[ImageModel] Creating image: title='${title}', filepath='${filepath}', filename='${filename}'`);
    const pool = await sql.connect(dbConfig);
    const result = await pool
      .request()
      .input("title", sql.NVarChar, title)
      .input("filepath", sql.NVarChar, filepath)
      .input("filename", sql.NVarChar, filename)
      .input("dateAdded", sql.DateTime, new Date())
      .query(`
        INSERT INTO Images (title, filepath, filename, dateAdded)
        VALUES (@title, @filepath, @filename, @dateAdded);
        SELECT SCOPE_IDENTITY() AS newId;
      `);

    const newId = result.recordset[0].newId;
    console.log(`[ImageModel] Image created successfully with ID: ${newId}`);
    return { id: newId, title, filepath, filename };
  } catch (error) {
    console.error("[ImageModel][createImage] Error:", error);
    throw error;
  }
}

// Get image by ID, including tags
async function getImageById(id) {
  try {
    console.log(`[ImageModel] Fetching image with ID: ${id}`);
    const pool = await sql.connect(dbConfig);

    // Fetch image
    const imageResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query("SELECT * FROM dbo.Images WHERE id = @id");

    if (imageResult.recordset.length === 0) {
      console.log(`[ImageModel] Image with ID ${id} not found`);
      return null;
    }

    const image = imageResult.recordset[0];

    // Fetch associated tags
    const tagResult = await pool
      .request()
      .input("id", sql.Int, id)
      .query(`
        SELECT t.name
        FROM dbo.Tags t
        INNER JOIN dbo.ImageTags it ON t.id = it.tagId
        WHERE it.imageId = @id
      `);

    image.tags = tagResult.recordset.map(row => row.name);

    console.log(`[ImageModel] Image with ID ${id} and ${image.tags.length} tags fetched`);
    return image;

  } catch (err) {
    console.error("[ImageModel][getImageById] Error:", err);
    throw err;
  }
}


// Update image title by ID
async function updateImage(id, imageData) {
  try {
    console.log(`[ImageModel] Updating image ID ${id} with data:`, imageData);
    const pool = await sql.connect(dbConfig);
    const result = await pool.request()
      .input("id", sql.Int, id)
      .input("title", sql.NVarChar, imageData.title)
      .query(`
        UPDATE Images
        SET title = @title
        WHERE id = @id;

        SELECT * FROM Images WHERE id = @id;
      `);
    if (result.recordset.length === 0) {
      console.log(`[ImageModel] No image found to update with ID ${id}`);
      return null;
    }
    console.log(`[ImageModel] Image with ID ${id} updated`);
    return result.recordset[0]; // return updated image
  } catch (err) {
    console.error("[ImageModel][updateImage] Error:", err);
    throw err;
  }
}

// Delete image by ID
async function deleteImage(id) {
  try {
    console.log(`[ImageModel] Deleting image with ID: ${id}`);
    const pool = await sql.connect(dbConfig);
    const result = await pool.request()
      .input("id", sql.Int, id)
      .query("DELETE FROM Images WHERE id = @id");

    const deleted = result.rowsAffected[0] > 0;
    console.log(`[ImageModel] Image with ID ${id} deletion status: ${deleted}`);
    return deleted;
  } catch (err) {
    console.error("[ImageModel][deleteImage] Error:", err);
    throw err;
  }
}

module.exports = {
  getAllImages,
  createImage,
  updateImage,
  getImageById,
  deleteImage
};
