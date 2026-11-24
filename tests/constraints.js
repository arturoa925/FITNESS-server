// Verifies db/ensureConstraints.js: legacy duplicates are merged without data loss,
// unique indexes exist afterwards, and re-running is a no-op.
// Needs the seeded database (uses a seeded user). Run: node tests/constraints.js
require("dotenv").config();
const sequelize = require("../config/connection");
const { QueryTypes } = require("sequelize");
const { ensureConstraints, CAL_INDEX, PROG_INDEX } = require("../db/ensureConstraints");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log(c ? "PASS" : "FAIL", n, c ? "" : x ?? ""); };
const q = (sql, replacements) => sequelize.query(sql, { replacements, type: QueryTypes.SELECT });
const run = (sql, replacements) => sequelize.query(sql, { replacements });

(async () => {
  const [{ id: uid }] = await q(`SELECT id FROM "Users" LIMIT 1`);
  const D = "2031-01-15";
  await run(`DROP INDEX IF EXISTS ${CAL_INDEX}`);
  await run(`DROP INDEX IF EXISTS ${PROG_INDEX}`);
  await run(`DELETE FROM "Calendars" WHERE "userId"=:uid AND date=:D`, { uid, D });
  await run(`DELETE FROM "TrainingPrograms" WHERE "userId"=:uid`, { uid });

  // legacy duplicates: two calendar rows for one day (overlapping + distinct entries) ...
  const ins = (id, w, f, ts) => run(
    `INSERT INTO "Calendars"(id,date,workouts,foods,"createdAt","updatedAt","userId") VALUES (:id,:D,:w::jsonb,:f::jsonb,:ts,:ts,:uid)`,
    { id, D, uid, ts, w: JSON.stringify(w), f: JSON.stringify(f) });
  await ins("11111111-1111-4111-8111-111111111111", [{ id: "w1", externalId: "ext-A" }], [{ id: "f1", name: "a" }, { id: "f2", name: "b" }], "2031-01-15T08:00:00Z");
  await ins("22222222-2222-4222-8222-222222222222", [{ id: "w9", externalId: "ext-A" }, { id: "w2" }], [{ id: "f2", name: "b" }, { id: "f3", name: "c" }], "2031-01-15T09:00:00Z");
  // ... and two programs for one user
  const prog = (id, name, ts) => run(
    `INSERT INTO "TrainingPrograms"(id,name,description,workouts,duration,"createdAt","updatedAt","userId") VALUES (:id,:name,'d','[]'::jsonb,4,:ts,:ts,:uid)`,
    { id, name, ts, uid });
  await prog("33333333-3333-4333-8333-333333333333", "old", "2031-01-01T00:00:00Z");
  await prog("44444444-4444-4444-8444-444444444444", "newest", "2031-02-01T00:00:00Z");

  const r1 = await ensureConstraints();
  ok("reports merges", r1.calendarsMerged === 1 && r1.programsMerged === 1, JSON.stringify(r1));
  const cal = await q(`SELECT id, workouts, foods FROM "Calendars" WHERE "userId"=:uid AND date=:D`, { uid, D });
  ok("one calendar row left (the oldest)", cal.length === 1 && cal[0].id.startsWith("11111111"), JSON.stringify(cal.map(c => c.id)));
  ok("foods unioned without duplicates (f1,f2,f3)", cal[0].foods.map(f => f.id).sort().join() === "f1,f2,f3", JSON.stringify(cal[0].foods));
  ok("workouts unioned, same externalId collapsed (ext-A + w2)", cal[0].workouts.length === 2, JSON.stringify(cal[0].workouts));
  const progs = await q(`SELECT name FROM "TrainingPrograms" WHERE "userId"=:uid`, { uid });
  ok("newest program kept", progs.length === 1 && progs[0].name === "newest", JSON.stringify(progs));
  const idx = (await q(`SELECT indexname FROM pg_indexes WHERE indexname IN (:a,:b)`, { a: CAL_INDEX, b: PROG_INDEX })).map(r => r.indexname);
  ok("both unique indexes exist", idx.length === 2, idx);

  let dupErr = null;
  try { await ins("55555555-5555-4555-8555-555555555555", [], [], "2031-01-15T10:00:00Z"); } catch (e) { dupErr = e.name; }
  ok("database now rejects a duplicate calendar day", dupErr === "SequelizeUniqueConstraintError", dupErr);
  dupErr = null;
  try { await prog("66666666-6666-4666-8666-666666666666", "x", "2031-03-01T00:00:00Z"); } catch (e) { dupErr = e.name; }
  ok("database now rejects a second program for a user", dupErr === "SequelizeUniqueConstraintError", dupErr);
  const tpl = async (id) => run(`INSERT INTO "TrainingPrograms"(id,name,description,workouts,duration,"createdAt","updatedAt") VALUES (:id,'t','d','[]'::jsonb,1,NOW(),NOW())`, { id });
  await tpl("77777777-7777-4777-8777-777777777777"); await tpl("88888888-8888-4888-8888-888888888888");
  ok("multiple templates (userId NULL) still allowed", true);
  const r2 = await ensureConstraints();
  ok("second run is a no-op", r2.calendarsMerged === 0 && r2.programsMerged === 0);

  await run(`DELETE FROM "TrainingPrograms" WHERE id IN ('77777777-7777-4777-8777-777777777777','88888888-8888-4888-8888-888888888888')`);
  await run(`DELETE FROM "Calendars" WHERE "userId"=:uid AND date=:D`, { uid, D });
  await run(`DELETE FROM "TrainingPrograms" WHERE "userId"=:uid`, { uid });
  console.log(`\n${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
