const Users = require("./Users");
const Calendar = require("./Calendar");
const DailyWorkout = require("./DailyWorkout");
const TrainingPrograms = require("./TrainingPrograms");
const BiometricDevices = require("./BiometricDevices");

// Associations

Users.hasOne(TrainingPrograms, {
    foreignKey: "userId",
    onDelete: "CASCADE",
});     

TrainingPrograms.belongsTo(Users, {
    foreignKey: "userId",
    onDelete: "CASCADE",
});

Users.hasOne(Calendar, {
    foreignKey: "userId",
    onDelete: "CASCADE",
});

Calendar.belongsTo(Users, {
    foreignKey: "userId",
    onDelete: "CASCADE",
});

Users.hasOne(DailyWorkout, {
    foreignKey: "userId",
    onDelete: "CASCADE",
});

DailyWorkout.belongsTo(Users, {
    foreignKey: "userId",
    onDelete: "CASCADE",
});

Users.hasMany(BiometricDevices, {
    foreignKey: "userId",
    onDelete: "CASCADE",
});

BiometricDevices.belongsTo(Users, {
    foreignKey: "userId",
    onDelete: "CASCADE",
});

module.exports = {
    Users,
    Calendar,
    DailyWorkout,
    TrainingPrograms,
    BiometricDevices,
};
