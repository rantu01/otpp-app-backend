# Referral project overview

The referral system is a backend-controlled extension of the existing OTP platform. The customer app submits an optional invite code at registration and reads progress from the backend profile endpoint. The admin app exposes summary statistics and a paginated referral history inside its existing dashboard.

A registration creates a pending referral relationship. The existing account activation path is the verification boundary. Once active, the referred user receives three additive free days. Each four verified referrals grant the owner five additive free days. Paid package dates are never shortened or overwritten.

The MongoDB `users` document stores stable code, owner, counters, and expiry fields. The `referrals` collection stores relationship status and reward metadata. MongoDB indexes and conditional updates prevent duplicate relationships and milestone rewards.
