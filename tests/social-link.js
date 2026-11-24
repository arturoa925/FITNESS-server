// Pre-registration takeover check for OAuth account linking (no real provider needed).
// Needs the seeded DB. Run: node tests/social-link.js
require("dotenv").config();
const sequelize = require("../config/connection");
const { Users } = require("../models");
const { resolveSocialUser } = require("../controllers/auth");
const tokens = require("../utils/tokens");

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? pass++ : fail++; console.log(c ? "PASS" : "FAIL", n, c ? "" : x ?? ""); };
const sfx = Date.now();

(async () => {
  // Attacker pre-registers the victim's address with a password they know (never verified).
  const victim = `victim${sfx}@x.com`;
  const planted = await Users.create({ firstName: "Eve", lastName: "E", email: victim, password: "attacker-knows-this" });
  const evesRefresh = await tokens.createRefreshToken(planted.id);
  ok("setup: attacker's password works before linking", await planted.validPassword("attacker-knows-this"));

  // The real owner signs in with Google; Google vouches for the address.
  const linked = await resolveSocialUser({ provider: "google", providerId: `g${sfx}`, email: victim, emailVerified: true, firstName: "Vic", lastName: "T", picture: null });
  await linked.reload();
  ok("account is linked to the real owner's Google identity", linked.id === planted.id && linked.provider === "google");
  ok("attacker's password was discarded", linked.password === null && !(await linked.validPassword("attacker-knows-this")));
  ok("attacker's existing session was revoked", (await tokens.rotateRefreshToken(evesRefresh)) === null);
  ok("linked account is now marked verified", linked.isVerified === true);

  // A legitimately verified local account keeps its password when linked.
  const real = `real${sfx}@x.com`;
  const verified = await Users.create({ firstName: "R", lastName: "R", email: real, password: "my-own-password-1", isVerified: true });
  const l2 = await resolveSocialUser({ provider: "github", providerId: `h${sfx}`, email: real, emailVerified: true, firstName: "R", lastName: "R", picture: null });
  await l2.reload();
  ok("verified local account keeps its password when linked", l2.id === verified.id && (await l2.validPassword("my-own-password-1")));

  // Unverified provider email is refused outright.
  let err = null;
  try { await resolveSocialUser({ provider: "google", providerId: `u${sfx}`, email: `new${sfx}@x.com`, emailVerified: false }); } catch (e) { err = e; }
  ok("unverified provider email is rejected (403)", err && err.status === 403, err && err.message);
  err = null;
  try { await resolveSocialUser({ provider: "github", providerId: `n${sfx}`, email: null, emailVerified: false }); } catch (e) { err = e; }
  ok("missing email is rejected (400)", err && err.status === 400, err && err.message);

  for (const u of [planted, verified]) await u.destroy();
  await Users.destroy({ where: { providerId: [`h${sfx}`, `g${sfx}`] } });
  console.log(`\n${pass} passed, ${fail} failed`);
  await sequelize.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
