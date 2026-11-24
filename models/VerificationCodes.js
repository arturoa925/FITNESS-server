const { Model, DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/connection");

// Short-lived 6-digit codes emailed to a user: purpose "reset" (forgot password) or
// "verify" (confirm email). Only an HMAC of the code is stored.
class VerificationCodes extends Model {}

VerificationCodes.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    purpose: { type: DataTypes.STRING(20), allowNull: false },
    codeHash: { type: DataTypes.STRING(64), allowNull: false },
    attempts: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    createdAt: { type: DataTypes.DATE, allowNull: true, defaultValue: Sequelize.fn("NOW") },
  },
  { sequelize, modelName: "VerificationCodes" }
);

module.exports = VerificationCodes;
