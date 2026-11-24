const { Model, DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/connection");

// One row per signed-in session (device). The client holds "<id>.<secret>"; only the
// SHA-256 of the secret is stored. The secret rotates on every refresh.
class RefreshTokens extends Model {}

RefreshTokens.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    secretHash: { type: DataTypes.STRING(64), allowNull: false },
    // The previous secret stays valid for a few seconds so a lost response or two
    // concurrent refreshes don't look like token theft.
    prevSecretHash: { type: DataTypes.STRING(64), allowNull: true },
    rotatedAt: { type: DataTypes.DATE, allowNull: true },
    expiresAt: { type: DataTypes.DATE, allowNull: false },
    lastUsedAt: { type: DataTypes.DATE, allowNull: true },
    createdAt: { type: DataTypes.DATE, allowNull: true, defaultValue: Sequelize.fn("NOW") },
  },
  { sequelize, modelName: "RefreshTokens" }
);

module.exports = RefreshTokens;
