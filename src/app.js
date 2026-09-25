'use strict';
/**
 * Shared backend for User App + Admin App + Admin Website.
 *
 * Storage: MongoDB ONLY (single shared database from MONGODB_URI /
 * MONGO_DB_NAME). No filesystem, no db.json, no local JSON files.
 * Flow: Frontend -> Backend API -> MongoDB -> Backend API -> Frontend.
 *
 * Run:  npm install && npm run seed && npm start   (http://localhost:4000)
 *
 * Key business rules (also documented in README):
 *  - Access is validated on the backend (evaluateAccess + accessRequired).
 *  - Transaction IDs are unique (normalized: upper-case, no spaces/dashes).
 *  - Approve/Reject is atomic PENDING -> APPROVED/REJECTED via MongoDB
 *    findOneAndUpdate compare-and-swap: two admins racing on the same
 *    payment — only one succeeds.
 *  - Package activation: renewal before expiry extends from current expiry,
 *    otherwise starts from approval date.
 */
try { require('dotenv').config(); } catch { /* dotenv optional */ }
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const store = require('./store');
const cloudinary = require('cloudinary').v2;
const { cloudinaryConfig } = require('./config');
const { ensureMongo, isConnected, getDbName } = require('./mongo');
const { hashPassword, verifyPassword, signToken, authRequired, adminRequired, accessRequired, notBlockedRequired, evaluateAccess, publicUser } = require('./auth');

const app = express();
// Security first (headers + sanitizer + rate limits), then CORS + JSON.
const { installSecurity } = require('./security');
const sec = installSecurity(app, cors);
{
  const allowed = sec.corsAllowList;
  if (allowed && allowed.length) {
    app.use(cors({ origin: allowed, credentials: false }));
  } else {
    app.use(cors());
  }
}
app.use(express.json({ limit: '1mb' }));
const multer = require('multer');
const apkUpload = multer({ storage: multer.memoryStorage() }).single('apk');
cloudinary.config({
  cloud_name: cloudinaryConfig.cloudName,
  api_key: cloudinaryConfig.apiKey,
  api_secret: cloudinaryConfig.apiSecret,
});

const safeError = (res, status, message, extra) =>
  res.status(status).json(Object.assign({ success: false, error: message }, extra || {}));

/** Wrap async routes so MongoDB/validation failures become JSON 500s, never hangs. */
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error('[api] handler failed:', req.method, req.path, e && e.message);
  if (res.headersSent) return next(e);
  return safeError(res, 500, 'Internal server error. Please retry.');
});

/** Require a live MongoDB connection for data routes (health stays reachable). */
async function requireMongo(req, res, next) {
  try {
    await ensureMongo();
    return next();
  } catch (e) {
    return safeError(res, 503, 'Database unavailable. Please retry shortly.');
  }
}
app.use('/api/auth', requireMongo);
app.use('/api/access', requireMongo);
app.use('/api/activation', requireMongo);
app.use('/api/packages', requireMongo);
app.use('/api/payment-methods', requireMongo);
app.use('/api/payments', requireMongo);
app.use('/api/subscriptions', requireMongo);
app.use('/api/admin', requireMongo);
app.use('/api/protected', requireMongo);
app.use('/api/received-payments', requireMongo);
app.use('/api/referrals', requireMongo);

/** Device IDs: case-insensitive, punctuation-insensitive. */
const normalizeDeviceId = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/** Canonical "another device" message shared by login + session enforcement. */
const SESSION_IN_USE_MSG = 'This account is currently logged in on another device. Please log out from that device first, then log in here.';

/**
 * Single active session per account (most important rule).
 * Returns null when the incoming device may proceed, or an error descriptor
 * when a DIFFERENT device still holds the live session.
 * Same-device re-login is always allowed (session rotates to the new token).
 */
function singleSessionBlock(user, incomingNorm) {
  const stored = normalizeDeviceId(user.activeDeviceId || user.deviceIdNorm || user.deviceId || '');
  const incoming = normalizeDeviceId(incomingNorm || '');
  if (!user.activeSessionId) return null;
  // Same device re-login is always allowed (session rotates to the new token).
  if (stored && incoming && stored === incoming) return null;
  // Any other case with an active session: block (fail closed).
  return { code: 'SESSION_IN_USE', message: SESSION_IN_USE_MSG };
}

// ---------------- public: health + version check ----------------
app.get('/api/health', (req, res) => {
  // build.commit lets you confirm WHAT code is actually running in production:
  // Render sets RENDER_GIT_COMMIT automatically on every deploy. If `commit`
  // here does not match your latest GitHub commit, Render is still serving
  // old code (redeploy) — auto-verify fixes only take effect after deploy.
  res.json({
    success: true,
    status: 'ok',
    time: new Date().toISOString(),
    db: isConnected() ? 'mongo' : 'disconnected',
    mongoDb: getDbName(),
    autoVerify: true,
    recvpay: true,
    build: {
      commit: String(process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'local').slice(0, 12),
      branch: String(process.env.RENDER_GIT_BRANCH || ''),
      service: String(process.env.RENDER_SERVICE_NAME || ''),
    },
  });
});

// GET /api/versions/check?platform=android&version=1.0.0
app.get('/api/versions/check', ah(async (req, res) => {
  await ensureMongo();
  const platform = String(req.query.platform || 'android').toLowerCase();
  const installed = String(req.query.version || '0');
  const installedCode = Math.max(0, Number.parseInt(String(req.query.versionCode || '0'), 10) || 0);
  const v = (await store.findVersion(platform)) || (await store.findFirstVersion()) || null;
  if (!v) return res.json({ success: true, forceUpdate: false, updateAvailable: false, installed, installedCode });
  const belowMin = store.cmpVersions(installed, v.minimumSupportedVersion) < 0;
  const behindVersion = store.cmpVersions(installed, v.latestVersion) < 0;
  const behindCode = installedCode > 0 && installedCode < Number(v.latestVersionCode || 1);
  const behind = behindVersion || behindCode;
  const forceUpdate = belowMin || (behind && !!v.updateRequired);
  res.json({
    success: true,
    installed,
    latestVersion: v.latestVersion,
    latestVersionCode: Number(v.latestVersionCode || 1),
    minimumSupportedVersion: v.minimumSupportedVersion,
    updateRequired: !!v.updateRequired,
    updateUrl: v.updateUrl || '',
    message: v.message || '',
    updateAvailable: behind,
    forceUpdate,
    blocked: belowMin,
  });
}));

