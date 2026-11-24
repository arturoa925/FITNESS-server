# Security & bug review — server changes

Branch: `claude/determined-lovelace-lxs1ad` (companion doc in the client repo: `docs/SECURITY_REVIEW.md`)

Verification: I ran the **original** code and the **fixed** code against a real Postgres 16 and a live server.
`tests/e2e.js` (126 checks, run with `npm test`) passes on the fixed code. Original-code results are noted per item.

## Fixed

| # | Problem (original behaviour) | Fix |
|---|---|---|
| 1 | **IDOR on almost every `/users/:id/*` route.** `tokenauth` only checked the token was valid, so any user could read/write any other user's program, calendar, foods and daily workouts. | New `tokenauth.owner` middleware (auth **and** `req.user.id === :id`) on every `/:id/*` route, `GET/PUT /:id` included. Returns 403. |
| 2 | **Unauthenticated data leaks.** `GET /users` returned every user's email/name/provider ids (confirmed live); `GET /users/:id` was public; `GET /users/training-programs` returned every user's *personal* program rows. | `GET /users` removed (client never used it). `GET /users/:id` is owner-only. Templates endpoint returns only owner-less rows. Switching/choosing a program only accepts true templates (other users' rows can no longer be copied). |
| 3 | **Login returned the bcrypt hash** (confirmed live). | Login/register/update all strip `password` (`safeUserJson`). |
| 4 | **Double password hashing** — `/register` and `PUT /:id` hashed, then the model hook hashed again, so freshly registered users **could never log in** (confirmed: HTTP 400 right after register). Password changes had the same bug. | Pass plaintext; the model hooks hash once. Verified: register→login and change-password→login both work. |
| 5 | **Server crashed on Linux** — `require("./trainingPrograms")` vs `TrainingPrograms.js` (confirmed `MODULE_NOT_FOUND`). | Fixed casing. |
| 6 | **OAuth open redirect → token theft.** `redirect_uri` was copied into `state` and the JWT was appended to it with no validation. | `redirect_uri` must match an allowlist (`arturofit://`, `MOBILE_REDIRECT_SCHEME://`, `exp://` in non-production, plus `OAUTH_ALLOWED_REDIRECTS`). `state` is now a signed 10-minute token (forged/tampered state → 400). OAuth state tokens can't be used as API tokens and vice-versa. |
| 7 | **OAuth account takeover by email.** Existing accounts were linked by email even when the provider said the email was unverified (Google `??` fallback; GitHub `emails[0]`). | Accounts are only linked/created from a **provider-verified** email. GitHub uses only verified emails. |
| 8 | GitHub sign-in failed for most users (`mode=minimal` requested no email scope; `email` is NOT NULL). Social users' email case didn't match registered emails. | `user:email` scope always requested; emails lower-cased. Clear 400/403 messages instead of a 500. |
| 9 | `auth.js` echoed provider error bodies/token-exchange details, had debug output reachable in prod, and Google/GitHub logic was copy-pasted. | One shared code path (`resolveSocialUser`, `finish`); debug mode and JSON fallback only outside production; generic errors; 10 s fetch timeouts. |
| 10 | **Auth errors were 500/403.** Expired/invalid token → 500 (client's "session expired" path never fired). | 401 for missing/malformed/invalid/expired; HS256 pinned. |
| 11 | **Leaked DB transaction** in `program/update` (`sequelize.transaction().rollback()` rolled back a *new* transaction). Pool is 5, so 5 errors could hang the server. | Roll back the real `t`. Test: repeated failing calls, server stays responsive. |
| 12 | **Lost updates / duplicate calendar rows** from read-modify-write on JSONB arrays and `findOrCreate` without a unique key. | `withCalendar()` runs in a transaction with a per-(user,date) Postgres advisory lock. Test: 12 concurrent food adds → 12 foods, 1 row. |
| 13 | `GET /users/me` didn't exist (client uses it for biometric/quick login) → fell into `/:id` → Postgres uuid error → 500. | Added `GET /users/me`. |
| 14 | Unvalidated input → 500s / junk in DB: dates, month/year, ids, `duration`, `food`/`workouts` JSON, notes, names, avatar URL (`javascript:` accepted). | `utils/validate.js` (UUID, strict real-calendar dates, http(s) URLs, JSON size caps); 400s with clear messages. Foods capped at 200/day and 10 KB each. |
| 15 | Password change needed only a token. Email change gave 500 on duplicates. | Changing an existing password requires `currentPassword` (client already sends it). Duplicate email → 409. Passwords > 72 bytes rejected (bcrypt truncates silently). |
| 16 | Login: crash (`bcrypt.compare(pw, null)`) for social-only accounts and a timing difference revealing which emails exist. | Uses `validPassword()`; dummy-hash compare for unknown emails; identical error. |
| 17 | **AI route:** accepted any `userId` from the body, no rate limit (costs money), `temperature: 0.7` (unsupported by gpt-5-family models), unvalidated date. | Uses the token's user, 20 req/hour/user limiter, temperature removed, date validated. *Not tested against the real OpenAI API.* |
| 18 | No rate limit on register (anonymous Cloudinary uploads) or OAuth; limiter keyed on the proxy IP behind Render. | `registerLimiter` (20/h), `/auth` limiter (60/15 min), `trust proxy` (default 1 in production, `TRUST_PROXY` to change). |
| 19 | Uploads: orphaned Cloudinary images when user creation failed; old avatar deleted *before* the save succeeded; stale `profilePicturePublicId`; double `avatars/avatars/` folder; HEIC accepted though sharp can't decode it; multer errors → HTML 500. | Cleanup on failure, delete old image only after save, null stale ids, single folder, HEIC/HEIF removed from the filter, JSON error handler (400/413/415). |
| 20 | `server.js`: query strings (with OAuth `code`/`state`) were logged; disallowed CORS origin threw a 500 with stack; only `localhost:5173` allowed. | Logs method+path only; CORS from `CLIENT_WEB_URL` + `ALLOWED_ORIGINS`, no error; central error handler; basic security headers; `x-powered-by` off; fails fast if `JWT_SECRET` is missing/short. |
| 21 | `npm run seed` dropped all tables with no guard (and seeds publicly-known passwords). | Refuses when `NODE_ENV=production` unless `ALLOW_SEED=true`. |
| 22 | DB TLS used `rejectUnauthorized: false`. | Verified by default; `DB_SSL_REJECT_UNAUTHORIZED=false` to opt out. Added `DB_HOST`/`DB_PORT`. |
| 23 | 15 npm vulnerabilities (1 critical, 10 high). | `npm audit fix` (non-breaking) → 3 remain (see below). e2e suite re-run after the update: still green. |

## Behaviour changes you should know about
- `GET /users` is gone; `GET /users/:id` works only for your own id (use `GET /users/me`).
- Bad/expired token is now **401** (was 500/403).
- `/register` now requires non-empty `firstName` and `lastName` (previously the DB rejected it with a 500).
- HEIC/HEIF avatar uploads are rejected up front (415).
- **Production env to set:** `JWT_SECRET` (≥16 chars), `OAUTH_ALLOWED_REDIRECTS` if you use https redirects, `ALLOWED_ORIGINS`/`CLIENT_WEB_URL` for the web app, and `DB_SSL_REJECT_UNAUTHORIZED=false` **only if** your host (e.g. Render) uses a self-signed cert and the DB connection fails after this change.
- Existing users created through `/register` before this fix have a double-hashed password and still can't log in; they need a password reset (or delete/re-register them).

## Not fixed (needs a decision or is larger scope)
- **OAuth login-CSRF:** `state` is signed but not bound to the user's browser session.
- **Timezones:** defaults are UTC dates; clients in US evenings should send an explicit `date`.
- **2 remaining moderate npm advisories**: `uuid` v3/v5/v6 "buf" bounds check inside Sequelize's own nested copy. Sequelize only calls v1/v4 without a buffer, so it isn't reachable; it clears when Sequelize updates its dependency (an `overrides` entry did not take effect and was removed).
- Real OpenAI and Cloudinary calls and the real Google/GitHub flows were not exercised (no credentials here).

## Update: refresh tokens (replaces "token revocation / refresh" under *Not fixed*)
- Access JWT lifetime is now **15 min** (`ACCESS_TOKEN_TTL`). Login, register, OAuth and Face ID return a `refreshToken` (`"<id>.<secret>"`, 30-day sliding, `REFRESH_TOKEN_TTL_DAYS`).
- `POST /auth/refresh { refreshToken }` -> new `{ token, refreshToken }`. Only the SHA-256 of the secret is stored; it rotates every use. The previous secret is accepted for 30 s (lost response / concurrent refresh); an older one is treated as theft and ends that session.
- `POST /users/logout { refreshToken }` revokes the session. Changing the password revokes **all** sessions and Face ID devices and returns a fresh `session` for the caller.
- Max 10 sessions per user (oldest dropped). New table `RefreshTokens` is created by `sequelize.sync()`.
- Tests: 126 checks in `tests/e2e.js`.

## Update: database constraints (replaces "DB-level uniqueness" under *Not fixed*)
- Unique indexes: `calendars_user_id_date_unique` on `Calendars("userId","date")` and `training_programs_user_id_unique` on `TrainingPrograms("userId")` (template rows with `userId NULL` are still allowed).
- `db/ensureConstraints.js` runs at every startup **before** `sequelize.sync()`: if the tables already exist it first merges legacy duplicates (calendar rows are unioned, nothing is lost, oldest row kept; per user the most recently updated program is kept), then creates the indexes. Idempotent; a failure aborts startup rather than serving with a half-migrated schema.
- A losing race on program assignment now returns **409 "Please try again"** instead of 500.
- Tests: `npm run test:db` (10 checks, creates real duplicates and verifies the merge) plus the e2e suite (91) on both a fresh database and an upgraded one with no indexes.
- Back up before the first deploy: the startup step deletes the duplicate rows it merged.

## Update: CI
`.github/workflows/test.yml` starts Postgres 16, seeds, boots the server and runs `npm test` (91 e2e checks) and `npm run test:db` (10) on every push/PR, plus a non-blocking `npm audit` for critical issues. The exact step sequence was dry-run locally. Dependabot (npm weekly, Actions monthly) is configured in `.github/dependabot.yml`.

## Update: account recovery, verification, deletion
- **Password reset** by emailed 6-digit code (HMAC-hashed, 15 min, 5 attempts, max 3/hour/user, single use). `forgot` answers identically for unknown/known addresses. A reset revokes every session and Face ID device and returns a fresh session; accounts locked out by the old double-hash bug can recover this way.
- **Email verification** (`isVerified`): code emailed on registration, confirm in-app. Social sign-in into an *unverified* local account now discards that account's password and sessions, closing the pre-registration takeover. (Fix included a bug found by its own test: the password clear and provider link must be one update because of the model's "password or provider" validation.)
- **Sign out everywhere:** `POST /auth/logout-all`. **Delete account:** `DELETE /users/:id` (confirm word + password), removes the user and all rows, tokens and devices.
- **Rate limits** retuned: the blanket `/auth` limiter was 60/15 min/IP, which would have throttled refresh/Face ID for many users behind one IP (campus Wi-Fi). Now 300, with tighter per-endpoint limits on credential routes; all scale with `RATE_LIMIT_MULTIPLIER`. Verified at defaults: login blocks on the 11th try, forgot-password on the 21st.
- Email transport: `utils/mailer.js` (Resend over HTTPS, console/outbox file in dev). Set `RESEND_API_KEY` and `EMAIL_FROM` to send real mail.
- Tests: 126 e2e + 18 DB checks (`npm test`, `npm run test:db`).

## Update: code health and dependencies
- **sharp 0.34 -> 0.35.5** (fixes the libvips advisories; relevant because avatar uploads from the unauthenticated `/register` are decoded by it). The exact `uploadAvatar` pipeline (EXIF rotate -> 512x512 WebP) was re-verified, and all suites pass on the new version. `uuid` -> 11.1.1.
- **ESLint** (`npm run lint`, flat config): 0 errors. Removed leftovers from earlier refactors (unused `jwt`/`JWT_SECRET` in `users.js`, seed variables, an empty catch). CI runs lint before the tests.

## Fix found by CI: reset-code limit race
The first GitHub Actions runs of the account-recovery work failed on one check: "at most 3 reset codes per hour per user" saw **4** emails. The `forgot` endpoint fires its email without waiting, so a quick burst of requests could each count "0 codes so far" before the first row was saved; the same race existed in production. `issueCode` now does count-then-create inside a transaction guarded by a per-(user, purpose) Postgres advisory lock. Regression test: 10 simultaneous requests yield exactly 3 codes (verified to fail on the old code and pass on the fix; 126 e2e checks).
