const { Calendar, DailyWorkout, TrainingPrograms, Users} = require("../models");
const usersData = require("./users.json")
const trainingProgramsData = require("./trainingprogram.json");
const dailyWorkoutData = require("./dailyworkout.json");

const sequelize = require("../config/connection");

const seedDatabase = async () => {
try {
    await sequelize.sync({ force: true });

    // Seed Users
    const users = await Users.bulkCreate(usersData, {
        individualHooks: true,
        returning: true,
    });

    // Seed Training Programs
    const trainingPrograms = await TrainingPrograms.bulkCreate(trainingProgramsData);

    // Seed Daily Workouts
    const dailyWorkouts = await DailyWorkout.bulkCreate(dailyWorkoutData);

    // Seed Calendar
    const calendars = await Calendar.bulkCreate([
        { userId: users[0].id, date: new Date(), trainingProgramId: trainingPrograms[0].id },
        { userId: users[1].id, date: new Date(), trainingProgramId: trainingPrograms[1].id },
    ]);

    console.log("Database seeded successfully!");
}
catch (error) {
    console.error("Error seeding database:", error);
} finally {
    process.exit(0);
}
};

seedDatabase()