// ---------------- auth ----------------
app.post('/api/auth/register', ah(async (req, res) => {
  const { name, email, phone, password, referralCode } = req.body || {};
  if (!password || String(password).length < 4) return safeError(res, 400, 'Password must be at least 4 characters.');
  const login = String(email || phone || '').trim().toLowerCase();
  if (!login) return safeError(res, 400, 'Email or phone is required.');
  if (await store.loginExists(login)) {
    return safeError(res, 409, 'Account already exists. Please login.');
  }
  let referrer = null;
  if (referralCode) {
    if (!store.referralConfig().enabled) return safeError(res, 400, 'Referral invites are currently disabled.');
    referrer = await store.findUserByReferralCode(referralCode);
    if (!referrer || referrer.status !== 'active' || referrer.accessEnabled === false) {
      return safeError(res, 400, 'That referral code is invalid or inactive.', { code: 'INVALID_REFERRAL_CODE' });
    }
  }
  let user;
  try {
    user = await store.createUser({
      name: String(name || login.split('@')[0] || 'User'),
      email: String(email || '').trim() || null,
      phone: String(phone || '').trim() || null,
      passwordHash: hashPassword(password),
      role: 'user',
      // New accounts stay unusable until an admin approves them:
      // evaluateAccess() returns PENDING, clients must block Home/packages.
      // Approval (payment approve or manual access PATCH) flips status to active.
      status: 'pending',
      accessEnabled: true,
      currentPackageId: null,
      currentPackageName: null,
      packageStartDate: null,
      packageExpireDate: null,
      referredBy: referrer ? referrer.id : null,
      createdAt: store.nowIso(),
    });
  } catch (e) {
    // Lost a registration race — same outcome as the pre-check above.
    if (e && e.code === 'DUPLICATE_LOGIN') {
      return safeError(res, 409, 'Account already exists. Please login.');
    }
    throw e;
  }
  // New account logs straight into its first (and only) session.
  const sid = crypto.randomUUID();
  const devNorm = normalizeDeviceId(req.body && req.body.deviceId);
  user = await store.updateUserById(user.id, {
    activeSessionId: sid,
    activeDeviceId: devNorm || null,
    ...(devNorm ? { deviceId: devNorm, deviceIdNorm: store.deviceKey(devNorm) } : {}),
    lastLoginAt: store.nowIso(),
  });
  if (referrer) {
    const referral = await store.createReferral({
      referrerUserId: referrer.id,
      referredUserId: user.id,
      referralCode: referrer.referralCode,
      status: 'pending',
      createdAt: store.nowIso(),
    });
    if (referral && referral.created) await store.incrementUserCounters(referrer.id, { referralCount: 1 });
  }
  res.status(201).json({ success: true, token: signToken(user, sid), user: publicUser(user), access: evaluateAccess(null, user) });
}));

app.post('/api/auth/login', ah(async (req, res) => {
  const { email, phone, login, password } = req.body || {};
  const key = String(login || email || phone || '').trim().toLowerCase();
  if (!key || !password) return safeError(res, 400, 'Login and password are required.');
  // .env is the source of truth: admin login works from ADMIN_EMAIL /
  // ADMIN_PASSWORD even if seed was never run (DB auto-syncs here).
  // Sync runs ONLY for the admin login itself — regular user logins skip it
  // (it used to cost up to 3 extra queries on every login).
  if (key === String(process.env.ADMIN_EMAIL || '').trim().toLowerCase()) {
    await syncAdminFromEnv();
  }
  const user = await store.findUserByLogin(key);
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return safeError(res, 401, 'Invalid login or password.');
  }
  // Account-level gate: pending/disabled/blocked accounts cannot log in at all,
  // even with the right password. Active accounts without a package CAN log in
  // (they are routed to the package/purchase flow, never to Home).
  // Free-role accounts bypass the package requirement entirely.
  const access = evaluateAccess(null, user);
  if (!access.allowed && access.reason !== 'NO_PACKAGE') {
    return safeError(res, 403, access.message, { code: access.reason, access });
  }
  // Device binding: a device-locked account only works from its own device.
  // Accounts created before device binding adopt the first device they
  // successfully log in from (password already verified above).
  const reqDevice = normalizeDeviceId(req.body.deviceId);
  if (user.role !== 'admin') {
    // One device per account: a live session on another device is
    // terminated so the new device can log in (previous token invalidated).
    const block = singleSessionBlock(user, reqDevice);
    if (block) {
      await store.updateUserById(user.id, { activeSessionId: null, activeDeviceId: null });
      user = await store.findUserById(user.id);
    }
    if (user.deviceId && reqDevice && normalizeDeviceId(user.deviceId) !== reqDevice && !user.activeSessionId) {
      // Logged out earlier on another device: adopt the new device.
      const sid = crypto.randomUUID();
      const updated = await store.updateUserById(user.id, {
        deviceId: reqDevice,
        deviceIdNorm: store.deviceKey(reqDevice),
        activeSessionId: sid,
        activeDeviceId: reqDevice,
        lastLoginAt: store.nowIso(),
      });
      return res.json({ success: true, token: signToken(updated, sid), user: publicUser(updated), access: evaluateAccess(null, updated) });
    }
    if (user.deviceId && reqDevice && normalizeDeviceId(user.deviceId) !== reqDevice) {
      const denied = { allowed: false, reason: 'DEVICE_MISMATCH', message: 'This account is activated on a different device. Contact admin.' };
      return safeError(res, 403, denied.message, { code: denied.reason, access: denied });
    }
    if (!user.deviceId && reqDevice) {
      const sid = crypto.randomUUID();
      const updated = await store.updateUserById(user.id, {
        deviceId: reqDevice,
        deviceIdNorm: store.deviceKey(reqDevice),
        activeSessionId: sid,
        activeDeviceId: reqDevice,
        lastLoginAt: store.nowIso(),
      });
      return res.json({ success: true, token: signToken(updated, sid), user: publicUser(updated), access: evaluateAccess(null, updated) });
    }
    // No device identity change: (re)bind the live session to this login.
    const sid = crypto.randomUUID();
    const updated = await store.updateUserById(user.id, {
      activeSessionId: sid,
      activeDeviceId: reqDevice || normalizeDeviceId(user.deviceId || user.deviceIdNorm || '') || null,
      lastLoginAt: store.nowIso(),
    });
    return res.json({ success: true, token: signToken(updated, sid), user: publicUser(updated), access: evaluateAccess(null, updated) });
  }
  // Admin logins: no single-device restriction — admins may log in
  // from any device (same-session rotation still applies).
  {
    const sid = crypto.randomUUID();
    const updated = await store.updateUserById(user.id, {
      activeSessionId: sid,
      activeDeviceId: reqDevice || normalizeDeviceId(user.deviceId || user.deviceIdNorm || '') || null,
      lastLoginAt: store.nowIso(),
    });
    return res.json({ success: true, token: signToken(updated, sid), user: publicUser(updated), access: evaluateAccess(null, updated) });
  }
}));

app.get('/api/auth/me', notBlockedRequired, (req, res) => {
  // req.user was loaded fresh from MongoDB by the auth middleware in this
  // same request — no second fetch needed.
  if (!req.user) return safeError(res, 401, 'Account not found.', { code: 'NO_ACCOUNT' });
  res.json({ success: true, user: publicUser(req.user), access: evaluateAccess(null, req.user) });
});

app.get('/api/referrals/me', authRequired, ah(async (req, res) => {
  if (req.user.role === 'admin') return safeError(res, 403, 'Referral data is only available for customer accounts.');
  res.json({ success: true, referral: await store.getMyReferral(req.user.id) });
}));

app.get('/api/admin/referrals/stats', adminRequired, ah(async (req, res) => {
  res.json({ success: true, stats: await store.referralStats() });
}));

app.get('/api/admin/referrals', adminRequired, ah(async (req, res) => {
  const paged = await store.listReferrals(req.query);
  res.json({ success: true, ...paged });
}));

// Logout: clears the live session so the SAME account can log in from another
// device afterwards. Without this, single-session blocking would be permanent.
app.post('/api/auth/logout', ah(async (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.json({ success: true, loggedOut: false });
  let payload = null;
  try {
    payload = require('jsonwebtoken').verify(token, process.env.JWT_SECRET || 'change-me-to-a-long-random-secret');
  } catch {
    return res.json({ success: true, loggedOut: false });
  }
  const user = await store.findUserById(Number(payload.sub));
  if (!user) return res.json({ success: true, loggedOut: false });
  // Only the holder of the live session (or a legacy token) may clear it;
  // a stale rotated-out token must not log out the current device.
  if (!user.activeSessionId || !payload.sid || user.activeSessionId === String(payload.sid)) {
    await store.updateUserById(user.id, { activeSessionId: null, activeDeviceId: null });
  }
  res.json({ success: true, loggedOut: true });
}));

