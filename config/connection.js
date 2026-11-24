const Sequelize = require("sequelize");
require("dotenv").config();

const sequelize = process.env.DATABASE_URL
  ? new Sequelize(process.env.DATABASE_URL, {
      dialect: "postgres",
      protocol: "postgres",
      dialectOptions: {
        ssl: {
          require: true, // Ensure SSL is required
          // Verify the server cert by default. Set DB_SSL_REJECT_UNAUTHORIZED=false
          // only if your host uses a self-signed certificate.
          rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false",
        },
      },
      pool: {
        max: 5,
        min: 0,
        acquire: 30000, // Increase timeout here (default is 10000ms)
        idle: 10000,
      },
    })
  : new Sequelize(process.env.DB_NAME, process.env.DB_USER, process.env.DB_PW, {
      host: process.env.DB_HOST || "localhost",
      port: Number(process.env.DB_PORT) || 5432,
      dialect: "postgres",
    });
module.exports = sequelize;
