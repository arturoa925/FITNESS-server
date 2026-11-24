const { Model, DataTypes, Sequelize } = require("sequelize");
const sequelize = require("../config/connection");

class TrainingPrograms extends Model {}

TrainingPrograms.init(
    {
        id: {
            type: DataTypes.UUID,
            defaultValue: DataTypes.UUIDV4,
            primaryKey: true,
        },
        name: {
            type: DataTypes.STRING,
            allowNull: false,
        },
        description: {
            type: DataTypes.TEXT,
            allowNull: false,
        },
        workouts: {
            type: DataTypes.JSONB, // Array of workout objects
            allowNull: true,
            defaultValue: [],
        },
        duration: {
            type: DataTypes.INTEGER, // Duration in weeks
            allowNull: false,
        },
        createdAt: {
            type: DataTypes.DATE,
            allowNull: true,
            defaultValue: Sequelize.fn("NOW"),
        },
    },
    {
        sequelize,
        modelName: "TrainingPrograms",
        // one personal program per user; template rows have userId NULL (NULLs are allowed repeatedly)
        indexes: [
            { unique: true, fields: ["userId"], name: "training_programs_user_id_unique" },
        ],
    }
);

module.exports = TrainingPrograms;