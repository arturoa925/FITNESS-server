# FITNESS — Server

The REST API behind the [FITNESS mobile app](https://github.com/arturoa925/FITNESS-client). It handles authentication (email/password, Google, GitHub), training program enrollment and progress, AI-generated daily workouts, and a per-user calendar of completed workouts and food entries.

Built with **Node.js, Express 5, Sequelize, and PostgreSQL**.

---

## Features

- **Authentication**
  - Email/password registration and login with **bcrypt** password hashing
  - **JWT** bearer tokens (1-hour expiry) checked by the `tokenauth` middleware
  - **Google** and **GitHub OAuth 2.0**: the server exchanges the code, upserts the user, issues its own JWT, and redirects to the web client, a custom `redirect_uri`, or the mobile app's deep-link scheme
  - **Rate-limited login**: 10 attempts per IP every 15 minutes (`express-rate-limit`)
- **Profile photos**: uploads go through `multer` (in memory, 5 MB limit, JPEG/PNG/WebP/HEIC), are resized to 512×512 WebP with `sharp`, and are stored on **Cloudinary**
- **Training programs**
  - Catalog of program templates (Hypertrophy Split, Beginner Full-Body, Kettlebell Burner, Beginner Running, Half Marathon, Yoga Foundations, Calisthenics Foundations)
  - One active program per user: choose, switch, or update it in a transaction
  - Mark individual workouts complete by `workoutId` or by week/day/workout index
- **AI daily workouts**: generated with the **OpenAI API**. Responses are validated, and the server returns `503` with an error code when the AI is unavailable or returns bad JSON
- **Calendar**
  - One row per user per day, holding JSONB `workouts` and `foods` arrays
  - Query by exact date, `from`/`to` range, or `month`/`year` (defaults to the current month), with an optional `onlyCompleted` filter
  - Add and remove food entries; workouts are deduplicated by `externalId`

---

## Tech Stack

| Area | Tools |
| --- | --- |
| Runtime / framework | Node.js, Express 5 |
| Database | PostgreSQL, Sequelize 6 (JSONB columns for workouts and foods) |
| Auth | jsonwebtoken, bcryptjs, Google and GitHub OAuth, express-rate-limit |
| Media | multer, sharp, Cloudinary |
| AI | OpenAI Node SDK |
| Misc | cors, dotenv, uuid |

---

## Project Structure

```
.
├── server.js               # Express app, CORS, request logging, DB sync + listen
├── config/
│   └── connection.js       # Sequelize: DATABASE_URL (SSL) or local Postgres
├── controllers/
│   ├── index.js            # Mounts /users and /auth
│   ├── auth.js             # Google + GitHub OAuth flows
│   └── users.js            # Users, programs, calendar, daily workouts
├── models/
│   ├── index.js            # Associations
│   ├── Users.js            # bcrypt hooks, OAuth-aware validation
│   ├── TrainingPrograms.js
│   ├── Calendar.js
│   └── DailyWorkout.js
├── utils/
│   ├── tokenauth.js        # JWT middleware
│   ├── upload.js           # multer config
│   └── cloudinary.js       # Cloudinary client
├── seed/                   # Seed users, programs, daily workouts, calendar days
└── db/
    └── schema.sql          # Creates the database
```

### Data model

```
Users ──1:1── TrainingPrograms   (user's active program; templates have no userId)
  ├───1:N── Calendar          (one row per date: workouts[], foods[])
  └───1:1── DailyWorkout
```

All primary keys are UUIDs. Deleting a user cascades to their related rows.

---

## Getting Started

### Prerequisites

- Node.js 18+
- PostgreSQL 14+
- Accounts and keys for Cloudinary, OpenAI, and Google/GitHub OAuth (only for the features you want to use)

### 1. Install

```bash
git clone https://github.com/arturoa925/FITNESS-server.git
cd FITNESS-server
npm install
```

### 2. Create the database

```bash
psql -U postgres -f db/schema.sql
```

### 3. Configure environment variables

Create a `.env` file in the project root (it's git-ignored):

```env
# Server
PORT=3004
NODE_ENV=development
JWT_SECRET=replace-with-a-long-random-string

# Database (local)
DB_NAME=fitnessapp
DB_USER=postgres
DB_PW=your-password
# Or use a hosted database instead (SSL enabled):
# DATABASE_URL=postgres://user:pass@host:5432/dbname

# Cloudinary (profile photos)
CLOUDINARY_CLOUD=
CLOUDINARY_KEY=
CLOUDINARY_SECRET=

# OpenAI (daily workouts)
OPENAI_API_KEY=

# Google OAuth
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://localhost:3004/auth/google/callback

# GitHub OAuth
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=
GITHUB_REDIRECT_URI=http://localhost:3004/auth/github/callback

# Where OAuth sends users back to
CLIENT_WEB_URL=http://localhost:5173
MOBILE_REDIRECT_SCHEME=arturofit
```

> Postgres folds unquoted names to lowercase, so `CREATE DATABASE FITNESSapp` creates a database named `fitnessapp`. Set `DB_NAME` to match.

### 4. Seed and run

```bash
npm run seed     # drops and recreates tables, then loads seed data
npm run watch    # dev server with nodemon
# or
npm start
```

The API listens on `http://localhost:3004`.

> `npm run seed` runs `sync({ force: true })`, which **deletes all existing data**.

---

## API Reference

Routes marked 🔒 require `Authorization: Bearer <token>`.

### Auth: `/auth`

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/auth/google` | Start Google OAuth (`?mode=minimal`, `?state=mobile`, `?redirect_uri=`, `?debug=true`) |
| GET | `/auth/google/callback` | Google callback; issues a JWT and redirects |
| GET | `/auth/github` | Start GitHub OAuth (same query options) |
| GET | `/auth/github/callback` | GitHub callback; issues a JWT and redirects |

### Users: `/users`

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/users/register` | Create an account (multipart; optional `avatar` file) |
| POST | `/users/login` | Log in and get `{ token, user }` (rate-limited) |
| POST | `/users/logout` 🔒 | Log out |
| GET | `/users` | List users (passwords excluded) |
| GET | `/users/:id` | Get a user |
| PUT | `/users/:id` 🔒 | Update a profile (multipart; optional `avatar`) |

### Training programs

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/users/training-programs` | Program catalog |
| GET | `/users/:id/training-programs` 🔒 | User's active program |
| POST | `/users/:id/program/choose` 🔒 | Enroll in or switch to a program (`{ programId }`) |
| PUT | `/users/:id/program/update` 🔒 | Update the active program (transactional) |
| POST | `/users/:id/program/complete` 🔒 | Mark a workout complete (`programId` plus `workoutId` or `weekIndex`/`dayIndex`/`workoutIndex`) |

### Daily workouts

| Method | Endpoint | Description |
| --- | --- | --- |
| POST | `/users/ai/daily-workout` 🔒 | Generate an AI workout (`{ userId, save?, date? }`) |
| GET | `/users/:id/daily-workout` 🔒 | Get the day's daily workout (`?date=`, `?preview=true`) |
| POST | `/users/:id/daily-workout/log` 🔒 | Log a catalog daily workout to the calendar |

### Calendar

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/users/:id/calendar` 🔒 | Calendar entries (`?date=`, `?from=&to=`, `?month=&year=`, `?onlyCompleted=true`) |
| GET | `/users/:id/calendar/foods` 🔒 | Foods for a date (`?date=`) |
| POST | `/users/:id/calendar/foods` 🔒 | Add a food (`{ date, food }`) |
| DELETE | `/users/:id/calendar/foods` 🔒 | Remove a food (`{ date, foodId }`) |

### Example

```bash
# Log in
curl -X POST http://localhost:3004/users/login \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","password":"yourpassword"}'

# Use the token
curl http://localhost:3004/users/<userId>/calendar?month=11&year=2026 \
  -H "Authorization: Bearer <token>"
```

---

## Roadmap

- [ ] Require auth on `GET /users` and `GET /users/:id`, and check that `req.user.id` matches `:id` on user-scoped routes
- [ ] Return `401` instead of `500` for invalid or expired tokens
- [ ] Refresh tokens to go with the 1-hour JWT
- [ ] Add the deployed frontend origin to the CORS allowlist
- [ ] Tests

---

## Author

**Arturo Ayala**: [GitHub](https://github.com/arturoa925) · [LinkedIn](https://linkedin.com/in/arturo-ayala-775493187)
