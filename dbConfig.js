require("dotenv").config();
console.log("DB_SERVER:", process.env.DB_SERVER);


module.exports = {
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  server: process.env.DB_SERVER,
  database: process.env.DB_DATABASE,
  port: parseInt(process.env.DB_PORT), // Default SQL Server port
  options: {

    connectionTimeout: 60000, // Connection timeout in milliseconds
    encrypt: false, // for local dev
    trustServerCertificate: true // required for self-signed certs
  },
  connectionTimeout: 60000, // Connection timeout in milliseconds
};

