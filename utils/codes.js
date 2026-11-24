// Issue / check the 6-digit email codes (password reset, email verification).
const crypto = require("crypto");
const { Op } = require("sequelize");
const sequelize = require("../config/connection");
const { VerificationCodes } = require("../models");

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 3;

const hashCode = (userId, purpose, code) =>
  crypto.createHmac("sha256", process.env.JWT_SECRET).update(`${userId}:${purpose}:${code}`).digest("hex");

// Returns the new code, or null if this user asked for too many in the last hour.
// The count-then-create runs under a per-(user,purpose) advisory lock so a burst of
// simultaneous requests can't all see "0 so far" and each get a code.
async function issueCode(userId, purpose) {
  return sequelize.transaction(async (t) => {
    await sequelize.query("SELECT pg_advisory_xact_lock(hashtext(:k))", {
      replacements: { k: `code:${userId}:${purpose}` },
      transaction: t,
    });

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recent = await VerificationCodes.count({
      where: { userId, purpose, createdAt: { [Op.gt]: hourAgo } },
      transaction: t,
    });
    if (recent >= MAX_CODES_PER_HOUR) return null;

    // housekeeping: forget codes older than a day
    await VerificationCodes.destroy({
      where: { userId, createdAt: { [Op.lt]: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
      transaction: t,
    });

    const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
    await VerificationCodes.create(
      { userId, purpose, codeHash: hashCode(userId, purpose, code), expiresAt: new Date(Date.now() + CODE_TTL_MS) },
      { transaction: t }
    );
    return code;
  });
}

// True (and the code is consumed) only for the newest, unexpired code with attempts left.
async function checkCode(userId, purpose, code) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  const row = await VerificationCodes.findOne({
    where: { userId, purpose },
    order: [["createdAt", "DESC"]],
  });
  if (!row || row.expiresAt < new Date()) return false;
  if (row.attempts >= MAX_ATTEMPTS) return false;

  const a = Buffer.from(hashCode(userId, purpose, code), "hex");
  const b = Buffer.from(row.codeHash, "hex");
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    await row.destroy(); // single use
    return true;
  }
  await row.increment("attempts");
  return false;
}

module.exports = { issueCode, checkCode, CODE_TTL_MS, MAX_ATTEMPTS, MAX_CODES_PER_HOUR };