// Change password: username (email/phone login) is NEVER editable here or
// anywhere else — only the password hash changes. Requires the current
// password so a stolen token alone is not enough.
app.post('/api/auth/change-password', ah(async (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return safeError(res, 401, 'Not authenticated');
  let payload = null;
  try {
    payload = require('jsonwebtoken').verify(token, process.env.JWT_SECRET || 'change-me-to-a-long-random-secret');
  } catch {
    return safeError(res, 401, 'Session expired. Please login again.');
  }
  const user = await store.findUserRawById(Number(payload.sub));
  if (!user) return safeError(res, 401, 'Account not found.', { code: 'NO_ACCOUNT' });
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || String(newPassword).length < 4) {
    return safeError(res, 400, 'New password must be at least 4 characters.');
  }
  const lean = user.toObject ? user.toObject() : user;
  if (!verifyPassword(currentPassword, lean.passwordHash)) {
    return safeError(res, 400, 'Current password is incorrect.', { code: 'BAD_CURRENT_PASSWORD' });
  }
  // Explicit allow-list: passwordHash only. Email/phone/login/username can
  // never be changed through this endpoint (or any user-facing endpoint).
  const forbidden = ['email', 'phone', 'login', 'username', 'name', 'role', 'status'];
  for (const k of forbidden) {
    if (req.body && req.body[k] !== undefined && k !== 'name') {
      return safeError(res, 400, 'Username cannot be changed.', { code: 'USERNAME_IMMUTABLE' });
    }
  }
  await store.updateUserPassword(Number(payload.sub), hashPassword(newPassword));
  res.json({ success: true, message: 'Password changed successfully.' });
}));

// Device activation (User App first-run flow, no password).
// POST /api/auth/device { deviceId } -> finds the device account or creates a
// PENDING one, and returns a JWT + live access state. The token only opens the
// package/purchase flow until an admin approves (same gate as accounts).
// Email/phone register+login below are preserved unchanged for admin surfaces.
app.post('/api/auth/device', ah(async (req, res) => {
  const norm = store.normalizeDeviceId((req.body || {}).deviceId);
  if (!norm) {
    return safeError(res, 400, 'A valid Device ID is required.', { code: 'BAD_DEVICE_ID' });
  }
  let user = await store.findUserByDeviceNorm(norm);
  if (!user) {
    try {
      user = await store.createUser({
        name: 'Device ' + norm.slice(0, 8),
        email: null,
        phone: null,
        // Unhashable random secret: this account can never log in by password.
        passwordHash: hashPassword('dev-locked-' + norm + '-' + Date.now() + '-' + Math.random()),
        role: 'user',
        status: 'pending',
        accessEnabled: true,
        deviceId: norm,
        deviceIdNorm: norm,
        currentPackageId: null,
        currentPackageName: null,
        packageStartDate: null,
        packageExpireDate: null,
        createdAt: store.nowIso(),
      });
    } catch (e) {
      // Lost a create race (same device activated twice at once): re-read
      // the winner instead of surfacing HTTP 500 "Internal server error".
      if (e && e.code === 'DUPLICATE_LOGIN') {
        user = await store.findUserByDeviceNorm(norm);
        if (!user) throw e;
      } else {
        throw e;
      }
    }
  }
  const access = evaluateAccess(null, user);
  // Server-side kill-switch: a disabled/blocked device must NOT receive a
  // fresh token, even if the app still holds an old JWT with an open modal.
  // PENDING and NO_PACKAGE accounts may proceed to the purchase flow.
  if (!access.allowed && access.reason !== 'NO_PACKAGE' && access.reason !== 'PENDING') {
    return safeError(res, 403, access.message, { code: access.reason, access });
  }
  // Bind the single live session to this device login (same-device rotation).
  const devSid = crypto.randomUUID();
  user = await store.updateUserById(user.id, {
    activeSessionId: devSid, activeDeviceId: norm, lastLoginAt: store.nowIso(),
  });
  res.json({ success: true, token: signToken(user, devSid), user: publicUser(user), access });
}));

// ---------------- device activation (User App first-run screen) ----------------
// Public: the device ID itself is the claim. New devices get a PENDING account
// (unusable until admin approval, exactly like register). Known devices get a
// fresh token unless the account itself is blocked (403, no bypass).
app.post('/api/auth/activate', ah(async (req, res) => {
  const deviceId = normalizeDeviceId(req.body && req.body.deviceId);
  if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
    return safeError(res, 400, 'A valid Device ID is required.');
  }
  const user = await store.findUserByDevice(deviceId);
  if (user) {
    if (user.role === 'admin') return safeError(res, 403, 'Admins cannot activate the User App.');
    const access = evaluateAccess(null, user);
    if (!access.allowed && access.reason !== 'NO_PACKAGE' && access.reason !== 'PENDING') {
      return safeError(res, 403, access.message, { code: access.reason, access });
    }
    const actSid = crypto.randomUUID();
    const bound = await store.updateUserById(user.id, {
      activeSessionId: actSid, activeDeviceId: deviceId, lastLoginAt: store.nowIso(),
    });
    return res.json({ success: true, registered: true, token: signToken(bound, actSid), user: publicUser(bound), access });
  }
  let created;
  try {
    created = await store.createUser({
      name: 'Device ' + deviceId.slice(0, 8),
      email: null,
      phone: null,
      // Random unguessable secret: device accounts authenticate via their
      // device ID (this endpoint) and can never log in with a password.
      passwordHash: hashPassword(crypto.randomBytes(32).toString('hex')),
      role: 'user',
      status: 'pending',
      accessEnabled: true,
      deviceId,
      deviceIdNorm: store.deviceKey(deviceId),
      currentPackageId: null,
      currentPackageName: null,
      packageStartDate: null,
      packageExpireDate: null,
      createdAt: store.nowIso(),
    });
  } catch (e) {
    // Lost a create race: re-read the winner instead of HTTP 500.
    if (e && e.code === 'DUPLICATE_LOGIN') {
      const winner = await store.findUserByDevice(deviceId);
      if (winner) {
        if (winner.role === 'admin') return safeError(res, 403, 'Admins cannot activate the User App.');
        const access = evaluateAccess(null, winner);
        if (!access.allowed && access.reason !== 'NO_PACKAGE' && access.reason !== 'PENDING') {
          return safeError(res, 403, access.message, { code: access.reason, access });
        }
        const wSid = crypto.randomUUID();
        const bound = await store.updateUserById(winner.id, {
          activeSessionId: wSid, activeDeviceId: deviceId, lastLoginAt: store.nowIso(),
        });
        return res.json({ success: true, registered: true, token: signToken(bound, wSid), user: publicUser(bound), access });
      }
    }
    throw e;
  }
  const createdSid = crypto.randomUUID();
  created = await store.updateUserById(created.id, {
    activeSessionId: createdSid, activeDeviceId: deviceId, lastLoginAt: store.nowIso(),
  });
  res.status(201).json({ success: true, registered: false, token: signToken(created, createdSid), user: publicUser(created), access: evaluateAccess(null, created) });
}));

// Public activation lookup: lets the app show "pending admin approval" state
// for a device without holding a token.
app.get('/api/activation/status', ah(async (req, res) => {
  const deviceId = normalizeDeviceId(req.query.deviceId);
  if (!deviceId) return safeError(res, 400, 'deviceId is required.');
  const user = await store.findUserByDevice(deviceId);
  if (!user) {
    return res.json({ success: true, registered: false, access: { allowed: false, reason: 'NO_ACCOUNT', message: 'Device not registered.' } });
  }
  res.json({ success: true, registered: true, access: evaluateAccess(null, user), user: publicUser(user) });
}));

// Backend-validated access status (User App startup flow calls this).
// Server-side kill-switch: DISABLED / ACCESS_DENIED accounts get an
// immediate 403 (with the access object) even with a valid JWT, so an
// already-open OTP modal cannot keep working after an admin disables
// the user. PENDING / NO_PACKAGE accounts pass through with 200.
app.get('/api/access/status', notBlockedRequired, (req, res) => {
  // Same-request fresh user from the middleware — no second fetch needed.
  if (!req.user) return safeError(res, 401, 'Account not found.', { code: 'NO_ACCOUNT' });
  const access = evaluateAccess(null, req.user);
  res.json({ success: true, access, user: publicUser(req.user) });
});

