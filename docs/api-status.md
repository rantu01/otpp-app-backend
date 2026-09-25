# Referral API status

Implemented and protected by the existing auth middleware:

- `GET /api/referrals/me` - authenticated customer referral code, joined and successful counts, milestone progress, reward totals, free-trial expiry, and referral history.
- `POST /api/auth/register` - optional `referralCode`; invalid or inactive codes return `400 INVALID_REFERRAL_CODE`.
- `GET /api/admin/referrals/stats` - admin-only real MongoDB totals, distributed days, top referrers, and current configuration.
- `GET /api/admin/referrals?page=1&limit=20&status=pending&search=` - admin-only paginated history with status filtering and user/code search.

Access responses may include `reason: REFERRAL_FREE`, `packageName: Referral free access`, `packageExpireDate`, `freeTrialExpiresAt`, and `freeTrialDays` when referral access is active.

The Android customer profile calls `/api/referrals/me`. The admin Android console calls the two admin endpoints and renders real data, filters, and pagination.
