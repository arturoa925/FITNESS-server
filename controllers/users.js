const router = require("express").Router();
const { Users, Calendar, DailyWorkout, TrainingPrograms } = require("../models");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const sequelize = require("../config/connection");
const { Op } = require("sequelize");
const tokenauth = require("../utils/tokenauth");
require("dotenv").config();
const { v4: uuidv4 } = require("uuid");

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Upsert a calendar entry and append a workout (with dedupe by externalId or id).
 * @param {string} userId
 * @param {string} date - YYYY-MM-DD
 * @param {object} workout - arbitrary workout payload
 */
async function addWorkoutToCalendar(userId, date, workout) {
    const [calendar] = await Calendar.findOrCreate({
        where: { userId, date },
        defaults: { workouts: [], foods: [] },
    });

    const wid = workout.id || uuidv4();
    const payload = { id: wid, ...workout };

    const exists = (calendar.workouts || []).some((w) => {
        if (payload.externalId && w.externalId) {
            return String(w.externalId) === String(payload.externalId);
        }
        return String(w.id) === String(payload.id);
    });

    if (!exists) {
        calendar.workouts = [...(calendar.workouts || []), payload];
        await calendar.save();
    }
    return calendar;
}

// * user service routes
// create a new user

router.post("/register", async (req, res) => {
    try {
        const { firstName, lastName, email, password, profilePicture } = req.body;

        // Check if user already exists
        const existingUser = await Users.findOne({ where: { email } });
        if (existingUser) {
            return res.status(400).json({ message: "User already exists" });
        }

        // Create new user
        const newUser = await Users.create({
            id: uuidv4(),
            firstName,
            lastName,
            email,
            password,
            profilePicture
        });

        // Generate JWT token
        const token = jwt.sign({ id: newUser.id }, JWT_SECRET, { expiresIn: "1h" });

        res.status(201).json({ token, user: newUser });
    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// User login

router.post("/login", async (req, res) => {
    try {
        console.log("Request Body:", req.body);
    
        if (!req.body.email || !req.body.password) {
          return res.status(400).json({ message: "Missing userName or password" });
        }

        const user = await Users.findOne({
            where: { email: req.body.email },
          });
      
          if (!user) {
            return res.status(400).json({ message: "User not found" });
          }

          const validPassword = await bcrypt.compare(
            req.body.password,
            user.password
          );
      
          if (!validPassword) {
            return res.status(400).json({ message: "Invalid password" });
          }

          // Generate JWT token
            const token = jwt.sign({ id: user.id }, JWT_SECRET, { expiresIn: "1h" });

            res.status(200).json({ token, user });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// logout user
router.post("/logout", tokenauth, async (req, res) => {
    try {
        // Invalidate the token by simply not returning it
        res.status(200).json({ message: "User logged out successfully" });
    } catch (error) {
        console.error("Logout error:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// Get user profile by ID
router.get("/:id", async (req, res) => {
    try {
        const user = await Users.findByPk(req.params.id, {
            attributes: { exclude: ["password"] },
        });

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        res.status(200).json(user);
    } catch (error) {
        console.error("Error fetching user profile:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// Update user profile
router.put("/:id", tokenauth, async (req, res) => {
    try {
        const user = await Users.findByPk(req.params.id);

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        // Update user details
        const updatedUser = await user.update(req.body);

        res.status(200).json(updatedUser);
    } catch (error) {
        console.error("Error updating user profile:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// * user training programs routes

// create a new training program
router.post("/:id/training-programs", tokenauth, async (req, res) => {
    try {
        const { name, description, workouts, duration } = req.body;

        // Create new training program
        const newTrainingProgram = await TrainingPrograms.create({
            userId: req.params.id,
            name,
            description,
            workouts,
            duration,
        });

        res.status(201).json(newTrainingProgram);
    } catch (error) {
        console.error("Error creating training program:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// check if user has a training program
router.get("/:id/training-programs", tokenauth, async (req, res) => {
    try {
        const trainingProgram = await TrainingPrograms.findOne({
            where: { userId: req.params.id },
        });

        if (!trainingProgram) {
            return res.status(404).json({ message: "Training program not found" });
        }

        res.status(200).json(trainingProgram);
    } catch (error) {
        console.error("Error fetching training program:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// update user training program
router.put("/:id/training-programs", tokenauth, async (req, res) => {
    try {
        const trainingProgram = await TrainingPrograms.findOne({
            where: { userId: req.params.id },
        });

        if (!trainingProgram) {
            return res.status(404).json({ message: "Training program not found" });
        }

        // Update training program details
        const updatedProgram = await trainingProgram.update(req.body);

        res.status(200).json(updatedProgram);
    } catch (error) {
        console.error("Error updating training program:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// * user daily workout routes

// check if user has a daily workout
router.get("/:id/daily-workout", tokenauth, async (req, res) => {
    try {
        const dailyWorkout = await DailyWorkout.findOne({
            where: { userId: req.params.id },
        });

        if (!dailyWorkout) {
            return res.status(404).json({ message: "Daily workout not found" });
        }

        res.status(200).json(dailyWorkout);
    } catch (error) {
        console.error("Error fetching daily workout:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});


// * user calendar routes

// get user calendar entries with support for range/month queries
router.get("/:id/calendar", tokenauth, async (req, res) => {
    try {
        const { from, to, month, year } = req.query;
        const where = { userId: req.params.id };

        if (from && to) {
            where.date = { [Op.between]: [from, to] };
        } else if (month && year) {
            const mm = String(month).padStart(2, "0");
            // Entries are stored as DATEONLY (YYYY-MM-DD)
            where.date = { [Op.between]: [`${year}-${mm}-01`, `${year}-${mm}-31`] };
        }

        const calendars = await Calendar.findAll({
            where,
            order: [["date", "ASC"]],
        });

        res.status(200).json(calendars);
    } catch (error) {
        console.error("Error fetching calendar:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});


// Add food to a specific day
router.post("/:id/calendar/:date/foods", tokenauth, async (req, res) => {
    try {
        const { food } = req.body; // expect { id?, name, calories, photoUrl, ... }
        if (!food) return res.status(400).json({ message: "Missing food object" });

        const [calendar] = await Calendar.findOrCreate({
            where: { userId: req.params.id, date: req.params.date },
            defaults: { foods: [], workouts: [] },
        });

        const withId = { id: food.id || uuidv4(), ...food };
        calendar.foods = [...(calendar.foods || []), withId];
        await calendar.save();

        res.status(200).json(calendar);
    } catch (error) {
        console.error("Error adding food to calendar:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// Remove a food from a specific day by id
router.delete("/:id/calendar/:date/foods/:foodId", tokenauth, async (req, res) => {
    try {
        const calendar = await Calendar.findOne({
            where: { userId: req.params.id, date: req.params.date },
        });

        if (!calendar) {
            return res.status(404).json({ message: "Calendar not found" });
        }

        const before = calendar.foods || [];
        calendar.foods = before.filter((item) => String(item.id) !== String(req.params.foodId));
        await calendar.save();

        res.status(200).json(calendar);
    } catch (error) {
        console.error("Error removing food from calendar:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// Add a workout entry to a specific day
router.post("/:id/calendar/:date/workouts", tokenauth, async (req, res) => {
    try {
        const { workout } = req.body; // expect { id?, name, exercises: [...], notes?, source?, externalId? }
        if (!workout) return res.status(400).json({ message: "Missing workout object" });

        const tagged = { source: workout.source || "manual", ...workout };
        const calendar = await addWorkoutToCalendar(req.params.id, req.params.date, tagged);
        res.status(200).json(calendar);
    } catch (error) {
        console.error("Error adding workout to calendar:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// Log a daily workout (convenience) and add to calendar
router.post("/:id/daily-workout/log", tokenauth, async (req, res) => {
    try {
        const { date, workout } = req.body; // expect date: YYYY-MM-DD and workout object
        if (!date || !workout) return res.status(400).json({ message: "Missing date or workout" });

        const tagged = { source: "daily", ...workout };
        const calendar = await addWorkoutToCalendar(req.params.id, date, tagged);
        res.status(200).json(calendar);
    } catch (error) {
        console.error("Error logging daily workout:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// Log a training program workout and add to calendar
router.post("/:id/training-programs/:programId/workouts/log", tokenauth, async (req, res) => {
    try {
        const { date, workout, weekIndex, dayIndex, workoutIndex } = req.body;
        if (!date || !workout) return res.status(400).json({ message: "Missing date or workout" });

        const tagged = {
            source: "program",
            programMeta: {
                programId: req.params.programId,
                weekIndex,
                dayIndex,
                workoutIndex,
            },
            ...workout,
        };

        const calendar = await addWorkoutToCalendar(req.params.id, date, tagged);
        res.status(200).json(calendar);
    } catch (error) {
        console.error("Error logging program workout:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});



module.exports = router;
    