// Example protected API: disabled/expired users are blocked here.
app.get('/api/protected/demo', accessRequired, (req, res) => {
  res.json({ success: true, message: 'Protected content.', userId: req.user.id });
});

// ---------------- user-facing catalog (active only) ----------------
// notBlockedRequired: disabled accounts are rejected server-side (403) even
// with a valid JWT; PENDING / NO_PACKAGE accounts may browse so they can buy.
app.get('/api/packages', notBlockedRequired, ah(async (req, res) => {
  const list = await store.listPackages(true);
  res.json({ success: true, packages: list });
}));

app.get('/api/payment-methods', notBlockedRequired, ah(async (req, res) => {
  const list = await store.listMethods(true);
  res.json({ success: true, paymentMethods: list });
}));

// ---------------- user: payments ----------------
// notBlockedRequired: a disabled user cannot submit or list payments even
// with a still-valid JWT; PENDING / NO_PACKAGE users may submit (approval path).
app.post('/api/payments', notBlockedRequired, ah(async (req, res) => {
  const { packageId, paymentMethodId, transactionId } = req.body || {};
  const idemKey = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : null;
  const txid = String(transactionId || '').trim();
  if (!packageId) return safeError(res, 400, 'Package is required.');
  if (!paymentMethodId) return safeError(res, 400, 'Payment method is required.');
  if (!txid) return safeError(res, 400, 'Transaction ID is required.');

  // Idempotency: network retry / double-tap with same key returns the original.
  if (idemKey) {
    const priorId = await store.findPaymentIdByIdemKey(idemKey);
    if (priorId) {
      const existing = await store.findPaymentById(priorId);
      if (existing) return res.status(200).json({ success: true, payment: existing, deduped: true });
    }
  }

  // Independent lookups, concurrently (was 3 sequential round trips).
  const norm = store.normalizeTxid(txid);
  const [pkg, method, dup] = await Promise.all([
    store.findPackageById(Number(packageId)),
    store.findMethodById(Number(paymentMethodId)),
    store.findDuplicateTxid(norm),
  ]);
  if (!pkg || pkg.status !== 'active') return safeError(res, 400, 'Invalid or inactive package.');
  if (!method || method.status !== 'active') return safeError(res, 400, 'Invalid or inactive payment method.');

  // Backend duplicate-transaction guard (source of truth, not frontend).
  if (dup) return safeError(res, 409, 'This Transaction ID has already been submitted.', { code: 'DUPLICATE_TXID' });

  let payment;
  try {
    payment = await store.createPayment({
      userId: req.user.id,
      userName: req.user.name,
      userEmail: req.user.email,
      deviceId: req.user.deviceIdNorm || req.user.deviceId || null,
      packageId: pkg.id,
      packageName: pkg.name,
      amount: pkg.price,
      durationDays: pkg.durationDays,
      paymentMethodId: method.id,
      paymentMethodName: method.name,
      walletNumber: method.walletNumber,
      transactionId: txid,
      transactionIdNorm: norm,
      status: 'PENDING',
      submittedAt: store.nowIso(),
      reviewedAt: null,
      reviewedBy: null,
      rejectionReason: null,
    });
  } catch (e) {
    if (e && e.code === 'DUPLICATE_TXID') {
      return safeError(res, 409, 'This Transaction ID has already been submitted.', { code: 'DUPLICATE_TXID' });
    }
    throw e;
  }
  // Automatic approval rule: TrxID match is sufficient.
  //   received_payments.trxIdNorm === payments.transactionIdNorm
  // If a matching SMS record exists, approve immediately through the same
  // atomic path as manual approval (flagged autoVerified + reviewedBy AUTO).
  // Anything else stays PENDING for manual review — never auto-rejected.
  console.log(`[PAYMENT AUTO VERIFY] Submit Payment received (payment #${payment.id})`);
  console.log(`[PAYMENT AUTO VERIFY] Transaction ID: ${norm}`);
  const auto = await store.tryAutoApprove(payment);
  payment = auto.payment;
  // Independent writes, concurrently.
  await Promise.all([
    idemKey ? store.saveIdemKey(idemKey, payment.id) : Promise.resolve(),
    // Admin notification (Admin App polls this; push fan-out below).
    // tryAutoApprove already logged its own AUTO_APPROVED notification.
    auto.auto ? Promise.resolve() : store.createNotification({
      type: 'NEW_PAYMENT',
      title: 'New payment received for verification',
      message: `${req.user.name} paid ${pkg.price} for ${pkg.name} via ${method.name} (TxID ${txid})`,
      paymentRequestId: payment.id,
    }),
  ]);
  await pushToAdmins(auto.auto
    ? `Auto-verified payment: ${pkg.name} / TxID ${txid}`
    : `New payment: ${pkg.name} / TxID ${txid}`);
  // The response tells the customer whether auto-verification fired.
  // verifyNote explains WHY when it did not (e.g. no SMS record yet).
  res.status(201).json({
    success: true,
    payment,
    autoVerified: auto.auto,
    status: payment.status,
    message: auto.auto
      ? 'Payment verified automatically.'
      : 'Payment submitted and is waiting for verification.',
    verifyOutcome: auto.outcome,
    verifyNote: auto.note || payment.verifyNote || null,
  });
}));

app.get('/api/payments/mine', notBlockedRequired, ah(async (req, res) => {
  const list = await store.listUserPayments(req.user.id);
  res.json({ success: true, payments: list });
}));

app.get('/api/subscriptions/mine', notBlockedRequired, ah(async (req, res) => {
  // Independent reads, concurrently.
  const [list, user] = await Promise.all([
    store.listUserSubscriptions(req.user.id),
    store.findUserById(req.user.id),
  ]);
  res.json({ success: true, subscriptions: list, current: user ? {
    packageId: user.currentPackageId, packageName: user.currentPackageName,
    start: user.packageStartDate, expire: user.packageExpireDate,
  } : null });
}));

// ---------------- admin: dashboard ----------------
app.get('/api/admin/dashboard', adminRequired, ah(async (req, res) => {
  const { stats, profit } = await store.dashboardStats();
  res.json({ success: true, stats, profit });
}));

// ---------------- admin: profit & withdrawals (transparent split ledger) ----------------
// Profit = APPROVED payments only. Withdrawals deduct from the remaining pool.
// Splits: Alamin 20% / Rantu 40% / Rony 40% (env-overridable, see profitConfig).
app.get('/api/admin/profits', adminRequired, ah(async (req, res) => {
  const profit = await store.profitSummary();
  res.json({ success: true, profit, config: store.profitConfig() });
}));

app.get('/api/admin/withdrawals', adminRequired, ah(async (req, res) => {
  // Independent reads, concurrently.
  const [paged, profit] = await Promise.all([
    store.listWithdrawals(req.query),
    store.profitSummary(),
  ]);
  res.json({ success: true, withdrawals: paged.withdrawals, profit, config: store.profitConfig(), total: paged.total, page: paged.page, limit: paged.limit, hasMore: paged.hasMore });
}));

