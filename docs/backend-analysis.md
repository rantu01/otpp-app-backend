# Referral backend analysis

## Existing architecture

The backend is an Express and Mongoose service using the existing `users` collection and one MongoDB database. Authentication is JWT based, with fresh user reads on every protected request. The existing account policy keeps new registrations `pending`; payment approval or an admin access update changes the account to `active`. `evaluateAccess` is the single access decision used by customer and admin flows.

## Referral integration

- `users.referralCode` is a stable, server-generated code with a unique partial index.
- Existing users are backfilled at MongoDB model initialization; no users or package/payment fields are deleted.
- Referral relationships live in `referrals`, with a unique `(referrerUserId, referredUserId)` index.
- A code is captured during registration but remains `pending` until the referred account becomes active.
- Activation verifies the relationship exactly once and grants the referred user's additive free-trial expiry.
- Every fourth verified relationship conditionally claims one referrer milestone. The conditional update and reward count make retries idempotent.
- Paid package expiry is preserved. Referral expiry is used only when paid access is unavailable or expired.

## Anti-abuse controls

Self-referral is rejected by requiring an existing active owner and the new account cannot be the same account. A referred account stores one immutable `referredBy` value. Duplicate relationships are rejected by MongoDB uniqueness. Counts and expiry are backend fields; no Android value is trusted. Admin referral endpoints use the existing `adminRequired` middleware.

## Configuration

Environment defaults are `REFERRAL_ENABLED=true`, `REFERRAL_REQUIRED=4`, `REFERRER_REWARD_DAYS=5`, and `REFERRED_REWARD_DAYS=3`. These are read by the backend and can be changed without rebuilding the Android apps.

## Migration

The model initializer generates codes only for users missing one, using collision checks and the unique index. Existing authentication, package, payment, device, and session fields are preserved. The migration is additive and can be rolled back by removing only the new referral fields/collection after taking a MongoDB backup.
