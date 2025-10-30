const router = require("express").Router();
const {
  Users,
  Calendar,
  DailyWorkout,
  TrainingPrograms,
} = require("../models");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const sequelize = require("../config/connection");
const { Op } = require("sequelize");
const tokenauth = require("../utils/tokenauth");
require("dotenv").config();

const { v4: uuidv4 } = require("uuid");
const sharp = require("sharp");
const upload = require("../utils/upload"); // multer (memoryStorage)
const cloudinary = require("../utils/cloudinary");

const JWT_SECRET = process.env.JWT_SECRET;

function normalizeEmail(body) {
  const raw =
    body && typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : null;
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

// Build a stable synthetic workout id from indices (e.g., w:0-2-0)
function buildWorkoutKey(weekIndex, dayIndex, workoutIndex) {
  return `w:${Number(weekIndex)}-${Number(dayIndex)}-${Number(workoutIndex)}`;
}

// Given a program JSON and either explicit indices OR a synthetic id, find the workout and return refs
function findWorkoutByPathOrKey(programJson, { weekIndex, dayIndex, workoutIndex, workoutId }) {
  if (!Array.isArray(programJson)) return null;

  // If a synthetic id is supplied, parse it
  if (workoutId && typeof workoutId === 'string' && workoutId.startsWith('w:')) {
    const parts = workoutId.slice(2).split('-');
    if (parts.length === 3) {
      weekIndex = parseInt(parts[0], 10);
      dayIndex = parseInt(parts[1], 10);
      workoutIndex = parseInt(parts[2], 10);
    }
  }

  const week = programJson.find(w => w && Number(w.weekIndex) === Number(weekIndex));
  if (!week || !Array.isArray(week.days)) return null;
  const day = week.days.find(d => d && Number(d.dayIndex) === Number(dayIndex));
  if (!day || !Array.isArray(day.workouts)) return null;
  const w = day.workouts[Number(workoutIndex)];
  if (!w) return null;

  return {
    week, day, workout: w,
    weekIndex: Number(weekIndex),
    dayIndex: Number(dayIndex),
    workoutIndex: Number(workoutIndex),
    workoutId: buildWorkoutKey(weekIndex, dayIndex, workoutIndex),
  };
}

// create a new user (optional avatar upload via multipart/form-data field "avatar")
router.post("/register", upload.single("avatar"), async (req, res) => {
  try {
    const { firstName, lastName, password, profilePicture, profilePictureUrl } = req.body || {};
    const email = normalizeEmail(req.body);
    if (!email || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const existingUser = await Users.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Hash password before save
    const hashed = await bcrypt.hash(password, 10);

    // Handle optional avatar upload to Cloudinary
    let avatarUrl = null;
    let avatarPublicId = null;

    if (req.file && req.file.buffer) {
      try {
        const processed = await sharp(req.file.buffer)
          .rotate() // respect EXIF
          .resize(512, 512, { fit: "cover" })
          .webp({ quality: 85 })
          .toBuffer();

        const base64 = `data:image/webp;base64,${processed.toString("base64")}`;
        const publicId = `avatars/${uuidv4()}`;
        const result = await cloudinary.uploader.upload(base64, {
          public_id: publicId,
          folder: "avatars",
          overwrite: true,
          resource_type: "image",
        });

        avatarUrl = result.secure_url;
        avatarPublicId = result.public_id;
      } catch (e) {
        console.error("Cloudinary upload error:", e);
        return res.status(500).json({ message: "Failed to upload avatar" });
      }
    } else if (profilePictureUrl || profilePicture) {
      // If client passed a direct URL, accept it
      avatarUrl = profilePictureUrl || profilePicture;
    }

    const newUser = await Users.create({
      id: uuidv4(),
      firstName,
      lastName,
      email,
      password: hashed,
      profilePicture: avatarUrl || undefined,
      profilePicturePublicId: avatarPublicId || undefined,
      profilePictureProvider: avatarPublicId ? "cloudinary" : undefined,
    });

    const token = jwt.sign({ id: newUser.id }, JWT_SECRET, { expiresIn: "1h" });

    const safeUser = newUser.toJSON();
    delete safeUser.password;

    res.status(201).json({ token, user: safeUser });
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
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }

    const user = await Users.findOne({ where: { email } });

    const validPassword = await bcrypt.compare(
      req.body.password,
      user.password
    );

    if (!user || !validPassword) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

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

// get all training programs
router.get("/training-programs", async (req, res) => {
  try {
    const programs = await TrainingPrograms.findAll();
    res.status(200).json(programs);
  } catch (error) {
    console.error("Error fetching training programs:", error);
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

// Upsert & switch user training program
// If body contains { programId }, we copy fields from that template program and assign to the user (switch)
// Otherwise, we update with whatever fields are provided (name, description, duration, workouts, ...)
router.put("/:id/program/update", tokenauth, async (req, res) => {
  try {
    const userId = req.params.id;
    const { programId, ...patch } = req.body || {};

    // Find existing user program (one per user)
    const existing = await TrainingPrograms.findOne({ where: { userId } });

    // If client is switching via a catalog programId
    if (programId) {
      const template = await TrainingPrograms.findByPk(programId);
      if (!template) {
        return res.status(404).json({ message: "Template program not found" });
      }

      // If the user already has a program and it matches the template (by core fields), reject
      if (existing) {
        const sameName = existing.name === template.name;
        const sameDuration =
          Number(existing.duration) === Number(template.duration);
        const sameWorkouts =
          JSON.stringify(existing.workouts || null) ===
          JSON.stringify(template.workouts || null);
        if (sameName && sameDuration && sameWorkouts) {
          return res
            .status(409)
            .json({ message: "Program is already assigned" });
        }
      }

      // Build payload from template
      const payload = {
        name: template.name,
        description: template.description,
        duration: template.duration,
        workouts: template.workouts,
      };

      if (!existing) {
        const created = await TrainingPrograms.create({ userId, ...payload });
        return res
          .status(201)
          .json({ message: "Program assigned to user", program: created });
      }

      const updated = await existing.update(payload);
      return res
        .status(200)
        .json({ message: "Program switched", program: updated });
    }

    // Otherwise: no programId provided → patch existing program fields (or create if none)
    const payload = { ...patch };

    if (!existing) {
      const created = await TrainingPrograms.create({ userId, ...payload });
      return res
        .status(201)
        .json({ message: "Program created for user", program: created });
    }

    const updated = await existing.update(payload);
    return res
      .status(200)
      .json({ message: "Program updated", program: updated });
  } catch (error) {
    console.error("Error upserting/switching training program:", error);
    return res.status(500).json({ message: "Internal server error" });
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

// * user daily workout routes

// check if user has a daily workout
router.get("/:id/daily-workout", tokenauth, async (req, res) => {
  try {
    const today = new Date().toISOString().split("T")[0];
    const date = req.query.date || today;
    const preview =
      String(req.query.preview || "false").toLowerCase() === "true";

    // 1) Check the user's calendar for the day and return any logged daily workouts
    const cal = await Calendar.findOne({
      where: { userId: req.params.id, date },
    });
    if (cal && Array.isArray(cal.workouts)) {
      const daily = cal.workouts.filter((w) => w && w.source === "daily");
      if (daily.length) {
        return res.status(200).json({ date, workouts: daily });
      }
    }

    // 2) Optionally return a preview from the catalog if requested
    if (preview) {
      const template = await DailyWorkout.findOne({
        order: sequelize.literal("RANDOM()"),
      });
      if (!template)
        return res
          .status(404)
          .json({ message: "No daily workouts in catalog" });
      return res.status(200).json({
        date,
        preview: true,
        workout: { id: template.id, exercises: template.exercises },
      });
    }

    // 3) Nothing logged for this day
    return res
      .status(404)
      .json({ message: "No daily workout logged for this date" });
  } catch (error) {
    console.error("Error fetching daily workout:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// * user calendar routes

// get user calendar entries with daily workouts and training programs (range + enrichment)
router.get("/:id/calendar", tokenauth, async (req, res) => {
  try {
    const { from, to, month, year, date } = req.query;
    const where = { userId: req.params.id };

    // Default ranges
    const today = new Date();
    const yyyy = String(today.getFullYear());
    const mmNow = String(today.getMonth() + 1).padStart(2, "0");
    const defaultFrom = `${yyyy}-${mmNow}-01`;
    const defaultTo = `${yyyy}-${mmNow}-31`;

    // Priority: explicit date > from/to > month/year > default current month
    if (date) {
      where.date = date; // exact day
    } else if (from && to) {
      where.date = { [Op.between]: [from, to] };
    } else if (month && year) {
      const mm = String(month).padStart(2, "0");
      where.date = { [Op.between]: [`${year}-${mm}-01`, `${year}-${mm}-31`] };
    } else {
      // Default to current month
      where.date = { [Op.between]: [defaultFrom, defaultTo] };
    }

    const calendars = await Calendar.findAll({
      where,
      order: [["date", "ASC"]],
    });

    const include = (req.query.include || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const includeProgram = include.includes("program");
    const includeDaily = include.includes("daily");
    const includeFlags = include.includes("flags");

    let programMeta = null;
    if (includeProgram) {
      const prog = await TrainingPrograms.findOne({
        where: { userId: req.params.id },
      });
      if (prog) programMeta = { id: prog.id, name: prog.name };
    }

    let dailyMeta = null;
    if (includeDaily) {
      const dailyPlan = await DailyWorkout.findOne({
        where: { userId: req.params.id },
      });
      if (dailyPlan) {
        dailyMeta = { id: dailyPlan.id };
        if (dailyPlan.name) dailyMeta.name = dailyPlan.name;
      }
    }

    const enriched = calendars.map((entry) => {
      const json = entry.toJSON();
      const hasDaily = (json.workouts || []).some((w) => w.source === "daily");
      const hasProgram = (json.workouts || []).some(
        (w) => w.source === "program"
      );

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
        out.flags = {
          hasDaily,
          hasProgram,
          hasFood: (json.foods || []).length > 0,
        };
      }
      return out;
    });

    res.status(200).json(enriched);
  } catch (error) {
    console.error("Error fetching calendar entries:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// get all food using today's date as default

router.get("/:id/calendar/foods", tokenauth, async (req, res) => {
  try {
    const today = new Date();
    const defaultDate = today.toISOString().split("T")[0];
    const date = req.query.date || defaultDate;

    const calendar = await Calendar.findOne({
      where: { userId: req.params.id, date },
      attributes: ["foods"],
    });

    if (!calendar) {
      return res.status(404).json({ message: "Calendar not found" });
    }

    res.status(200).json(calendar.foods || []);
  } catch (error) {
    console.error("Error fetching foods from calendar:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Add food to a specific day
router.post("/:id/calendar/foods", tokenauth, async (req, res) => {
  try {
    const { date, food } = req.body; // expect { date, food: { id?, name, calories, photoUrl, ... } }
    if (!date || !food)
      return res
        .status(400)
        .json({ message: "Date and food object are required" });

    const [calendar] = await Calendar.findOrCreate({
      where: { userId: req.params.id, date },
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

// Remove a food from a specific day by id (date and foodId from body)
router.delete("/:id/calendar/foods", tokenauth, async (req, res) => {
  try {
    const { date, foodId } = req.body;
    if (!date || !foodId) {
      return res.status(400).json({ message: "Date and foodId are required" });
    }

    const calendar = await Calendar.findOne({
      where: { userId: req.params.id, date },
    });

    if (!calendar) {
      return res.status(404).json({ message: "Calendar not found" });
    }

    const before = calendar.foods || [];
    calendar.foods = before.filter(
      (item) => String(item.id) !== String(foodId)
    );
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
    const effectiveDate = date || new Date().toISOString().split("T")[0];

    // Pick a specific template by id when provided, else a random one from the catalog
    let template;
    if (workoutId) {
      template = await DailyWorkout.findByPk(workoutId);
      if (!template)
        return res.status(404).json({ message: "Daily workout not found" });
    } else {
      template = await DailyWorkout.findOne({
        order: sequelize.literal("RANDOM()"),
      });
      if (!template)
        return res
          .status(404)
          .json({ message: "No daily workouts in catalog" });
    }

    // Build the workout payload: keep the catalog id as templateId, give the calendar entry its own id
    const tagged = {
      source: "daily",
      templateId: template.id,
      exercises: template.exercises,
    };

    const calendar = await addWorkoutToCalendar(
      req.params.id,
      effectiveDate,
      tagged
    );

    // Always return the selected workout; include calendar only if we logged it
    return res.status(200).json({
      workout: { id: template.id, exercises: template.exercises },
      calendar,
    });
  } catch (error) {
    console.error("Error logging daily workout:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Choose a training program and add it to the calendar
router.post("/:id/program/choose", tokenauth, async (req, res) => {
  try {
    const userId = req.params.id;
    const { programId, date } = req.body || {};

    if (!programId) {
      return res.status(400).json({ message: "Program ID is required" });
    }

    // Load the template program (catalog item)
    const template = await TrainingPrograms.findByPk(programId);
    if (!template) {
      return res.status(404).json({ message: "Training program not found" });
    }

    // Enforce one program per user
    const existing = await TrainingPrograms.findOne({ where: { userId } });
    if (existing) {
      return res.status(400).json({ message: "User already has a training program" });
    }

    // Create a user-owned program by copying fields from the template
    const userProgram = await TrainingPrograms.create({
      userId,
      name: template.name,
      description: template.description,
      duration: template.duration,
      workouts: template.workouts, // copy the nested weeks/days/workouts JSON
    });

    let calendar = null;
    const effectiveDate = date || new Date().toISOString().split("T")[0];

    // Optionally log the assignment on the calendar (as a start marker)
    const calendarPayload = {
      source: "program",
      externalId: `program:${userProgram.id}:start:${effectiveDate}`,
      programMeta: {
        programId: userProgram.id,
        name: userProgram.name,
        event: "program_assigned"
      },
      name: `Started program: ${userProgram.name}`,
      completed: false,
      createdAt: new Date().toISOString(),
    };

    calendar = await addWorkoutToCalendar(userId, effectiveDate, calendarPayload);

    return res.status(201).json({
      message: "Program assigned to user",
      program: userProgram,
      calendar,
    });
  } catch (error) {
    console.error("Error choosing training program:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// complete a specific workout in a training program using a synthetic id (w:x-y-z) — Option B
// the index goes (weekIndex, dayIndex, workoutIndex) or a synthetic id (e.g., w:0-1-0)
// use the new id generated from the GET /:id/training-program endpoint
router.post("/:id/program/complete", tokenauth, async (req, res) => {
  try {
    const userId = req.params.id;
    const { programId, workoutId, weekIndex, dayIndex, workoutIndex, date, notes } = req.body || {};

    // Require programId and at least a synthetic workoutId
    if (!programId || (!workoutId && (weekIndex == null || dayIndex == null || workoutIndex == null))) {
      return res.status(400).json({
        message: "Provide programId and workoutId (e.g., 'w:0-1-0') or indices (weekIndex, dayIndex, workoutIndex)"
      });
    }

    const effectiveDate = date || new Date().toISOString().split("T")[0];

    // Load program and ensure it belongs to the user
    const program = await TrainingPrograms.findByPk(programId);
    if (!program) return res.status(404).json({ message: "Training program not found" });
    if (String(program.userId) !== String(userId)) {
      return res.status(403).json({ message: "Program does not belong to user" });
    }

    const programJson = JSON.parse(JSON.stringify(program.workouts || []));
    const found = findWorkoutByPathOrKey(programJson, { weekIndex, dayIndex, workoutIndex, workoutId });
    if (!found) return res.status(404).json({ message: "Workout not found in program" });

    // Mark complete (non-destructive)
    const idx = found.workoutIndex;
    const dayRef = found.day;
    const original = dayRef.workouts[idx] || {};
    dayRef.workouts[idx] = {
      ...original,
      completed: true,
      lastCompletedAt: new Date().toISOString(),
      lastCompletedDate: effectiveDate,
      completionNotes: notes || original.completionNotes,
    };

    await program.update({ workouts: programJson });

    // Stable external id from synthetic key for calendar dedupe
    const stableId = found.workoutId; // e.g., w:0-1-0
    const calendarPayload = {
      source: "program",
      externalId: `program:${program.id}:workout:${stableId}:date:${effectiveDate}`,
      programMeta: {
        programId: program.id,
        workoutId: stableId,
        weekIndex: found.weekIndex,
        dayIndex: found.dayIndex,
        workoutIndex: found.workoutIndex,
      },
      name: original.name || `Program Workout ${stableId}`,
      completed: true,
      completedAt: new Date().toISOString(),
      notes: notes || undefined,
    };

    const calendar = await addWorkoutToCalendar(userId, effectiveDate, calendarPayload);

    return res.status(200).json({
      message: "Workout marked complete",
      date: effectiveDate,
      programId: program.id,
      workoutId: stableId,
      indices: {
        weekIndex: found.weekIndex,
        dayIndex: found.dayIndex,
        workoutIndex: found.workoutIndex,
      },
      calendar,
    });
  } catch (error) {
    console.error("Error completing training program workout:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
