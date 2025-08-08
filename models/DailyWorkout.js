const { Model, DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/connection");

class DailyWorkout extends Model {}

DailyWorkout.init(
    {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
        },
        exercises: {
            type: DataTypes.JSONB, // Array of exercise objects
            allowNull: true,
            defaultValue: [],
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: true,
            defaultValue: Sequelize.fn("NOW"),
        },
    },
    {
        sequelize,
        modelName: "DailyWorkout",
    }
);

module.exports = DailyWorkout;