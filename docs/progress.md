# Referral implementation progress

- [x] Added referral fields and unique indexes to the existing user model.
- [x] Added the dedicated `referrals` collection with duplicate protection.
- [x] Added collision-safe server-side code generation and legacy backfill.
- [x] Integrated optional referral code capture into customer registration.
- [x] Integrated verification with existing activation and package approval paths.
- [x] Added additive referred-user and milestone-owner free access.
- [x] Added idempotent milestone claiming and repeated-activation protection.
- [x] Added customer and admin referral APIs.
- [x] Added Android registration/profile copy/share/progress UI.
- [x] Added admin referral statistics, search, status filters, details, and pagination.
- [x] Added referral coverage to the backend smoke test.
- [ ] Android Gradle build: wrapper scripts are absent in both Android repositories and no system Gradle executable is installed in this environment.
- [ ] Production deployment verification: run against the deployment's MongoDB and backend after pushing/releasing.
