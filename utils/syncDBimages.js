// utils/syncDBimages.js
// This script syncs images from the public/images folder to the database.
// It checks if each image exists in the database and inserts it if not.

// or suposed to, i do not have an idea if its works.
// wanted to do this, but no time

const fs = require('fs');
const path = require('path');
const sql = require('mssql');
const dbConfig = require('./dbConfig');
const imageModel = require('./models/imageModel');

async function syncImagesFolderToDatabase() {
  try {
    await sql.connect(dbConfig);

    const imagesDir = path.join(__dirname, 'public/images');
    const files = fs.readdirSync(imagesDir);

    for (const file of files) {
      const filePath = `images/${file}`; // relative to public folder

      // Check if file already in DB
      const existing = await imageModel.getAllImages();
      const exists = existing.some(img => img.filename === file);

      if (!exists) {
        // Insert with default title (could be filename without extension)
        const title = path.parse(file).name;
        await imageModel.createImage(title, filePath, file);
        console.log(`Inserted ${file} into database`);
      } else {
        console.log(`${file} already exists in database`);
      }
    }
  } catch (err) {
    console.error('Error syncing images folder:', err);
  } finally {
    await sql.close();
  }
}

// Uncomment to run:
syncImagesFolderToDatabase();
