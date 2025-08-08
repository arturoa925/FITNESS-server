const { Model, DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/connection");

class Calendar extends Model {}

Calendar.init(
    {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
        },
        date: {
            type: DataTypes.DATEONLY,
            allowNull: false,
        },
        workouts: {
            type: DataTypes.JSONB,
            allowNull: true,
            defaultValue: [],
        },
        foods: {
            type: DataTypes.JSONB,
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
        modelName: "Calendar",
    }
);

module.exports = Calendar;