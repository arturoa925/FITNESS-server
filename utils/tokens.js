// Access + refresh token helpers (single place so every login path behaves the same).
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { RefreshTokens } = require("../models");

const ACCESS_TTL = process.env.ACCESS_TOKEN_TTL || "15m";
const REFRESH_TTL_MS =
  (Number(process.env.REFRESH_TOKEN_TTL_DAYS) || 30) * 24 * 60 * 60 * 1000; // sliding
const GRACE_MS = 30 * 1000;
const MAX_SESSIONS_PER_USER = 10;

const sha256 = (v) => crypto.createHash("sha256").update(v).digest("hex");
const newSecret = () => crypto.randomBytes(32).toString("hex");
const safeEqualHex = (a, b) => {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const signAccessToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, { algorithm: "HS256", expiresIn: ACCESS_TTL });

// "<rowId>.<secret>" (hex, so it's cheap to validate)
function parseRefreshToken(raw) {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const [id, secret] = raw.split(".");
  if (!/^[0-9a-f-]{36}$/i.test(id || "") || !/^[0-9a-f]{64}$/.test(secret || "")) return null;
  return { id, secret };
}

// Start a new session for a user; returns the refresh token string.
async function createRefreshToken(userId) {
  const existing = await RefreshTokens.findAll({
    where: { userId },
    order: [["createdAt", "DESC"]],
  });
  for (const old of existing.slice(MAX_SESSIONS_PER_USER - 1)) await old.destroy();

  const secret = newSecret();
  const row = await RefreshTokens.create({
    userId,
    secretHash: sha256(secret),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });
  return `${row.id}.${secret}`;
}

// Convenience: a complete session for a freshly authenticated user.
async function issueSession(userId) {
  return { token: signAccessToken(userId), refreshToken: await createRefreshToken(userId) };
}

// Exchange a refresh token for a new access token + rotated refresh token.
// Returns { userId, token, refreshToken } or null if invalid.
async function rotateRefreshToken(raw) {
  const parsed = parseRefreshToken(raw);
  if (!parsed) return null;
  const row = await RefreshTokens.findByPk(parsed.id);
  if (!row) return null;

  const hash = sha256(parsed.secret);
  const isCurrent = safeEqualHex(hash, row.secretHash);
  const isRecentPrev =
    !isCurrent &&
    row.prevSecretHash &&
    row.rotatedAt &&
    Date.now() - row.rotatedAt.getTime() < GRACE_MS &&
    safeEqualHex(hash, row.prevSecretHash);

  if (!isCurrent && !isRecentPrev) {
    await row.destroy(); // an old secret was replayed: assume theft, end the whole session
    return null;
  }
  if (row.expiresAt < new Date()) {
    await row.destroy();
    return null;
  }

  const secret = newSecret();
  await row.update({
    prevSecretHash: row.secretHash,
    secretHash: sha256(secret),
    rotatedAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });
  return {
    userId: row.userId,
    token: signAccessToken(row.userId),
    refreshToken: `${row.id}.${secret}`,
  };
}

async function revokeRefreshToken(userId, raw) {
  const parsed = parseRefreshToken(raw);
  if (!parsed) return 0;
  return RefreshTokens.destroy({ where: { id: parsed.id, userId } });
}

const revokeAllRefreshTokens = (userId) => RefreshTokens.destroy({ where: { userId } });

module.exports = {
  signAccessToken,
  createRefreshToken,
  issueSession,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeAllRefreshTokens,
  ACCESS_TTL,
};
