const router = require("express").Router();
const {
  Users,
  Calendar,
  DailyWorkout,
  TrainingPrograms,
  BiometricDevices,
} = require("../models");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const sequelize = require("../config/connection");
const { Op } = require("sequelize");
const tokenauth = require("../utils/tokenauth");
const owner = tokenauth.owner; // auth + "the :id in the URL must be YOU"
const {
  isUuid,
  isDateStr,
  isHttpUrl,
  todayStr,
  jsonSize,
} = require("../utils/validate");
const rateLimit = require("express-rate-limit");

require("dotenv").config();

// Optional OpenAI client (used only if key present)
let OpenAIClient = null;
try {
  OpenAIClient = require("openai");
} catch (e) {
  // openai not installed; route will 503 if AI is unavailable
}

const { v4: uuidv4 } = require("uuid");
const sharp = require("sharp");
const upload = require("../utils/upload"); // multer (memoryStorage)
const cloudinary = require("../utils/cloudinary");

const JWT_SECRET = process.env.JWT_SECRET;

// Basic rate limiter for login attempts (per IP)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit to 10 login attempts per window per IP
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false, // Disable the X-RateLimit-* headers
  message: {
    message:
      "Too many login attempts from this IP, please try again after 15 minutes.",
  },
});

// Limit account creation (also bounds anonymous Cloudinary uploads).
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: "Too many sign-ups from this IP, please try again later." },
});

// The AI endpoint costs real money: cap it per authenticated user.
const aiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `user:${req.user && req.user.id}`,
  message: { message: "AI workout limit reached, please try again later." },
});

const MAX_NAME_LEN = 100;
const MAX_NOTES_LEN = 2000;
const MAX_FOOD_BYTES = 10 * 1024;
const MAX_FOODS_PER_DAY = 200;

// Hash of a random string, used so unknown-email logins cost the same as real ones.
const DUMMY_HASH = bcrypt.hashSync(uuidv4(), 10);

function normalizeEmail(body) {
  const raw =
    body && typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : null;
  return raw && raw.length ? raw : null;
}

/**
 * Run `mutate(calendar)` against the (userId, date) calendar row inside a
 * transaction guarded by a per-(user,date) advisory lock. This serializes the
 * read-modify-write on the JSONB arrays (no lost updates) and prevents two
 * concurrent first-writes from creating duplicate rows.
 */
async function withCalendar(userId, date, mutate) {
  return sequelize.transaction(async (t) => {
    await sequelize.query("SELECT pg_advisory_xact_lock(hashtext(:k))", {
      replacements: { k: `${userId}:${date}` },
      transaction: t,
    });
    let calendar = await Calendar.findOne({
      where: { userId, date },
      transaction: t,
    });
    if (!calendar) {
      calendar = await Calendar.create(
        { userId, date, workouts: [], foods: [] },
        { transaction: t }
      );
    }
    await mutate(calendar, t);
    return calendar;
  });
}

/**
 * Upsert a calendar entry and append a workout (with dedupe by externalId or id).
 * @param {string} userId
 * @param {string} date - YYYY-MM-DD
 * @param {object} workout - arbitrary workout payload
 */
async function addWorkoutToCalendar(userId, date, workout) {
  return withCalendar(userId, date, async (calendar, t) => {
    const wid = workout.id || uuidv4();
    const payload = { ...workout, id: wid };

    const exists = (calendar.workouts || []).some((w) => {
      if (payload.externalId && w.externalId) {
        return String(w.externalId) === String(payload.externalId);
      }
      return String(w.id) === String(payload.id);
    });

    if (!exists) {
      calendar.workouts = [...(calendar.workouts || []), payload];
      await calendar.save({ transaction: t });
    }
  });
}

/**
 * Ask an LLM for a balanced daily workout (JSON only).
 * Returns { id, exercises }. Throws with code "AI_*" on errors.
 */