// Record a payout to one of the three partners. Deducts from remaining profit.
app.post('/api/admin/withdrawals', adminRequired, ah(async (req, res) => {
  const { person, phone, amount, note } = req.body || {};
  const sum = Number(amount);
  if (!Number.isFinite(sum) || sum <= 0) return safeError(res, 400, 'A positive amount is required.');
  const people = store.profitConfig();
  const who = people.find((p) => p.key === String(person || '').toLowerCase() || p.name.toLowerCase() === String(person || '').toLowerCase());
  if (!who) return safeError(res, 400, 'person must be one of: alamin, rantu, rony.');
  const profit = await store.profitSummary();
  if (sum > profit.remaining) {
    return safeError(res, 409, `Insufficient remaining profit (৳${profit.remaining}).`, { remaining: profit.remaining });
  }
  const record = await store.createWithdrawal({
    person: who.name,
    personKey: who.key,
    phone: String(phone || who.phone || ''),
    amount: Math.round(sum * 100) / 100,
    // Snapshot so history stays transparent even if later payments arrive.
    totalProfitAtTime: profit.total,
    withdrawnTotalBefore: profit.withdrawnTotal,
    remainingAfter: Math.round((profit.remaining - sum) * 100) / 100,
    sharesAtTime: profit.people,
    note: String(note || ''),
    createdBy: req.user.id,
    createdAt: store.nowIso(),
  });
  // The payout only moves withdrawnTotal/remaining — derive the fresh profit
  // from the snapshot instead of re-running the full rollup.
  res.status(201).json({ success: true, withdrawal: record, profit: store.applyWithdrawalProfit(profit, record.amount) });
}));

// ---------------- admin: users ----------------
app.get('/api/admin/users', adminRequired, ah(async (req, res) => {
  const paged = await store.listUsers(req.query.search, req.query);
  res.json({ success: true, users: paged.users.map(publicUser), total: paged.total, page: paged.page, limit: paged.limit, hasMore: paged.hasMore });
}));

// Create a user manually (admin). role: 'user' (default) or 'free' (no payment needed).
app.post('/api/admin/users', adminRequired, ah(async (req, res) => {
  const { name, email, phone, password, role } = req.body || {};
  const login = String(email || phone || '').trim().toLowerCase();
  if (!login) return safeError(res, 400, 'Email or phone is required.');
  if (!password || String(password).length < 4) return safeError(res, 400, 'Password must be at least 4 characters.');
  const wantRole = String(role || 'user').toLowerCase();
  if (!['user', 'free'].includes(wantRole)) return safeError(res, 400, "role must be 'user' or 'free'.");
  if (await store.loginExists(login)) {
    return safeError(res, 409, 'Account already exists.');
  }
  let user;
  try {
    user = await store.createUser({
      name: String(name || login.split('@')[0] || 'User'),
      email: String(email || '').trim() || null,
      phone: String(phone || '').trim() || null,
      passwordHash: hashPassword(password),
      role: wantRole,
      status: 'active',
      accessEnabled: true,
      currentPackageId: null,
      currentPackageName: wantRole === 'free' ? 'Free' : null,
      packageStartDate: null,
      packageExpireDate: null,
      createdAt: store.nowIso(),
    });
  } catch (e) {
    if (e && e.code === 'DUPLICATE_LOGIN') {
      return safeError(res, 409, 'Account already exists.');
    }
    throw e;
  }
  res.status(201).json({ success: true, user: publicUser(user), access: evaluateAccess(null, user) });
}));

// Remove a user (admin). Also drops their payments/subscriptions references? No:
// history is preserved; only the account is deleted (payments keep userId).
app.delete('/api/admin/users/:id', adminRequired, ah(async (req, res) => {
  const removed = await store.deleteUserById(Number(req.params.id));
  if (!removed) return safeError(res, 404, 'User not found.');
  res.json({ success: true, removed: publicUser(removed) });
}));

// Enable/disable access, or set status/role (role: user <-> free).
// Username (email/phone login) is immutable: any attempt to change it here
// is rejected so usernames always stay unique and never editable.
app.patch('/api/admin/users/:id/access', adminRequired, ah(async (req, res) => {
  const user = await store.findUserById(Number(req.params.id));
  if (!user || user.role === 'admin') return safeError(res, 404, 'User not found.');
  for (const k of ['email', 'phone', 'login', 'username']) {
    if (req.body && req.body[k] !== undefined) {
      return safeError(res, 400, 'Username cannot be changed.', { code: 'USERNAME_IMMUTABLE' });
    }
  }
  const patch = {};
  if (req.body.accessEnabled !== undefined) patch.accessEnabled = !!req.body.accessEnabled;
  if (req.body.status !== undefined) {
    if (!['active', 'disabled', 'pending'].includes(req.body.status)) return safeError(res, 400, 'Invalid status.');
    patch.status = req.body.status;
  }
  if (req.body.role !== undefined) {
    const r = String(req.body.role).toLowerCase();
    if (!['user', 'free'].includes(r)) return safeError(res, 400, "role must be 'user' or 'free'.");
    patch.role = r;
    if (r === 'free') {
      patch.status = 'active';
      patch.accessEnabled = true;
      if (!user.currentPackageName) patch.currentPackageName = 'Free';
    }
  }
  const updated = await store.updateUserById(user.id, patch);
  if (updated && updated.status === 'active') await store.verifyReferralForUser(updated.id);
  res.json({ success: true, user: publicUser(updated), access: evaluateAccess(null, updated) });
}));

// Re-bind or clear a user's device (device change / reinstall support).
app.patch('/api/admin/users/:id/device', adminRequired, ah(async (req, res) => {
  const user = await store.findUserById(Number(req.params.id));
  if (!user || user.role === 'admin') return safeError(res, 404, 'User not found.');
  const raw = req.body.deviceId;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    // Clearing the device also clears the live session so the account can
    // log in fresh from another device (single-session support).
    const updated = await store.updateUserById(user.id, { deviceId: null, deviceIdNorm: null, activeSessionId: null, activeDeviceId: null });
    return res.json({ success: true, user: publicUser(updated), access: evaluateAccess(null, updated) });
  }
  const d = normalizeDeviceId(raw);
  if (d.length < 8 || d.length > 64) return safeError(res, 400, 'Invalid Device ID.');
  const clash = await store.findUserByDevice(d);
  if (clash && clash.id !== user.id) return safeError(res, 409, 'That Device ID is already bound to another account.');
  // deviceIdNorm is maintained alongside deviceId so lookups stay indexed.
  const updated = await store.updateUserById(user.id, { deviceId: d, deviceIdNorm: store.deviceKey(d) });
  res.json({ success: true, user: publicUser(updated), access: evaluateAccess(null, updated) });
}));

// Manually assign/extend a package (uses the same renewal rule as approval).
app.post('/api/admin/users/:id/assign-package', adminRequired, ah(async (req, res) => {
  // Independent reads, concurrently.
  const [user, pkg] = await Promise.all([
    store.findUserById(Number(req.params.id)),
    store.findPackageById(Number(req.body.packageId)),
  ]);
  if (!user || user.role === 'admin') return safeError(res, 404, 'User not found.');
  if (!pkg || pkg.status !== 'active') return safeError(res, 400, 'Invalid or inactive package.');
  const { start, expire } = store.activationWindow(user, pkg.durationDays, Date.now());
  const startIso = new Date(start).toISOString();
  const expireIso = new Date(expire).toISOString();
  const updated = await store.updateUserById(user.id, {
    currentPackageId: pkg.id,
    currentPackageName: pkg.name,
    packageStartDate: startIso,
    packageExpireDate: expireIso,
  });
  const sub = await store.createSubscription({
    userId: user.id, packageId: pkg.id,
    packageName: pkg.name, price: pkg.price, durationDays: pkg.durationDays,
    startDate: startIso, expireDate: expireIso,
    status: 'active', paymentRequestId: null, createdAt: store.nowIso(), createdBy: req.user.id,
    deviceId: user.deviceIdNorm || user.deviceId || null,
  });
  res.json({ success: true, user: publicUser(updated), subscription: sub });
}));

