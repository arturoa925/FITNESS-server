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

function normalizeEmail(body) {
  const raw = body && typeof body.email === 'string' ? body.email.trim().toLowerCase() : null;
  return raw && raw.length ? raw : null;
}

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
        const { firstName, lastName, password, profilePicture } = req.body || {};
        const email = normalizeEmail(req.body);
        if (!email || !password) {
            return res.status(400).json({ message: "Email and password are required" });
        }

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
        const email = normalizeEmail(req.body);
        if (!email || !req.body || !req.body.password) {
          return res.status(400).json({ message: "Email and password are required" });
        }

        const user = await Users.findOne({ where: { email } });
      
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

// get all users
router.get("/", async (req, res) => {
    try {
        const users = await Users.findAll({
            attributes: { exclude: ["password"] },
        });

        res.status(200).json(users);
    } catch (error) {
        console.error("Error fetching users:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});

// * user training programs routes

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

// Upsert & switch user training program
// If body contains { programId }, we copy fields from that template program and assign to the user (switch)
// Otherwise, we update with whatever fields are provided (name, description, duration, workouts, ...)
router.put("/:id/program/update", tokenauth, async (req, res) => {
    try {
        const userId = req.params.id;
        const { programId, ...patch } = req.body || {};

        let payload = { ...patch };

        // If a template program id is provided, fetch it and copy its fields
        if (programId) {
            const template = await TrainingPrograms.findByPk(programId);
            if (!template) {
                return res.status(404).json({ message: "Template program not found" });
            }
            payload = {
                name: template.name,
                description: template.description,
                duration: template.duration,
                workouts: template.workouts,
            };
        }

        // Find existing user program (one per user)
        const existing = await TrainingPrograms.findOne({ where: { userId } });

        if (!existing) {
            // Create a new program for user if none exists yet
            const created = await TrainingPrograms.create({ userId, ...payload });
            const status = programId ? 201 : 201;
            const message = programId ? "Program assigned to user" : "Program created for user";
            return res.status(status).json({ message, program: created });
        }

        // Update existing user program (switch or patch)
        const updated = await existing.update(payload);
        const message = programId ? "Program switched" : "Program updated";
        return res.status(200).json({ message, program: updated });
    } catch (error) {
        console.error("Error upserting/switching training program:", error);
        return res.status(500).json({ message: "Internal server error" });
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

// get user calendar entries with daily workouts and training programs (range + enrichment)
router.get("/:id/calendar", tokenauth, async (req, res) => {
    try {
        const { from, to, month, year } = req.query;
        const where = { userId: req.params.id };

        if (from && to) {
            where.date = { [Op.between]: [from, to] };
        } else if (month && year) {
            const mm = String(month).padStart(2, "0");
            // Entries stored as DATEONLY (YYYY-MM-DD)
            where.date = { [Op.between]: [`${year}-${mm}-01`, `${year}-${mm}-31`] };
        }

        const calendars = await Calendar.findAll({
            where,
            order: [["date", "ASC"]],
        });

        // Optionally enrich workouts with the user's current program, daily, and flags
        const include = (req.query.include || "").split(",").map((s) => s.trim()).filter(Boolean);
        const includeProgram = include.includes("program");
        const includeDaily = include.includes("daily");
        const includeFlags = include.includes("flags");

        let programMeta = null;
        if (includeProgram) {
            const prog = await TrainingPrograms.findOne({ where: { userId: req.params.id } });
            if (prog) {
                programMeta = { id: prog.id, name: prog.name };
            }
        }
        let dailyMeta = null;
        if (includeDaily) {
            const dailyPlan = await DailyWorkout.findOne({ where: { userId: req.params.id } });
            if (dailyPlan) {
                dailyMeta = { id: dailyPlan.id };
                if (dailyPlan.name) dailyMeta.name = dailyPlan.name;
            }
        }

        const enriched = calendars.map((entry) => {
            const json = entry.toJSON();
            const hasDaily = (json.workouts || []).some((w) => w.source === "daily");
            const hasProgram = (json.workouts || []).some((w) => w.source === "program");

            const workouts = (json.workouts || []).map((w) => {
                if (includeProgram && w.source === "program" && programMeta) {
                    return { ...w, program: programMeta };
                }
                if (includeDaily && w.source === "daily" && dailyMeta) {
                    return { ...w, daily: dailyMeta };
                }
                return w;
            });

            const out = { ...json, workouts };
            if (includeFlags) {
                out.flags = { hasDaily, hasProgram, hasFood: (json.foods || []).length > 0 };
            }
            return out;
        });

        res.status(200).json(enriched);
    } catch (error) {
        console.error("Error fetching calendar entries:", error);
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

// * create workout routes


// Log (or fetch) a daily workout by picking a random catalog item by id
// If body contains { workoutId }, use that specific daily workout instead of random
// If body contains { date }, it will be added to the user's calendar; otherwise it only returns the random workout
router.post("/:id/daily-workout/log", tokenauth, async (req, res) => {
  try {
    const { date, workoutId } = req.body || {};

    // Pick a specific template by id when provided, else a random one from the catalog
    let template;
    if (workoutId) {
      template = await DailyWorkout.findByPk(workoutId);
      if (!template) return res.status(404).json({ message: "Daily workout not found" });
    } else {
      template = await DailyWorkout.findOne({ order: sequelize.literal('RANDOM()') });
      if (!template) return res.status(404).json({ message: "No daily workouts in catalog" });
    }

    // Build the workout payload: keep the catalog id as templateId, give the calendar entry its own id
    const tagged = {
      source: 'daily',
      templateId: template.id,
      exercises: template.exercises
    };

    let calendar = null;
    if (date) {
      calendar = await addWorkoutToCalendar(req.params.id, date, tagged);
    }

    // Always return the selected workout; include calendar only if we logged it
    return res.status(200).json({
      workout: { id: template.id, exercises: template.exercises },
      calendar
    });
  } catch (error) {
    console.error("Error logging daily workout:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});


// Choose a training program and add it to the calendar
router.post("/:id/program/choose", tokenauth, async (req, res) => {
    try {
        const { programId, date } = req.body || {};

        if (!programId || !date) {
            return res.status(400).json({ message: "Program ID and date are required" });
        }

        const program = await TrainingPrograms.findByPk(programId);

        if (!program) {
            return res.status(404).json({ message: "Training program not found" });
        }

        // check if the user already has a training program
        const existingProgram = await TrainingPrograms.findOne({
            where: { userId: req.params.id },
        });
        if (existingProgram) {
            return res.status(400).json({ message: "User already has a training program" });
        }

        const template = {
            source: "program",
            templateId: program.id,
            name: program.name,
            exercises: program.exercises,
        };

        let calendar = null;
        if (date) {
            calendar = await addWorkoutToCalendar(req.params.id, date, template);
        }

        res.status(200).json({ message: "Training program added to calendar", calendar });
    } catch (error) {
        console.error("Error choosing training program:", error);
        res.status(500).json({ message: "Internal server error" });
    }
});



module.exports = router;
    