async function generateDailyWorkoutWithAI() {
  if (!process.env.OPENAI_API_KEY || !OpenAIClient) {
    const err = new Error("AI provider is not configured");
    err.code = "AI_UNAVAILABLE";
    throw err;
  }
  const openai = new OpenAIClient.OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });

  const system = [
    "You are a fitness planning assistant.",
    "Return a single JSON object only. No prose.",
    "Schema:",
    "{",
    '  "id": "uuid-v4 string",',
    '  "roundsOptions": [number, ...], // how many times to repeat the full 4-exercise circuit (e.g., [1,2,3,4] where 1 = easy and 4 = warrior)',
    '  "exercises": [',
    '    { "name": "string", "type": "strength|cardio|core|mobility|accessory|conditioning",',
    '      "sets?": number, "reps?": number|string, "durationSec?": number, "durationMin?": number,',
    '      "intervals?": number, "workSec?": number, "restSec?": number, "weightKg?": number,',
    '      "distanceM?": number, "rounds?": number, "tempo?": string, "notes?": string }',
    "  ]",
    "}",
    "Constraints:",
    "- Exactly 4 exercises total, used as a circuit:",
    "  - 1 upper push (e.g., push-ups, dumbbell press)",
    "  - 1 upper pull (e.g., rows, pull-ups)",
    "  - 1 lower body (e.g., squats, lunges, hinges)",
    "  - 1 core or conditioning finisher (e.g., carries, planks, med ball, cardio intervals)",
    "- The user repeats the entire 4-exercise circuit for multiple rounds; 1 round is easy, 4 rounds is a very hard / 'warrior' level.",
    "- Realistic beginner-to-intermediate volumes and rests.",
    "- Use only the fields above; omit anything else.",
  ].join(" ");

  const userPrompt =
    "Create today's balanced daily workout. Respond with JSON only matching the schema.";

  // Timeout guard
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let completion;
  try {
    completion = await openai.chat.completions.create({
      model: "gpt-5-mini",
      // (no `temperature`: gpt-5-family models only accept the default value)
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userPrompt },
      ],
      timeout: 15000,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  const raw = completion?.choices?.[0]?.message?.content?.trim();
  if (!raw) {
    const err = new Error("Empty AI response");
    err.code = "AI_EMPTY";
    throw err;
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    const err = new Error("Invalid JSON from AI");
    err.code = "AI_BAD_JSON";
    throw err;
  }

  if (!json || typeof json !== "object" || !Array.isArray(json.exercises)) {
    const err = new Error("AI JSON missing exercises");
    err.code = "AI_INVALID";
    throw err;
  }

  // Normalize to 4 items and whitelist fields
  const ALLOWED = new Set([
    "name",
    "type",
    "sets",
    "reps",
    "durationSec",
    "durationMin",
    "intervals",
    "workSec",
    "restSec",
    "weightKg",
    "distanceM",
    "rounds",
    "tempo",
    "notes",
  ]);
  const list = json.exercises.slice(0, 4).map((ex) => {
    const out = {};
    if (ex && typeof ex === "object") {
      for (const k of Object.keys(ex)) if (ALLOWED.has(k)) out[k] = ex[k];
      if (typeof out.name !== "string")
        out.name = String(ex.name || "Exercise");
      if (typeof out.type !== "string") out.type = "strength";
    } else {
      out.name = "Exercise";
      out.type = "strength";
    }
    return out;
  });

  let roundsOptions = Array.isArray(json.roundsOptions)
    ? json.roundsOptions
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n > 0)
        .slice(0, 4)
    : null;
  if (!roundsOptions || !roundsOptions.length) {
    roundsOptions = [1, 2, 3, 4];
  }

  const id = typeof json.id === "string" && json.id ? json.id : uuidv4();
  return { id, exercises: list, roundsOptions };
}

// Build a stable synthetic workout id from indices (e.g., w:0-2-0)
function buildWorkoutKey(weekIndex, dayIndex, workoutIndex) {
  return `w:${Number(weekIndex)}-${Number(dayIndex)}-${Number(workoutIndex)}`;
}

// --- helpers for program switching / equality ---
const ALLOWED_PROGRAM_PATCH = new Set([
  "name",
  "description",
  "duration",
  "workouts",
]);
const uuidRe =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const stableStringify = (val) =>
  JSON.stringify(val, (k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.keys(v)
        .sort()
        .reduce((acc, key) => ((acc[key] = v[key]), acc), {});
    }
    return v;
  });

