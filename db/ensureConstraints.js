// Enforces "one calendar row per (user, date)" and "one program row per user" at the
// database level. Runs at startup BEFORE sequelize.sync():
//   1. if the tables already exist, merge any duplicate rows left by the old race conditions
//      (nothing is lost: workouts/foods are unioned, the oldest row is kept),
//   2. create the unique indexes.
// Idempotent and safe on fresh databases (tables don't exist yet -> nothing to do; the
// model definitions create the same indexes during sync).
const { QueryTypes } = require("sequelize");
const sequelize = require("../config/connection");

const CAL_INDEX = "calendars_user_id_date_unique";
const PROG_INDEX = "training_programs_user_id_unique";

async function tableExists(name) {
  const rows = await sequelize.query(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = :name",
    { replacements: { name }, type: QueryTypes.SELECT }
  );
  return rows.length > 0;
}

const key = (w) =>
  w && (w.externalId ? `x:${w.externalId}` : w.id ? `i:${w.id}` : `j:${JSON.stringify(w)}`);

function mergeLists(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const item of Array.isArray(list) ? list : []) {
      const k = key(item);
      if (k && !seen.has(k)) {
        seen.add(k);
        out.push(item);
      }
    }
  }
  return out;
}

async function dedupeCalendars(t) {
  const dups = await sequelize.query(
    `SELECT "userId", "date" FROM "Calendars" WHERE "userId" IS NOT NULL
     GROUP BY "userId", "date" HAVING COUNT(*) > 1`,
    { type: QueryTypes.SELECT, transaction: t }
  );
  for (const { userId, date } of dups) {
    const rows = await sequelize.query(
      `SELECT id, workouts, foods FROM "Calendars"
       WHERE "userId" = :userId AND "date" = :date ORDER BY "createdAt" ASC, id ASC`,
      { replacements: { userId, date }, type: QueryTypes.SELECT, transaction: t }
    );
    const [keep, ...extra] = rows;
    await sequelize.query(
      `UPDATE "Calendars" SET workouts = :workouts::jsonb, foods = :foods::jsonb, "updatedAt" = NOW() WHERE id = :id`,
      {
        replacements: {
          id: keep.id,
          workouts: JSON.stringify(mergeLists(rows.map((r) => r.workouts))),
          foods: JSON.stringify(mergeLists(rows.map((r) => r.foods))),
        },
        transaction: t,
      }
    );
    await sequelize.query(`DELETE FROM "Calendars" WHERE id IN (:ids)`, {
      replacements: { ids: extra.map((r) => r.id) },
      transaction: t,
    });
  }
  return dups.length;
}

async function dedupePrograms(t) {
  const dups = await sequelize.query(
    `SELECT "userId" FROM "TrainingPrograms" WHERE "userId" IS NOT NULL
     GROUP BY "userId" HAVING COUNT(*) > 1`,
    { type: QueryTypes.SELECT, transaction: t }
  );
  for (const { userId } of dups) {
    // keep the most recently changed program: that's the one the user was on
    await sequelize.query(
      `DELETE FROM "TrainingPrograms" WHERE "userId" = :userId AND id <> (
         SELECT id FROM "TrainingPrograms" WHERE "userId" = :userId
         ORDER BY "updatedAt" DESC, id DESC LIMIT 1)`,
      { replacements: { userId }, transaction: t }
    );
  }
  return dups.length;
}

async function ensureConstraints() {
  const result = { calendarsMerged: 0, programsMerged: 0 };

  if (await tableExists("Calendars")) {
    await sequelize.transaction(async (t) => {
      result.calendarsMerged = await dedupeCalendars(t);
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${CAL_INDEX} ON "Calendars" ("userId", "date")`,
        { transaction: t }
      );
    });
  }
  if (await tableExists("TrainingPrograms")) {
    await sequelize.transaction(async (t) => {
      result.programsMerged = await dedupePrograms(t);
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${PROG_INDEX} ON "TrainingPrograms" ("userId")`,
        { transaction: t }
      );
    });
  }

  if (result.calendarsMerged || result.programsMerged) {
    console.log(
      `[db] merged duplicates: ${result.calendarsMerged} calendar day(s), ${result.programsMerged} user program(s)`
    );
  }
  return result;
}

module.exports = { ensureConstraints, CAL_INDEX, PROG_INDEX };
