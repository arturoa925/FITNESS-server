require("dotenv").config();
const sequelize = require("./config/connection");
const express = require("express");
const PORT = process.env.PORT || 3004;
const routes = require("./controllers");
const path = require("path");
const cors = require("cors");

const app =  express();

const allowedOrigins = [
  "http://localhost:5173", // Local development frontend 
   // Deployed frontend
];

const corsOptions = {
  origin: function (origin, callback) {
    if (allowedOrigins.includes(origin) || !origin) {
      callback(null, true); // Allow requests from valid origins or non-browser clients
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true, // Allow cookies or authorization headers
};
app.use(cors(corsOptions));
// Preflight handling for Express 5 (avoid '*' path-to-regexp errors)
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use((req, res, next) => {
  console.log(`Incoming request: ${req.method} ${req.url}`);
  next();
});
app.use(routes);

sequelize.sync({ force: false }).then(() => {
  app.listen(PORT, () => console.log(`App is listening on port: ${PORT}`));
});
