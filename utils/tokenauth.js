const jwt = require("jsonwebtoken");

const JWT_SECRET = process.env.JWT_SECRET;

// Authenticates the request. Expects "Authorization: Bearer <jwt>".
// 401 = missing/invalid/expired credentials (clients treat this as "log in again").
const tokenauth = (req, res, next) => {
  const header = req.headers["authorization"];
  if (!header || typeof header !== "string") {
    return res.status(401).json({ message: "No token provided" });
  }

  const [scheme, token] = header.split(" ");
  if (!/^Bearer$/i.test(scheme || "") || !token) {
    return res.status(401).json({ message: "Malformed Authorization header" });
  }

  jwt.verify(token, JWT_SECRET, { algorithms: ["HS256"] }, (err, decoded) => {
    if (err || !decoded || !decoded.id) {
      const expired = err && err.name === "TokenExpiredError";
      return res.status(401).json({
        message: expired ? "Token expired" : "Failed to authenticate token",
      });
    }
    req.user = { id: decoded.id };
    next();
  });
};

// Authenticates AND requires that the :id in the URL is the caller's own id.
// Prevents users from reading/writing each other's data (IDOR).
const owner = [
  tokenauth,
  (req, res, next) => {
    if (String(req.user.id) !== String(req.params.id)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  },
];

module.exports = tokenauth;
module.exports.owner = owner;
