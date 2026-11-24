const { Calendar, DailyWorkout, TrainingPrograms, Users } = require("../models");
const usersData = require("./users.json")
const trainingProgramsData = require("./trainingprogram.json");
const dailyWorkoutData = require("./dailyworkout.json");

const sequelize = require("../config/connection");

const seedDatabase = async () => {
// sync({ force: true }) DROPS every table. Never allow it against production by accident.
if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED !== "true") {
    console.error("Refusing to seed: NODE_ENV=production. Set ALLOW_SEED=true to override.");
    process.exit(1);
}
try {
    await sequelize.sync({ force: true });

    // Seed Users
    const users = await Users.bulkCreate(usersData, {
        individualHooks: true,
        returning: true,
    });

    // Seed Training Programs
    await TrainingPrograms.bulkCreate(trainingProgramsData);

    // Seed Daily Workouts
    await DailyWorkout.bulkCreate(dailyWorkoutData);

    // Seed Calendar based on users.json seedMeta.calendarDays
    const calendarRows = [];

    users.forEach((userInstance, index) => {
      const rawUser = usersData[index];
      const seedMeta = rawUser && rawUser.seedMeta;

      if (seedMeta && Array.isArray(seedMeta.calendarDays)) {
        seedMeta.calendarDays.forEach((day) => {
          if (!day || !day.date) return;

          calendarRows.push({
            userId: userInstance.id,
            // Store ISO date string (YYYY-MM-DD) for DATE type column
            date: day.date,
            workouts: day.workouts || [],
            foods: day.foods || [],
          });
        });
      }
    });

    if (calendarRows.length > 0) {
      await Calendar.bulkCreate(calendarRows);
    }

    console.log("Database seeded successfully!");
}
catch (error) {
    console.error("Error seeding database:", error);
} finally {
    process.exit(0);
}
};

seedDatabase()