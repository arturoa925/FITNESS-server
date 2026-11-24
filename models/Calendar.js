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
        // one row per user per day (see db/ensureConstraints.js)
        indexes: [
            { unique: true, fields: ["userId", "date"], name: "calendars_user_id_date_unique" },
        ],
    }
);

module.exports = Calendar;