// ---------------- admin: packages ----------------
app.get('/api/admin/packages', adminRequired, ah(async (req, res) => {
  res.json({ success: true, packages: await store.listPackages(false) });
}));
app.post('/api/admin/packages', adminRequired, ah(async (req, res) => {
  const { name, price, durationDays, status, description } = req.body || {};
  if (!name || price === undefined || !durationDays) return safeError(res, 400, 'name, price and durationDays are required.');
  const pkg = await store.createPackage({
    name: String(name), price: Number(price),
    durationDays: Number(durationDays), status: status === 'inactive' ? 'inactive' : 'active',
    description: String(description || ''),
  });
  res.status(201).json({ success: true, package: pkg });
}));
app.put('/api/admin/packages/:id', adminRequired, ah(async (req, res) => {
  const patch = {};
  for (const k of ['name', 'description']) if (req.body[k] !== undefined) patch[k] = String(req.body[k]);
  for (const k of ['price', 'durationDays']) if (req.body[k] !== undefined) patch[k] = Number(req.body[k]);
  if (req.body.status !== undefined) patch.status = req.body.status === 'inactive' ? 'inactive' : 'active';
  // Single atomic op (was read-then-write); null means not found.
  const pkg = await store.updatePackageById(Number(req.params.id), patch);
  if (!pkg) return safeError(res, 404, 'Package not found.');
  res.json({ success: true, package: pkg });
}));

// Delete a package. Blocked while PENDING payments reference it (history for
// APPROVED/REJECTED payments is preserved — only the catalog entry is removed).
app.delete('/api/admin/packages/:id', adminRequired, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (await store.hasPendingRefToPackage(id)) return safeError(res, 409, 'Cannot delete: pending payments reference this package.');
  const removed = await store.deletePackageById(id);
  if (!removed) return safeError(res, 404, 'Package not found.');
  res.json({ success: true, removed });
}));

// ---------------- admin: payment methods ----------------
app.get('/api/admin/payment-methods', adminRequired, ah(async (req, res) => {
  res.json({ success: true, paymentMethods: await store.listMethods(false) });
}));
app.post('/api/admin/payment-methods', adminRequired, ah(async (req, res) => {
  const { name, walletNumber, accountType, logo, instructions, status, sortOrder } = req.body || {};
  if (!name || !walletNumber) return safeError(res, 400, 'name and walletNumber are required.');
  const patch = {
    name: String(name), walletNumber: String(walletNumber),
    accountType: String(accountType || 'Personal'), logo: String(logo || ''),
    instructions: String(instructions || 'Send Money to this number.'),
    status: status === 'inactive' ? 'inactive' : 'active',
  };
  if (sortOrder !== undefined) patch.sortOrder = Number(sortOrder);
  const m = await store.createMethod(patch);
  res.status(201).json({ success: true, paymentMethod: m });
}));
app.put('/api/admin/payment-methods/:id', adminRequired, ah(async (req, res) => {
  const patch = {};
  for (const k of ['name', 'walletNumber', 'accountType', 'logo', 'instructions']) {
    if (req.body[k] !== undefined) patch[k] = String(req.body[k]);
  }
  if (req.body.status !== undefined) patch.status = req.body.status === 'inactive' ? 'inactive' : 'active';
  if (req.body.sortOrder !== undefined) patch.sortOrder = Number(req.body.sortOrder);
  // Single atomic op (was read-then-write); null means not found.
  const m = await store.updateMethodById(Number(req.params.id), patch);
  if (!m) return safeError(res, 404, 'Payment method not found.');
  res.json({ success: true, paymentMethod: m });
}));
app.delete('/api/admin/payment-methods/:id', adminRequired, ah(async (req, res) => {
  const id = Number(req.params.id);
  if (await store.hasPendingRefToMethod(id)) return safeError(res, 409, 'Cannot delete: pending payments reference this method.');
  const removed = await store.deleteMethodById(id);
  if (!removed) return safeError(res, 404, 'Payment method not found.');
  res.json({ success: true, removed });
}));

// ---------------- admin: payments verify/history ----------------
app.get('/api/admin/payments', adminRequired, ah(async (req, res) => {
  const { status, search, page, limit, before } = req.query;
  const paged = await store.listPayments({ status, search, page, limit, before });
  res.json({ success: true, payments: paged.payments, total: paged.total, page: paged.page, limit: paged.limit, hasMore: paged.hasMore });
}));

app.get('/api/admin/payments/pending-count', adminRequired, ah(async (req, res) => {
  res.json({ success: true, pending: await store.countPendingPayments() });
}));

// APPROVE — atomic: only PENDING can transition; second racer gets 409.
// Backend amount verification: when a received_payments SMS record exists
// for this TrxID, its amount must equal the claimed package price, otherwise
// approval is refused (pass { force: true } as admin to override manually).
app.post('/api/admin/payments/:id/approve', adminRequired, ah(async (req, res) => {
  try {
    const existing = await store.findPaymentById(Number(req.params.id));
    if (existing && existing.status === 'PENDING') {
      const recv = await store.findReceivedByTrx(existing.transactionIdNorm || existing.transactionId);
      if (recv && recv.amount !== undefined && recv.amount !== null
          && Math.abs(Number(recv.amount) - Number(existing.amount)) >= 0.005
          && !(req.body && req.body.force === true)) {
        return safeError(res, 409,
          `Amount mismatch: TrxID paid Tk ${recv.amount} but the package costs Tk ${existing.amount}.`,
          { code: 'AMOUNT_MISMATCH', receivedAmount: recv.amount, expectedAmount: existing.amount });
      }
    }
    const { payment, subscription, user } = await store.approvePaymentAtomic(Number(req.params.id), req.user.id);
    res.json({ success: true, payment, subscription, user });
  } catch (e) {
    if (e && e.code === 'ALREADY_REVIEWED') {
      return safeError(res, 409, 'Payment has already been reviewed.', { status: e.status });
    }
    if (e && e.code === 'NOT_FOUND') return safeError(res, 404, 'Payment not found.');
    if (e && e.code === 'USER_NOT_FOUND') return safeError(res, 404, 'User not found.');
    if (e && e.code === 'PACKAGE_GONE') return safeError(res, 400, 'Package no longer exists.');
    if (e && e.code === 'AMOUNT_MISMATCH') {
      return safeError(res, 409, e.message, { code: 'AMOUNT_MISMATCH' });
    }
    throw e;
  }
}));

app.post('/api/admin/payments/:id/reject', adminRequired, ah(async (req, res) => {
  try {
    const payment = await store.rejectPaymentAtomic(Number(req.params.id), req.user.id, req.body.reason);
    res.json({ success: true, payment });
  } catch (e) {
    if (e && e.code === 'ALREADY_REVIEWED') {
      return safeError(res, 409, 'Payment has already been reviewed.', { status: e.status });
    }
    if (e && e.code === 'NOT_FOUND') return safeError(res, 404, 'Payment not found.');
    throw e;
  }
}));

// ---------------- admin: subscriptions / notifications / versions ----------------
app.get('/api/admin/subscriptions', adminRequired, ah(async (req, res) => {
  const paged = await store.listAllSubscriptions(req.query);
  res.json({ success: true, subscriptions: paged.subscriptions, total: paged.total, page: paged.page, limit: paged.limit, hasMore: paged.hasMore });
}));

app.get('/api/admin/notifications', adminRequired, ah(async (req, res) => {
  // Independent reads, concurrently.
  const [paged, unread] = await Promise.all([
    store.listNotifications({ limit: 100 }),
    store.countUnreadNotifications(),
  ]);
  res.json({ success: true, notifications: paged.notifications, unread, total: paged.total, hasMore: paged.hasMore });
}));
app.post('/api/admin/notifications/read-all', adminRequired, ah(async (req, res) => {
  await store.markAllNotificationsRead();
  res.json({ success: true });
}));

// Admin App registers its FCM token here; backend fans out on new payments.
app.post('/api/admin/fcm-tokens', adminRequired, ah(async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token) return safeError(res, 400, 'token is required.');
  await store.addFcmToken({ token: String(token), platform: String(platform || 'android'), adminId: req.user.id });
  res.json({ success: true });
}));