// Given a program JSON and either explicit indices OR a synthetic id, find the workout and return refs
function findWorkoutByPathOrKey(
  programJson,
  { weekIndex, dayIndex, workoutIndex, workoutId }
) {
  if (!Array.isArray(programJson)) return null;

  // If a synthetic id is supplied, parse it
  if (
    workoutId &&
    typeof workoutId === "string" &&
    workoutId.startsWith("w:")
  ) {
    const parts = workoutId.slice(2).split("-");
    if (parts.length === 3) {
      weekIndex = parseInt(parts[0], 10);
      dayIndex = parseInt(parts[1], 10);
      workoutIndex = parseInt(parts[2], 10);
    }
  }

  const week = programJson.find(
    (w) => w && Number(w.weekIndex) === Number(weekIndex)
  );
  if (!week || !Array.isArray(week.days)) return null;
  const day = week.days.find(
    (d) => d && Number(d.dayIndex) === Number(dayIndex)
  );
  if (!day || !Array.isArray(day.workouts)) return null;
  const w = day.workouts[Number(workoutIndex)];
  if (!w) return null;

  return {
    week,
    day,
    workout: w,
    weekIndex: Number(weekIndex),
    dayIndex: Number(dayIndex),
    workoutIndex: Number(workoutIndex),
    workoutId: buildWorkoutKey(weekIndex, dayIndex, workoutIndex),
  };
}

// Upload an already-validated image buffer to Cloudinary as a 512x512 webp avatar.
async function uploadAvatar(buffer) {
  const processed = await sharp(buffer)
    .rotate() // respect EXIF
    .resize(512, 512, { fit: "cover" })
    .webp({ quality: 85 })
    .toBuffer();
  const base64 = `data:image/webp;base64,${processed.toString("base64")}`;
  // `folder` already prefixes the public id, so only pass the bare uuid.
  const result = await cloudinary.uploader.upload(base64, {
    public_id: uuidv4(),
    folder: "avatars",
    resource_type: "image",
  });
  return { url: result.secure_url, publicId: result.public_id };
}

const safeUserJson = (user) => {
  const out = user.toJSON();
  delete out.password;
  return out;
};

