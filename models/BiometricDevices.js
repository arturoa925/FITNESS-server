const { Model, DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/connection");

// One row per device a user has enabled Face ID / biometric login on.
// The device keeps a random secret in the OS keychain (behind Face ID); only
// its SHA-256 hash is stored here, so a database leak can't be used to log in.
class BiometricDevices extends Model {}

BiometricDevices.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    secretHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    deviceName: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: true,
      defaultValue: Sequelize.fn("NOW"),
    },
  },
  { sequelize, modelName: "BiometricDevices" }
);

module.exports = BiometricDevices;
