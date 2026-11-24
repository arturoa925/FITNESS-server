require("dotenv").config();

// Fail fast: without these the app would boot but every auth call would 500.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error("FATAL: JWT_SECRET must be set (at least 16 characters).");
  process.exit(1);
}

const sequelize = require("./config/connection");
const express = require("express");
const PORT = process.env.PORT || 3004;
const routes = require("./controllers");
const path = require("path");
const cors = require("cors");

const app = express();

// Behind a reverse proxy (Render, Heroku, nginx) req.ip is the proxy unless this
// is set, which makes per-IP rate limiting lock out everyone at once.
// Set TRUST_PROXY to the number of proxy hops (default 1 in production).
const trustProxy =
  process.env.TRUST_PROXY !== undefined
    ? Number(process.env.TRUST_PROXY)
    : process.env.NODE_ENV === "production"
    ? 1
    : 0;
if (trustProxy) app.set("trust proxy", trustProxy);
app.disable("x-powered-by");

// Allowed browser origins: local dev, CLIENT_WEB_URL, plus ALLOWED_ORIGINS (comma separated).
const allowedOrigins = new Set(
  [
    "http://localhost:5173",
    process.env.CLIENT_WEB_URL,
    ...(process.env.ALLOWED_ORIGINS || "").split(","),
  ]
    .map((o) => (o || "").trim().replace(/\/+$/, ""))
    .filter(Boolean)
);

const corsOptions = {
  // Non-browser clients (the mobile app) send no Origin header and are allowed.
  // Disallowed browser origins simply get no CORS headers (no 500/stack trace).
  origin: (origin, callback) =>
    callback(null, !origin || allowedOrigins.has(origin)),
  credentials: true,
};
app.use(cors(corsOptions));

// Baseline security headers (lightweight stand-in for helmet).
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=15552000");
  }
  next();
});

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

// Log method + path only. Query strings carry OAuth codes/state and must not be logged.
app.use((req, res, next) => {
  console.log(`Incoming request: ${req.method} ${req.path}`);
  next();
});

app.use(routes);

app.use((req, res) => res.status(404).json({ message: "Not found" }));

// Central error handler: multer/body-parser/etc. errors become clean 4xx JSON
// instead of Express's default HTML page (which includes stack traces in dev).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.name === "MulterError") {
    return res.status(400).json({ message: err.message });
  }
  if (err && err.message === "Unsupported file type") {
    return res.status(415).json({ message: err.message });
  }
  if (err && (err.type === "entity.too.large" || err.status === 413)) {
    return res.status(413).json({ message: "Payload too large" });
  }
  if (err && (err.type === "entity.parse.failed" || err.status === 400)) {
    return res.status(400).json({ message: "Invalid request body" });
  }
  console.error("Unhandled error:", err);
  res.status(500).json({ message: "Internal server error" });
});

const { ensureConstraints } = require("./db/ensureConstraints");

// Merge any legacy duplicate rows and add unique indexes first, then create missing tables.
ensureConstraints()
  .then(() => sequelize.sync({ force: false }))
  .then(() => {
    app.listen(PORT, () => console.log(`App is listening on port: ${PORT}`));
  })
  .catch((err) => {
    console.error("FATAL: database setup failed:", err);
    process.exit(1);
  });