// create a new user (optional avatar upload via multipart/form-data field "avatar")
router.post("/register", registerLimiter, upload.single("avatar"), async (req, res) => {
  let uploadedPublicId = null;
  try {
    const { firstName, lastName, password, profilePicture, profilePictureUrl } =
      req.body || {};
    const email = normalizeEmail(req.body);

    if (!email) {
      return res.status(400).json({ message: "Email is required" });
    }
    if (!password || typeof password !== "string") {
      return res.status(400).json({ message: "Password is required" });
    }
    if (password.length < 8) {
      return res.status(400).json({
        message: "Password must be at least 8 characters long",
      });
    }
    // bcrypt only uses the first 72 bytes; reject longer ones instead of silently truncating.
    if (Buffer.byteLength(password) > 72) {
      return res.status(400).json({ message: "Password is too long (max 72 bytes)" });
    }
    for (const [label, v] of [["First name", firstName], ["Last name", lastName]]) {
      if (typeof v !== "string" || !v.trim() || v.length > MAX_NAME_LEN) {
        return res.status(400).json({ message: `${label} is required` });
      }
    }

    const existingUser = await Users.findOne({ where: { email } });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }

    let avatarUrl = null;
    let avatarPublicId = null;
    const directUrl = profilePictureUrl || profilePicture;

    if (req.file && req.file.buffer) {
      try {
        const up = await uploadAvatar(req.file.buffer);
        avatarUrl = up.url;
        avatarPublicId = uploadedPublicId = up.publicId;
      } catch (e) {
        console.error("Cloudinary upload error:", e);
        return res.status(500).json({ message: "Failed to upload avatar" });
      }
    } else if (directUrl) {
      if (!isHttpUrl(directUrl)) {
        return res.status(400).json({ message: "Invalid profile picture URL" });
      }
      avatarUrl = directUrl;
    }

    // NOTE: pass the PLAINTEXT password. The model's beforeCreate hook hashes it;
    // hashing here as well stored bcrypt(bcrypt(pw)) and made login impossible.
    const newUser = await Users.create({
      id: uuidv4(),
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      email,
      password,
      profilePicture: avatarUrl || undefined,
      profilePicturePublicId: avatarPublicId || undefined,
      profilePictureProvider: avatarPublicId ? "cloudinary" : undefined,
    });
    uploadedPublicId = null; // user row now owns the image

    const token = jwt.sign({ id: newUser.id }, JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });
    res.status(201).json({ token, user: safeUserJson(newUser) });
  } catch (error) {
    // Don't leave an orphaned image behind if the user row failed to save.
    if (uploadedPublicId) {
      cloudinary.uploader.destroy(uploadedPublicId).catch(() => {});
    }
    if (error && error.name === "SequelizeUniqueConstraintError") {
      return res.status(400).json({ message: "User already exists" });
    }
    if (error && error.name === "SequelizeValidationError") {
      return res.status(400).json({ message: "Invalid user data" });
    }
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// User login
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const email = normalizeEmail(req.body);
    const password = req.body && req.body.password;
    if (!email || !password || typeof password !== "string") {
      return res
        .status(400)
        .json({ message: "Email and password are required" });
    }

    const user = await Users.findOne({ where: { email } });

    // Same response (and similar work) whether the user is missing, has no local
    // password (social-only account), or typed the wrong password.
    const valid = user
      ? await user.validPassword(password)
      : (await bcrypt.compare(password, DUMMY_HASH), false);

    if (!user || !valid) {
      return res.status(400).json({ message: "Invalid email or password" });
    }

    const token = jwt.sign({ id: user.id }, JWT_SECRET, {
      algorithm: "HS256",
      expiresIn: "1h",
    });

    // never send the password hash back
    res.status(200).json({ token, user: safeUserJson(user) });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// logout user
// JWTs are stateless: the server can't revoke them before they expire (1h).
// The client is responsible for discarding the token.
router.post("/logout", tokenauth, async (req, res) => {
  res.status(200).json({ message: "User logged out successfully" });
});

// current user (declared before "/:id" so "me" isn't parsed as an id)
router.get("/me", tokenauth, async (req, res) => {
  try {
    const user = await Users.findByPk(req.user.id, {
      attributes: { exclude: ["password"] },
    });
    if (!user) return res.status(404).json({ message: "User not found" });
    res.status(200).json(user);
  } catch (error) {
    console.error("Error fetching current user:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// NOTE: the old unauthenticated `GET /users` (listed every user's email/name/
// provider ids) was removed. Nothing in the client used it.

// * user training programs routes

// get all training program TEMPLATES (rows with no owner).
// Per-user copies live in the same table and must never be exposed here.
router.get("/training-programs", async (req, res) => {
  try {
    const programs = await TrainingPrograms.findAll({ where: { userId: null } });
    res.status(200).json(programs);
  } catch (error) {
    console.error("Error fetching training programs:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// check if user has a training program
router.get("/:id/training-programs", owner, async (req, res) => {
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

// Upsert & switch user training program (transactional and hardened)
router.put("/:id/program/update", owner, async (req, res) => {
  const t = await sequelize.transaction();
  try {
    const userId = req.params.id;
    const { programId, ...patch } = req.body || {};

    if (programId && !uuidRe.test(String(programId))) {
      await t.rollback();
      return res.status(400).json({ message: "Invalid programId format" });
    }

    // Load existing user-owned program row (1 per user), lock for update
    let existing = await TrainingPrograms.findOne({
      where: { userId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    // SWITCH by template id
    if (programId) {
      const template = await TrainingPrograms.findByPk(programId, {
        transaction: t,
      });
      // Only real templates (no owner) may be copied. Treating other users'
      // personal rows as templates leaked their data.
      if (!template || template.userId) {
        await t.rollback();
        return res.status(404).json({ message: "Template program not found" });
      }

      if (existing) {
        const sameName = existing.name === template.name;
        const sameDuration =
          Number(existing.duration) === Number(template.duration);
        const sameWorkouts =
          stableStringify(existing.workouts || null) ===
          stableStringify(template.workouts || null);
        if (sameName && sameDuration && sameWorkouts) {
          await t.commit();
          return res
            .status(200)
            .json({ message: "Program already assigned", program: existing });
        }
      }

      const payload = {
        name: template.name,
        description: template.description,
        duration: template.duration,
        workouts: template.workouts,
      };

      if (!existing) {
        const programRow = await TrainingPrograms.create(
          { userId, ...payload },
          { transaction: t }
        );
        await t.commit();
        return res
          .status(201)
          .json({ message: "Program assigned to user", program: programRow });
      }
      const programRow = await existing.update(payload, { transaction: t });
      await t.commit();
      return res
        .status(200)
        .json({ message: "Program switched", program: programRow });
    }

    // PATCH existing (or create) with allowed, validated fields only
    const sanitized = {};
    for (const k of Object.keys(patch || {})) {
      if (ALLOWED_PROGRAM_PATCH.has(k)) sanitized[k] = patch[k];
    }
    if ("name" in sanitized && (typeof sanitized.name !== "string" || !sanitized.name.trim() || sanitized.name.length > 200)) {
      await t.rollback();
      return res.status(400).json({ message: "Invalid name" });
    }
    if ("description" in sanitized && (typeof sanitized.description !== "string" || sanitized.description.length > 5000)) {
      await t.rollback();
      return res.status(400).json({ message: "Invalid description" });
    }
    if (sanitized.duration != null) {
      sanitized.duration = Number(sanitized.duration);
      if (!Number.isInteger(sanitized.duration) || sanitized.duration < 1 || sanitized.duration > 104) {
        await t.rollback();
        return res.status(400).json({ message: "Invalid duration" });
      }
    }
    if ("workouts" in sanitized && (!Array.isArray(sanitized.workouts) || jsonSize(sanitized.workouts) > 1024 * 1024)) {
      await t.rollback();
      return res.status(400).json({ message: "Invalid workouts" });
    }

    if (!existing) {
      const programRow = await TrainingPrograms.create(
        { userId, ...sanitized },
        { transaction: t }
      );
      await t.commit();
      return res
        .status(201)
        .json({ message: "Program created for user", program: programRow });
    }
    const programRow = await existing.update(sanitized, { transaction: t });
    await t.commit();
    return res
      .status(200)
      .json({ message: "Program updated", program: programRow });
  } catch (error) {
    // Roll back THIS transaction (the old code created a new one and rolled
    // that back, leaking the real one and its pooled connection).
    try {
      if (!t.finished) await t.rollback();
    } catch {}
    console.error("Error upserting/switching training program:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// Get user profile by ID
router.get("/:id", owner, async (req, res) => {
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
router.put("/:id", owner, upload.single("avatar"), async (req, res) => {
  let newPublicId = null;
  try {
    const userId = req.params.id;

    const user = await Users.findByPk(userId);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Whitelist updatable fields (plus optional avatar URL)
    const {
      firstName,
      lastName,
      email: rawEmail,
      password,
      currentPassword,
      profilePicture,
      profilePictureUrl,
    } = req.body || {};

    const updates = {};

    for (const [key, v] of [["firstName", firstName], ["lastName", lastName]]) {
      if (typeof v === "string") {
        if (!v.trim() || v.length > MAX_NAME_LEN) {
          return res.status(400).json({ message: `Invalid ${key}` });
        }
        updates[key] = v.trim();
      }
    }

    if (rawEmail) {
      const normalized = normalizeEmail({ email: rawEmail });
      if (!normalized) {
        return res.status(400).json({ message: "Invalid email format" });
      }
      if (normalized !== user.email) {
        const taken = await Users.findOne({ where: { email: normalized } });
        if (taken) {
          return res.status(409).json({ message: "Email already in use" });
        }
        updates.email = normalized;
      }
    }

    // Start from existing avatar values so we can decide whether they changed
    let avatarUrl = user.profilePicture;
    let avatarPublicId = user.profilePicturePublicId;
    let avatarProvider = user.profilePictureProvider;
    const oldCloudinaryId =
      user.profilePicturePublicId && user.profilePictureProvider === "cloudinary"
        ? user.profilePicturePublicId
        : null;
    let replacedAvatar = false;

    const directUrl =
      (typeof profilePictureUrl === "string" && profilePictureUrl.trim()) ||
      (typeof profilePicture === "string" && profilePicture.trim()) ||
      null;

    if (req.file && req.file.buffer) {
      try {
        const up = await uploadAvatar(req.file.buffer);
        avatarUrl = up.url;
        avatarPublicId = newPublicId = up.publicId;
        avatarProvider = "cloudinary";
        replacedAvatar = true;
      } catch (e) {
        console.error("Cloudinary upload error on profile update:", e);
        return res.status(500).json({ message: "Failed to upload avatar" });
      }
    } else if (directUrl) {
      if (!isHttpUrl(directUrl)) {
        return res.status(400).json({ message: "Invalid profile picture URL" });
      }
      avatarUrl = directUrl;
      avatarPublicId = null;
      avatarProvider = "external";
      replacedAvatar = directUrl !== user.profilePicture;
    }

    if (avatarUrl !== user.profilePicture) {
      updates.profilePicture = avatarUrl;
      // null (not undefined) so a stale Cloudinary id is actually cleared
      updates.profilePicturePublicId = avatarPublicId || null;
      updates.profilePictureProvider = avatarProvider || null;
    }

    // Password change: pass PLAINTEXT to the model (its beforeUpdate hook hashes it;
    // hashing here too double-hashed it and broke login).
    if (password) {
      if (typeof password !== "string" || password.length < 8) {
        return res.status(400).json({
          message: "Password must be at least 8 characters long",
        });
      }
      if (Buffer.byteLength(password) > 72) {
        return res.status(400).json({ message: "Password is too long (max 72 bytes)" });
      }
      // Accounts that already have a local password must prove they know it, so a
      // stolen access token alone can't permanently take over the account.
      if (user.password) {
        if (typeof currentPassword !== "string" || !(await user.validPassword(currentPassword))) {
          return res.status(403).json({ message: "Current password is incorrect" });
        }
      }
      updates.password = password;
    }

    let updatedUser;
    try {
      updatedUser = await user.update(updates);
    } catch (e) {
      if (newPublicId) cloudinary.uploader.destroy(newPublicId).catch(() => {});
      if (e && e.name === "SequelizeUniqueConstraintError") {
        return res.status(409).json({ message: "Email already in use" });
      }
      if (e && e.name === "SequelizeValidationError") {
        return res.status(400).json({ message: "Invalid user data" });
      }
      throw e;
    }

    // A changed password signs out every Face ID device (they must re-enroll).
    if (updates.password) {
      await BiometricDevices.destroy({ where: { userId } });
    }

    // Best-effort cleanup of the previous Cloudinary avatar, only after the save succeeded.
    if (replacedAvatar && oldCloudinaryId && oldCloudinaryId !== newPublicId) {
      cloudinary.uploader.destroy(oldCloudinaryId).catch((e) =>
        console.error("Cloudinary destroy error on profile update:", e)
      );
    }

    return res.status(200).json(safeUserJson(updatedUser));
  } catch (error) {
    console.error("Error updating user profile:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// * user daily workout routes

// Generate a standalone daily workout (AI-powered; no local fallback)
// POST /ai/daily-workout
// Body: { save?: boolean, date?: 'YYYY-MM-DD' }   (the user is taken from the token)
router.post("/ai/daily-workout", tokenauth, aiLimiter, async (req, res) => {
  try {
    const userId = req.user.id; // never trust a userId from the body
    const { save = false } = req.body || {};
    const date = req.body && req.body.date;

    if (date !== undefined && date !== null && !isDateStr(date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }

    const user = await Users.findByPk(userId);
    if (!user) return res.status(404).json({ message: "User not found" });

    const {
      id: workoutId,
      exercises,
      roundsOptions,
    } = await generateDailyWorkoutWithAI();

    let calendar = null;
    if (save || date) {
      const effectiveDate = date || todayStr();
      const payload = {
        source: "daily",
        externalId: `daily:${workoutId}:date:${effectiveDate}`,
        name: "Daily Workout",
        exercises,
        roundsOptions,
        createdAt: new Date().toISOString(),
      };
      calendar = await addWorkoutToCalendar(userId, effectiveDate, payload);
    }

    return res.status(200).json({
      id: workoutId,
      exercises,
      roundsOptions,
      ...(calendar ? { calendar } : {}),
    });
  } catch (error) {
    if (
      error &&
      (error.code === "AI_UNAVAILABLE" ||
        error.code === "AI_EMPTY" ||
        error.code === "AI_BAD_JSON" ||
        error.code === "AI_INVALID")
    ) {
      return res
        .status(503)
        .json({ message: "AI service unavailable", code: error.code });
    }
    console.error("Error generating daily workout:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
});

// check if user has a daily workout
router.get("/:id/daily-workout", owner, async (req, res) => {
  try {
    const date = req.query.date || todayStr();
    if (!isDateStr(date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }
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
router.get("/:id/calendar", owner, async (req, res) => {
  try {
    const { from, to, month, year, date } = req.query;
    const where = { userId: req.params.id };

    // Optional: only return workouts that are marked completed === true
    const onlyCompleted =
      String(req.query.onlyCompleted || "false").toLowerCase() === "true";

    if (date !== undefined && !isDateStr(date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }
    if ((from !== undefined || to !== undefined) && !(isDateStr(from) && isDateStr(to))) {
      return res.status(400).json({ message: "from and to must both be YYYY-MM-DD" });
    }
    if (month !== undefined || year !== undefined) {
      const mi = Number(month);
      const yi = Number(year);
      if (!Number.isInteger(mi) || mi < 1 || mi > 12 || !Number.isInteger(yi) || yi < 1970 || yi > 2200) {
        return res.status(400).json({ message: "Invalid month/year" });
      }
    }

    // Default ranges
    const today = new Date();
    const yyyy = String(today.getFullYear());
    const currentMonthIndex = today.getMonth() + 1; // 1-12
    const mmNow = String(currentMonthIndex).padStart(2, "0");

    // Last day of current month: new Date(year, monthIndex, 0) → last day of previous month
    const lastDayCurrentMonth = new Date(
      Number(yyyy),
      currentMonthIndex,
      0
    ).getDate();

    const defaultFrom = `${yyyy}-${mmNow}-01`;
    const defaultTo = `${yyyy}-${mmNow}-${String(lastDayCurrentMonth).padStart(
      2,
      "0"
    )}`;

    // Priority: explicit date > from/to > month/year > default current month
    if (date) {
      where.date = date; // exact day
    } else if (from && to) {
      where.date = { [Op.between]: [from, to] };
    } else if (month && year) {
      const mmInt = Number(month); // 1-12
      const mm = String(mmInt).padStart(2, "0");
      const lastDay = new Date(Date.UTC(Number(year), mmInt, 0)).getUTCDate();
      where.date = {
        [Op.between]: [
          `${year}-${mm}-01`,
          `${year}-${mm}-${String(lastDay).padStart(2, "0")}`,
        ],
      };
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

      // Flags are based on all workouts for that day (completed or not)
      const hasDaily = (json.workouts || []).some(
        (w) => w && w.source === "daily"
      );
      const hasProgram = (json.workouts || []).some(
        (w) => w && w.source === "program"
      );

      // Start from all workouts, then optionally filter to only completed ones
      let workouts = json.workouts || [];
      if (onlyCompleted) {
        workouts = workouts.filter((w) => w && w.completed === true);
      }

      // Enrich workouts with program / daily metadata as requested
      workouts = workouts.map((w) => {
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

router.get("/:id/calendar/foods", owner, async (req, res) => {
  try {
    const date = req.query.date || todayStr();
    if (!isDateStr(date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }

    const calendar = await Calendar.findOne({
      where: { userId: req.params.id, date },
      attributes: ["foods"],
    });

    if (!calendar) {
      return res.status(200).json([]);
    }

    res.status(200).json(calendar.foods || []);
  } catch (error) {
    console.error("Error fetching foods from calendar:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Add food to a specific day
router.post("/:id/calendar/foods", owner, async (req, res) => {
  try {
    const { date, food } = req.body || {};
    if (!date || !food)
      return res
        .status(400)
        .json({ message: "Date and food object are required" });
    if (!isDateStr(date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }
    if (typeof food !== "object" || Array.isArray(food) || jsonSize(food) > MAX_FOOD_BYTES) {
      return res.status(400).json({ message: "Invalid food object" });
    }

    let tooMany = false;
    const calendar = await withCalendar(req.params.id, date, async (cal, t) => {
      if ((cal.foods || []).length >= MAX_FOODS_PER_DAY) {
        tooMany = true;
        return;
      }
      // id last so a null/undefined id in `food` can't blank the generated one
      const withId = { ...food, id: food.id || uuidv4() };
      cal.foods = [...(cal.foods || []), withId];
      await cal.save({ transaction: t });
    });
    if (tooMany) {
      return res.status(400).json({ message: "Too many foods logged for this day" });
    }

    res.status(200).json(calendar);
  } catch (error) {
    console.error("Error adding food to calendar:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Remove a food from a specific day by id (date and foodId from body)
router.delete("/:id/calendar/foods", owner, async (req, res) => {
  try {
    const { date, foodId } = req.body || {};
    if (!date || !foodId) {
      return res.status(400).json({ message: "Date and foodId are required" });
    }
    if (!isDateStr(date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }

    const exists = await Calendar.findOne({
      where: { userId: req.params.id, date },
      attributes: ["id"],
    });
    if (!exists) {
      return res.status(404).json({ message: "Calendar not found" });
    }

    const calendar = await withCalendar(req.params.id, date, async (cal, t) => {
      cal.foods = (cal.foods || []).filter(
        (item) => String(item.id) !== String(foodId)
      );
      await cal.save({ transaction: t });
    });

    res.status(200).json(calendar);
  } catch (error) {
    console.error("Error removing food from calendar:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// * create workout routes

// ! route not in use
// Log (or fetch) a daily workout by picking a random catalog item by id
// If body contains { workoutId }, use that specific daily workout instead of random
// If body contains { date }, it will be added to the user's calendar; otherwise it only returns the random workout
router.post("/:id/daily-workout/log", owner, async (req, res) => {
  try {
    const { date, workoutId } = req.body || {};
    const effectiveDate = date || todayStr();
    if (!isDateStr(effectiveDate)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }
    if (workoutId && !isUuid(workoutId)) {
      return res.status(400).json({ message: "Invalid workoutId" });
    }

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
router.post("/:id/program/choose", owner, async (req, res) => {
  try {
    const userId = req.params.id;
    const { programId, date } = req.body || {};

    if (!programId || !isUuid(String(programId))) {
      return res.status(400).json({ message: "A valid program ID is required" });
    }
    if (date !== undefined && date !== null && !isDateStr(date)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }

    const template = await TrainingPrograms.findByPk(programId);
    // Only owner-less templates may be copied (other users' rows are private).
    if (!template || template.userId) {
      return res.status(404).json({ message: "Training program not found" });
    }

    // One program per user: create if none; otherwise switch (idempotent if same)
    let existing = await TrainingPrograms.findOne({ where: { userId } });
    // Prevent using the user's own row as a 'template'
    if (existing && String(template.userId || "") === String(userId)) {
      return res.status(400).json({
        message:
          "Provided programId refers to the user's existing row, not a template",
      });
    }

    // Compute equality to avoid useless writes
    const sameName = existing ? existing.name === template.name : false;
    const sameDuration = existing
      ? Number(existing.duration) === Number(template.duration)
      : false;
    const sameWorkouts = existing
      ? stableStringify(existing.workouts || null) ===
        stableStringify(template.workouts || null)
      : false;

    let userProgram;
    let status = 201;
    let message = "Program assigned to user";

    if (!existing) {
      userProgram = await TrainingPrograms.create({
        userId,
        name: template.name,
        description: template.description,
        duration: template.duration,
        workouts: template.workouts,
      });
    } else if (sameName && sameDuration && sameWorkouts) {
      userProgram = existing;
      status = 200;
      message = "Program already assigned";
    } else {
      userProgram = await existing.update({
        name: template.name,
        description: template.description,
        duration: template.duration,
        workouts: template.workouts,
      });
      status = 200;
      message = "Program switched";
    }

    const effectiveDate = date || todayStr();
    const calendarPayload = {
      source: "program",
      externalId: `program:${userProgram.id}:start:${effectiveDate}`,
      programMeta: {
        programId: userProgram.id,
        name: userProgram.name,
        event:
          status === 201
            ? "program_assigned"
            : message.replace(/\s+/g, "_").toLowerCase(),
      },
      name: `${status === 201 ? "Started" : "Switched to"} program: ${
        userProgram.name
      }`,
      completed: false,
      createdAt: new Date().toISOString(),
    };
    const calendar = await addWorkoutToCalendar(
      userId,
      effectiveDate,
      calendarPayload
    );

    return res.status(status).json({
      message,
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
router.post("/:id/program/complete", owner, async (req, res) => {
  try {
    const userId = req.params.id;
    const {
      programId,
      workoutId,
      weekIndex,
      dayIndex,
      workoutIndex,
      date,
      notes,
    } = req.body || {};

    // Require programId and at least a synthetic workoutId
    if (
      !programId ||
      (!workoutId &&
        (weekIndex == null || dayIndex == null || workoutIndex == null))
    ) {
      return res.status(400).json({
        message:
          "Provide programId and workoutId (e.g., 'w:0-1-0') or indices (weekIndex, dayIndex, workoutIndex)",
      });
    }

    const effectiveDate = date || todayStr();
    if (!isDateStr(effectiveDate)) {
      return res.status(400).json({ message: "date must be YYYY-MM-DD" });
    }
    if (!isUuid(String(programId))) {
      return res.status(400).json({ message: "Invalid programId" });
    }
    if (notes != null && (typeof notes !== "string" || notes.length > MAX_NOTES_LEN)) {
      return res.status(400).json({ message: "Invalid notes" });
    }

    // Load program and ensure it belongs to the user
    const program = await TrainingPrograms.findByPk(programId);
    if (!program)
      return res.status(404).json({ message: "Training program not found" });
    if (String(program.userId) !== String(userId)) {
      return res
        .status(403)
        .json({ message: "Program does not belong to user" });
    }

    const programJson = JSON.parse(JSON.stringify(program.workouts || []));
    const found = findWorkoutByPathOrKey(programJson, {
      weekIndex,
      dayIndex,
      workoutIndex,
      workoutId,
    });
    if (!found)
      return res.status(404).json({ message: "Workout not found in program" });

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

    const calendar = await addWorkoutToCalendar(
      userId,
      effectiveDate,
      calendarPayload
    );

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