app.get('/api/admin/versions', adminRequired, ah(async (req, res) => {
  res.json({ success: true, versions: await store.listVersions() });
}));
app.put('/api/admin/versions/:platform', adminRequired, ah(async (req, res) => {
  const patch = {};
  const semver = /^\d+\.\d+\.\d+$/;
  for (const k of ['latestVersion', 'minimumSupportedVersion']) {
    if (req.body[k] !== undefined) {
      const value = String(req.body[k]).trim();
      if (!semver.test(value)) return safeError(res, 400, `${k} must use semantic version format x.y.z.`);
      patch[k] = value;
    }
  }
  if (req.body.latestVersionCode !== undefined) {
    const code = Number(req.body.latestVersionCode);
    if (!Number.isInteger(code) || code < 1) return safeError(res, 400, 'latestVersionCode must be a positive integer.');
    patch.latestVersionCode = code;
  }
  if (req.body.updateUrl !== undefined) {
    const value = String(req.body.updateUrl).trim();
    if (value.length > 500) return safeError(res, 400, 'updateUrl is too long.');
    if (value && !/^https:\/\//i.test(value)) return safeError(res, 400, 'updateUrl must use HTTPS.');
    patch.updateUrl = value;
  }
  if (req.body.message !== undefined) {
    const value = String(req.body.message).trim();
    if (value.length > 1000) return safeError(res, 400, 'message is too long.');
    patch.message = value;
  }
  if (req.body.updateRequired !== undefined) patch.updateRequired = !!req.body.updateRequired;
  const v = await store.upsertVersion(String(req.params.platform || 'android'), patch);
  res.json({ success: true, version: v });
}));

const path = require('path');
const fs = require('fs');

// ---------------- app updates (Cloudinary APK storage + MongoDB metadata) ----------------

app.get('/api/app-update/latest', ah(async (req, res) => {
  await ensureMongo();
  const latest = await store.findLatestPublishedRelease();
  if (!latest) {
    return res.json({ success: true, updateAvailable: false });
  }
  res.json({
    success: true,
    updateAvailable: true,
    versionName: latest.versionName,
    versionCode: latest.versionCode,
    downloadUrl: latest.apkUrl || `/api/app-update/download/${latest.versionCode}`,
    releaseNotes: latest.releaseNotes || '',
    updateRequired: !!latest.updateRequired,
    apkFileName: latest.apkFileName,
  });
}));

app.get('/api/app-update/download/:versionCode', ah(async (req, res) => {
  await ensureMongo();
  const versionCode = Number(req.params.versionCode);
  if (!Number.isInteger(versionCode) || versionCode < 1) {
    return safeError(res, 400, 'Invalid version code.');
  }
  const release = await store.findPublishedRelease(versionCode);
  if (!release) return safeError(res, 404, 'Release not found.');
  if (release.apkUrl) {
    return res.redirect(302, release.apkUrl);
  }
  // Backward compatibility for legacy records stored on a local filesystem.
  if (!release.apkPath) return safeError(res, 404, 'APK file not found.');
  const filePath = path.resolve(release.apkPath);
  if (!fs.existsSync(filePath)) return safeError(res, 404, 'APK file not found.');
  res.setHeader('Content-Type', 'application/vnd.android.package-archive');
  res.setHeader('Content-Disposition', `attachment; filename="${release.apkFileName}"`);
  fs.createReadStream(filePath).pipe(res);
}));

app.post('/api/app-update/upload', adminRequired, ah(async (req, res) => {
  await ensureMongo();
  apkUpload(req, res, async (err) => {
    if (err) return safeError(res, 400, 'Upload failed: ' + err.message);
    const { versionName, versionCode, releaseNotes, updateRequired } = req.body || {};
    // Validate APK file
    if (!req.file) return safeError(res, 400, 'APK file is required.');
    const fileName = req.file.originalname || '';
    const mimeType = req.file.mimetype || '';
    const extOk = fileName.toLowerCase().endsWith('.apk');
    const mimeOk = mimeType === 'application/vnd.android.package-archive' || mimeType === 'application/octet-stream';
    if (!extOk && !mimeOk) {
      return safeError(res, 400, 'Only .apk files are accepted.');
    }
    // Validate version fields
    const vName = String(versionName || '').trim();
    if (!vName) {
      return safeError(res, 400, 'Version Name is required.');
    }
    const vCode = Number(versionCode);
    if (!Number.isInteger(vCode) || vCode < 1) {
      return safeError(res, 400, 'Version Code must be a positive integer.');
    }
    // Ensure version code is greater than the latest published
    const current = await store.findLatestPublishedRelease();
    if (current && vCode <= current.versionCode) {
      return safeError(res, 409, `Version Code must be greater than the current published code (${current.versionCode}).`);
    }
    // Prevent duplicate version code
    const existing = await store.findPublishedRelease(vCode);
    if (existing) {
      return safeError(res, 409, 'A release with this Version Code already exists.');
    }
    // Upload APK to Cloudinary as raw resource (never stored on local filesystem)
    const safeName = `Nesa ${vName}.apk`;
    const publicId = `otp-app/apk/V${vCode}/${vName}`;
    const uploadResult = await cloudinary.uploader.upload(req.file.buffer, {
      resource_type: 'raw',
      public_id: publicId,
      overwrite: true,
      use_filename: false,
      folder: 'otp-app/apk',
    });
    const publishedAt = store.nowIso();
    const release = await store.createRelease({
      versionName: vName,
      versionCode: vCode,
      apkFileName: safeName,
      apkUrl: uploadResult.secure_url,
      apkPath: uploadResult.public_id,
      releaseNotes: String(releaseNotes || ''),
      updateRequired: updateRequired === 'true' || updateRequired === true,
      isPublished: true,
      publishedAt,
    });
    res.json({
      success: true,
      message: 'Update published successfully.',
      release: {
        versionName: release.versionName,
        versionCode: release.versionCode,
        apkFileName: release.apkFileName,
        apkUrl: release.apkUrl,
        releaseNotes: release.releaseNotes,
        updateRequired: release.updateRequired,
        isPublished: release.isPublished,
        publishedAt: release.publishedAt,
      },
    });
  });
}));

app.get('/api/app-update/history', adminRequired, ah(async (req, res) => {
  await ensureMongo();
  const list = await store.listReleases();
  res.json({ success: true, releases: list });
}));

app.patch('/api/app-update/:versionCode', adminRequired, ah(async (req, res) => {
  await ensureMongo();
  const versionCode = Number(req.params.versionCode);
  if (!Number.isInteger(versionCode) || versionCode < 1) return safeError(res, 400, 'Invalid version code.');
  const patch = {};
  if (req.body.releaseNotes !== undefined) patch.releaseNotes = String(req.body.releaseNotes);
  if (req.body.updateRequired !== undefined) patch.updateRequired = !!req.body.updateRequired;
  if (req.body.isPublished !== undefined) patch.isPublished = !!req.body.isPublished;
  const updated = await store.updateRelease(versionCode, patch);
  if (!updated) return safeError(res, 404, 'Release not found.');
  res.json({ success: true, release: updated });
}));

app.delete('/api/app-update/:versionCode', adminRequired, ah(async (req, res) => {
  await ensureMongo();
  const versionCode = Number(req.params.versionCode);
  if (!Number.isInteger(versionCode) || versionCode < 1) return safeError(res, 400, 'Invalid version code.');
  const removed = await store.deleteRelease(versionCode);
  if (!removed) return safeError(res, 404, 'Release not found.');
  res.json({ success: true, removed });
}));

// ---------------- received bKash SMS payments (Recive payment app) ----------------
/**
 * Auth for the payment-receiver phone: EITHER a valid admin JWT
 * OR the shared RECV_API_KEY (header x-api-key). The phone never sees
 * MongoDB credentials — it only calls this API. Server validates everything.
 */
function recvAuth(req, res, next) {
  const key = String(process.env.RECV_API_KEY || '').trim();
  const sent = String(req.headers['x-api-key'] || '').trim();
  if (key && sent && sent === key) return next();
  return authRequired(req, res, () => {
    if (req.user && req.user.role === 'admin') return next();
    // Allow the receiver phone to use a normal user token too? No — least
    // privilege: API key or admin. Anything else is rejected.
    return safeError(res, 403, 'Receiver authentication required (x-api-key or admin login).');
  });
}

// POST /api/received-payments — called automatically by the Recive payment app.
app.post('/api/received-payments', recvAuth, ah(async (req, res) => {
  const b = req.body || {};
  const v = store.validateReceivedPayload(b);
  if (v.errs.length) return safeError(res, 400, v.errs[0], { errors: v.errs });
  const fee = b.fee !== undefined && b.fee !== null && String(b.fee).trim() !== '' ? Number(b.fee) : 0;
  const balance = b.balance !== undefined && b.balance !== null && String(b.balance).trim() !== '' ? Number(b.balance) : null;
  if (!Number.isFinite(fee) || fee < 0) return safeError(res, 400, 'fee must be a non-negative number.');
  if (balance !== null && (!Number.isFinite(balance) || balance < 0)) return safeError(res, 400, 'balance must be a non-negative number.');
  let txnDate = b.transactionDate ? String(b.transactionDate).trim() : null;
  if (txnDate && /^\d{2}\/\d{2}\/\d{4}$/.test(txnDate)) {
    const [dd, mm, yyyy] = txnDate.split('/');
    txnDate = `${yyyy}-${mm}-${dd}`;
  }
  const { doc, duplicate } = await store.createReceivedPayment({
    amount: v.amount,
    sender: v.sender || String(b.sender || '').trim(),
    fee,
    balance,
    trxId: v.trxId,
    transactionDate: txnDate,
    transactionTime: b.transactionTime ? String(b.transactionTime).trim().slice(0, 8) : null,
    originalMessage: String(b.originalMessage || '').slice(0, 2000),
    receivedAt: b.receivedAt ? String(b.receivedAt).slice(0, 40) : store.nowIso(),
    deviceInfo: String(b.deviceInfo || req.headers['user-agent'] || '').slice(0, 500),
    source: String(b.source || 'bkash_sms').slice(0, 50),
  });
  console.log(`[PAYMENT AUTO VERIFY] SMS stored: trx=${doc.trxIdNorm} amount=${doc.amount} sender=${doc.sender} duplicate=${duplicate}`);
  if (duplicate) {
    return res.json({ success: true, duplicate: true, message: 'Transaction already exists', payment: doc });
  }
  // Late-SMS path: the customer may have submitted this TrxID before the SMS
  // arrived. Try to auto-approve any waiting PENDING payments claiming it.
  let autoMatched = 0;
  try {
    const waiting = await store.findPendingPaymentsByTxNorm(doc.trxIdNorm);
    for (const w of waiting) {
      const auto = await store.tryAutoApprove(w);
      if (auto.auto) {
        autoMatched += 1;
        await pushToAdmins(`Auto-verified payment #${auto.payment.id} / TxID ${auto.payment.transactionId}`);
      }
    }
  } catch (e) {
    console.warn('[api] late-SMS auto-verify skipped:', e && e.message);
  }
  res.status(201).json({ success: true, duplicate: false, payment: doc, autoMatched });
}));

// GET /api/received-payments — admin list (search/filter/pagination).
app.get('/api/received-payments', adminRequired, ah(async (req, res) => {
  const paged = await store.listReceivedPayments({
    status: req.query.status, search: req.query.search,
    date: req.query.date, sender: req.query.sender,
    page: req.query.page, limit: req.query.limit,
  });
  res.json({ success: true, payments: paged.payments, total: paged.total, page: paged.page, limit: paged.limit, hasMore: paged.hasMore });
}));

// GET /api/received-payments/:trxId — lookup one TrxID (admin).
app.get('/api/received-payments/:trxId', adminRequired, ah(async (req, res) => {
  const doc = await store.findReceivedByTrx(req.params.trxId);
  if (!doc) return safeError(res, 404, 'Transaction not found.');
  res.json({ success: true, payment: doc });
}));

// POST /api/received-payments/verify — match a customer-submitted TrxID.
app.post('/api/received-payments/verify', adminRequired, ah(async (req, res) => {
  const { trxId, transactionId, amount, expectedAmount } = req.body || {};
  const tid = trxId || transactionId;
  if (!tid) return safeError(res, 400, 'trxId is required.');
  const exp = amount !== undefined ? amount : expectedAmount;
  const result = await store.verifyReceivedPayment(tid, exp, req.user.id);
  if (!result.found) return res.status(404).json({ success: false, error: 'No received payment with this TrxID.', found: false });
  if (!result.amountOk) {
    return res.json({ success: true, found: true, amountOk: false, message: 'Amount mismatch.', payment: result.payment });
  }
  res.json({ success: true, found: true, amountOk: true, payment: result.payment });
}));

// PATCH /api/received-payments/:trxId/status — admin status transitions.
app.patch('/api/received-payments/:trxId/status', adminRequired, ah(async (req, res) => {
  try {
    const doc = await store.setReceivedStatus(req.params.trxId, req.body.status, req.user.id, req.body.matchedPaymentId);
    if (!doc) return safeError(res, 404, 'Transaction not found.');
    res.json({ success: true, payment: doc });
  } catch (e) {
    if (e && e.code === 'BAD_STATUS') return safeError(res, 400, e.message);
    throw e;
  }
}));

// ---------------- helpers ----------------
/**
 * Admin credentials: .env is the source of truth.
 * The MongoDB admin record auto-syncs on login, so changing .env takes
 * effect immediately without re-running `npm run seed`.
 */
async function syncAdminFromEnv() {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Administrator';
  if (!email || !password) return false;
  let admin = await store.findUserByLogin(email);
  if (!admin || admin.role !== 'admin') {
    const { getModels } = require('./models');
    const models = await getModels();
    const anyAdmin = await models.OtpUser.findOne({ role: 'admin' }).lean();
    if (anyAdmin && (!admin || admin.id !== anyAdmin.id)) admin = store.serialize(anyAdmin);
  }
  if (!admin) {
    await store.createUser({
      name,
      email,
      phone: null,
      passwordHash: hashPassword(password),
      role: 'admin',
      status: 'active',
      accessEnabled: true,
      currentPackageId: null,
      currentPackageName: null,
      packageStartDate: null,
      packageExpireDate: null,
      createdAt: store.nowIso(),
    });
    return true;
  }
  const patch = {};
  if ((admin.email || '').toLowerCase() !== email) patch.email = email;
  if (admin.name !== name) patch.name = name;
  if (admin.role !== 'admin') patch.role = 'admin';
  if (admin.status !== 'active') patch.status = 'active';
  if (admin.accessEnabled !== true) patch.accessEnabled = true;
  if (!verifyPassword(password, admin.passwordHash)) {
    patch.passwordHash = hashPassword(password);
  }
  if (Object.keys(patch).length) await store.updateUserById(admin.id, patch);
  return Object.keys(patch).length > 0;
}

/** Best-effort push fan-out. Real FCM needs FCM_SERVER_KEY; otherwise logged + pollable. */
async function pushToAdmins(message) {
  const n = await store.countFcmTokens().catch(() => 0);
  if (!n) {
    console.log('[push] no FCM tokens registered; admin apps will see the notification on next poll:', message);
    return;
  }
  if (!process.env.FCM_SERVER_KEY) {
    console.log('[push] FCM_SERVER_KEY not set; stored notification only:', message);
    return;
  }
  // NOTE: kept as https call site — configure key to enable real background push.
  console.log('[push] would fan out to', n, 'admin device(s):', message);
}

module.exports = app;
