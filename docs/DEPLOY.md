# Deploy checklist

Do these in order. Nothing here is destructive except step 3's one-time duplicate merge, which is why step 1 comes first.

## 1. Back up the production database
```bash
DATABASE_URL='postgres://user:pass@host:5432/db' ./scripts/backup-db.sh
```
Writes `backups/fitness-<time>.dump` and checks the archive is readable (needs `pg_dump`/`pg_restore`, same or newer major version than your server; `brew install libpq` on macOS). Keep the file somewhere private: it contains user data. Many hosts (e.g. Render) also have a one-click snapshot; take that too.

Restore if needed (into an empty database): `pg_restore --no-owner --dbname "$DATABASE_URL" backups/<file>.dump`

## 2. Set environment variables on the server
| Variable | Required | Notes |
|---|---|---|
| `JWT_SECRET` | yes | 16+ random chars; the server refuses to start without it. Generate: `openssl rand -hex 32` |
| `DATABASE_URL` | yes (hosted) | TLS certificate is verified by default; if the connection fails with a certificate error set `DB_SSL_REJECT_UNAUTHORIZED=false` |
| `NODE_ENV` | yes | `production` (enables HSTS, hides debug OAuth output, makes `seed` refuse to run) |
| `RESEND_API_KEY`, `EMAIL_FROM` | for password reset + email verification | see "Email" below. Without them **no email is sent in production** (reset codes can't be delivered) |
| `GOOGLE_*`, `GITHUB_*`, `CLIENT_WEB_URL`, `MOBILE_REDIRECT_SCHEME` | for social sign-in | as before; `OAUTH_ALLOWED_REDIRECTS` if you use https redirects |
| `ALLOWED_ORIGINS` | if you have a web client | comma-separated origins |
| `TRUST_PROXY` | optional | default is 1 in production (one proxy, e.g. Render); raise it if you add a CDN |
| `CLOUDINARY_*`, `OPENAI_API_KEY` | as before | |
| `ACCESS_TOKEN_TTL`, `REFRESH_TOKEN_TTL_DAYS` | optional | defaults `15m` / `30` |

Do **not** set `RATE_LIMIT_MULTIPLIER` or `MAIL_OUTBOX` in production (they exist for tests).

## 3. Deploy the server (before the app)
The new app needs `/auth/refresh`; an old server would make it sign users out when their token expires. On first boot the server will:
- create the new tables (`RefreshTokens`, `BiometricDevices`, `VerificationCodes`),
- merge any duplicate calendar days / per-user programs and add the unique indexes (logged as `[db] merged duplicates: ...`),
- then start listening. If this step fails the process exits instead of serving a half-migrated database.

Accounts that registered before the password-hashing fix can't log in; they use **Forgot password?** (needs email, step 2).

## 4. Smoke test the deployed server
```bash
BASE_URL=https://your-api.example.com ./scripts/smoke.sh
```
Read-only. All checks must pass; any FAIL usually means the old build is still running. (Run against the original code it fails 6 of 8, so it really does detect an unfixed deploy.)

## 5. Email (Resend)
1. Create an account at https://resend.com and add your sending domain; add the DNS records they show (SPF/DKIM) and wait until it shows as verified.
2. Create an API key with sending access and set it as `RESEND_API_KEY`.
3. Set `EMAIL_FROM` to an address on that domain, e.g. `Fitness <no-reply@yourdomain.com>`.
4. Test with a real account: request **Forgot password?** in the app and confirm the code arrives (check spam the first time).
For a quick experiment before your domain is verified, Resend documents a shared test sender that only delivers to your own account email; see their docs. To use a different provider, change only `utils/mailer.js`.

## 6. Release the app
`EXPO_PUBLIC_API_BASE=https://your-api.example.com` must be set for the build (see the client README/docs). Face ID needs a real build (`npx expo run:ios`); Expo Go cannot test it.

## Rollback
App: ship the previous build. Server: redeploy the previous version; the new tables and unique indexes are harmless to older code. If data was damaged, restore from the step 1 backup.
