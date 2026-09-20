# Shared Backend — Rantu_OTP access / package / payment system

Single backend used by **User App**, **Admin App** and **Admin Website**
(all three talk to the same REST API + the same MongoDB database, so a
change from either admin platform is visible on the other after re-fetch).

## Quick start

```bash
cd backend
npm install
cp .env.example .env   # then edit JWT_SECRET + admin credentials
npm run seed           # creates admin, packages (৳20/7d, ৳35/20d), bKash/Nagad/Rocket, version config
npm start              # http://localhost:4000
npm test               # in-process smoke test (register → pay → approve → access)
npm run keepalive      # keep-alive pinger (see below; needs KEEPALIVE_URL set)
```

Default admin: `ADMIN_EMAIL` / `ADMIN_PASSWORD` from `.env` (example: `admin@example.com` / `admin123`).

## Layout

```
backend/
  package.json  .env.example  README.md
  src/
    index.js  app.js  auth.js  db.js  models.js  store.js  mongo.js  seed.js  smoke.js
    keepalive.js  # Render keep-alive pinger (GET /api/health on a schedule)
```

## Keep-alive pinger (Render free tier)

Render sleeps a web service after ~15 minutes without traffic. `src/keepalive.js`
pings `GET /api/health` on a schedule so the deployed backend stays warm. It is
a separate process — run it as a Render Background Worker / Cron Job or any
always-on machine (self-pinging from inside the web service cannot work, since
a sleeping service also suspends its own timers). It never touches the API or
database beyond the public health check, and `npm start` behaviour is unchanged.

```bash
# .env (or Render environment variables):
KEEPALIVE_URL=https://your-app.onrender.com
KEEPALIVE_INTERVAL_MINUTES=7   # <-- THE INTERVAL: change 7 -> 10 for 10 minutes

npm run keepalive         # loop: ping now, then every N minutes
npm run keepalive:once    # single ping and exit (for external cron schedulers,
                          # e.g. Render Cron Job schedule `*/7 * * * *`)
```

Interval default is **7 minutes** (`KEEPALIVE_INTERVAL_MINUTES` in `src/keepalive.js`;
`.env` overrides it when set). The health endpoint is public, tiny, and exempt
from rate limiting, so pings are cheap.

All application data is stored directly in MongoDB (database `MONGO_DB_NAME`,
connection `MONGODB_URI` from `.env`) as JSON-compatible documents. There is
no local file store: the backend never creates folders/files for persistent
data, and every CRUD operation goes through the models in `src/models.js` via
`src/store.js` (single shared connection with pooling, see `src/mongo.js`).

## Business rules

- **Access is backend-validated.** `GET /api/access/status` and the
  `accessRequired` middleware evaluate `status/active`, `accessEnabled`, and
  subscription expiry on every call. Blocking a user takes effect immediately,
  even with a still-valid JWT.
- **Accounts start pending.** `POST /api/auth/register` creates users with
  `status: 'pending'`; `POST /api/auth/login` returns `403` for
  pending/disabled/blocked accounts (only active accounts without a package
  may log in, and only into the purchase flow). Payment approval or a manual
  admin access PATCH flips the account to `active`.
- **Transaction IDs are unique.** Normalized (upper-case, spaces/dashes
  stripped) and enforced in the backend; duplicates get HTTP 409.
  `Idempotency-Key` header additionally dedupes double-tap / network retries.
- **Approval race guard.** Approve/reject is a synchronous
  `PENDING → APPROVED/REJECTED` compare-and-swap inside one `save()` call, so
  two admins racing: only one succeeds, the other gets
  `409 "Payment has already been reviewed."` The package is activated once.
- **Package activation.** Renewal before expiry extends from the current
  expiry date; otherwise starts from the approval date.
- **Push.** New payments create admin `notifications` rows (polled by the
  Admin App/Website badge) and fan out via `pushToAdmins()`. Real FCM push
  needs `FCM_SERVER_KEY`; without it the event is logged + pollable. The Admin
  App also runs a periodic background poll with a local notification, so the
  admin is informed even with the app in the background (poll-based, no extra
  cloud dependency).

## Main endpoints

| Method | Path | Who |
|---|---|---|
| POST | `/api/auth/register` | public |
| POST | `/api/auth/login` | public |
| POST | `/api/auth/device` | public (device activation: find-or-create PENDING device account, returns JWT + access) |
| GET | `/api/auth/me` | user/admin |
| GET | `/api/access/status` | user/admin |
| GET | `/api/protected/demo` | gated (accessRequired) |
| GET | `/api/packages`, `/api/payment-methods` | logged-in user (active only) |
| POST | `/api/payments` | user (submit TxID) |
| GET | `/api/payments/mine`, `/api/subscriptions/mine` | user |
| GET | `/api/versions/check?platform=android&version=x` | public |
| GET | `/api/admin/dashboard` | admin |
| GET/PATCH/POST | `/api/admin/users`, `/:id/access`, `/:id/assign-package` | admin |
| GET/POST/PUT | `/api/admin/packages`, `/api/admin/payment-methods` | admin |
| GET | `/api/admin/payments?status&search`, `/pending-count` | admin |
| POST | `/api/admin/payments/:id/approve`, `/:id/reject` | admin |
| GET | `/api/admin/subscriptions`, `/api/admin/notifications` | admin |
| POST | `/api/admin/fcm-tokens` | admin app |
| GET/PUT | `/api/admin/versions`, `/:platform` | admin |

## Storage notes

`src/db.js` now only holds pure helpers (normalization, version compare,
access-shape helpers). All persistence lives in MongoDB via `src/store.js` +
`src/models.js`; routes depend on that interface.
