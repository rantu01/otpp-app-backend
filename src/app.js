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

/** Device IDs: case-insensitive, punctuation-insensitive. */
const normalizeDeviceId = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------- public: health + version check ----------------
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString(), db: isConnected() ? 'mongo' : 'disconnected', mongoDb: getDbName() });
});

// GET /api/versions/check?platform=android&version=1.0.0
app.get('/api/versions/check', ah(async (req, res) => {
  await ensureMongo();
  const platform = String(req.query.platform || 'android').toLowerCase();
  const installed = String(req.query.version || '0');
  const v = (await store.findVersion(platform)) || (await store.findFirstVersion()) || null;
  if (!v) return res.json({ success: true, forceUpdate: false, installed });
  const belowMin = store.cmpVersions(installed, v.minimumSupportedVersion) < 0;
  const behind = store.cmpVersions(installed, v.latestVersion) < 0;
  const forceUpdate = belowMin || (behind && !!v.updateRequired);
  res.json({
    success: true,
    installed,
    latestVersion: v.latestVersion,
    minimumSupportedVersion: v.minimumSupportedVersion,
    updateRequired: !!v.updateRequired,
    updateUrl: v.updateUrl || '',
    message: v.message || '',
    forceUpdate,
    blocked: belowMin,
  });
}));

// ---------------- auth ----------------
app.post('/api/auth/register', ah(async (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!password || String(password).length < 4) return safeError(res, 400, 'Password must be at least 4 characters.');
  const login = String(email || phone || '').trim().toLowerCase();
  if (!login) return safeError(res, 400, 'Email or phone is required.');
  if (await store.loginExists(login)) {
    return safeError(res, 409, 'Account already exists. Please login.');
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
      createdAt: store.nowIso(),
    });
  } catch (e) {
    // Lost a registration race — same outcome as the pre-check above.
    if (e && e.code === 'DUPLICATE_LOGIN') {
      return safeError(res, 409, 'Account already exists. Please login.');
    }
    throw e;
  }
  res.status(201).json({ success: true, token: signToken(user), user: publicUser(user), access: evaluateAccess(null, user) });
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
    if (user.deviceId && reqDevice && normalizeDeviceId(user.deviceId) !== reqDevice) {
      const denied = { allowed: false, reason: 'DEVICE_MISMATCH', message: 'This account is activated on a different device. Contact admin.' };
      return safeError(res, 403, denied.message, { code: denied.reason, access: denied });
    }
    if (!user.deviceId && reqDevice) {
      const updated = await store.updateUserById(user.id, { deviceId: reqDevice, deviceIdNorm: store.deviceKey(reqDevice) });
      return res.json({ success: true, token: signToken(updated), user: publicUser(updated), access: evaluateAccess(null, updated) });
    }
  }
  res.json({ success: true, token: signToken(user), user: publicUser(user), access });
}));

app.get('/api/auth/me', notBlockedRequired, (req, res) => {
  // req.user was loaded fresh from MongoDB by the auth middleware in this
  // same request — no second fetch needed.
  if (!req.user) return safeError(res, 401, 'Account not found.', { code: 'NO_ACCOUNT' });
  res.json({ success: true, user: publicUser(req.user), access: evaluateAccess(null, req.user) });
});

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
  res.json({ success: true, token: signToken(user), user: publicUser(user), access });
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
    return res.json({ success: true, registered: true, token: signToken(user), user: publicUser(user), access });
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
        return res.json({ success: true, registered: true, token: signToken(winner), user: publicUser(winner), access });
      }
    }
    throw e;
  }
  res.status(201).json({ success: true, registered: false, token: signToken(created), user: publicUser(created), access: evaluateAccess(null, created) });
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
  // Independent writes, concurrently.
  await Promise.all([
    idemKey ? store.saveIdemKey(idemKey, payment.id) : Promise.resolve(),
    // Admin notification (Admin App polls this; push fan-out below).
    store.createNotification({
      type: 'NEW_PAYMENT',
      title: 'New payment received for verification',
      message: `${req.user.name} paid ${pkg.price} for ${pkg.name} via ${method.name} (TxID ${txid})`,
      paymentRequestId: payment.id,
    }),
  ]);
  await pushToAdmins(`New payment: ${pkg.name} / TxID ${txid}`);
  res.status(201).json({ success: true, payment });
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
app.patch('/api/admin/users/:id/access', adminRequired, ah(async (req, res) => {
  const user = await store.findUserById(Number(req.params.id));
  if (!user || user.role === 'admin') return safeError(res, 404, 'User not found.');
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
    if (r === 'free' && !user.currentPackageName) patch.currentPackageName = 'Free';
  }
  const updated = await store.updateUserById(user.id, patch);
  res.json({ success: true, user: publicUser(updated), access: evaluateAccess(null, updated) });
}));

// Re-bind or clear a user's device (device change / reinstall support).
app.patch('/api/admin/users/:id/device', adminRequired, ah(async (req, res) => {
  const user = await store.findUserById(Number(req.params.id));
  if (!user || user.role === 'admin') return safeError(res, 404, 'User not found.');
  const raw = req.body.deviceId;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    const updated = await store.updateUserById(user.id, { deviceId: null, deviceIdNorm: null });
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
app.post('/api/admin/payments/:id/approve', adminRequired, ah(async (req, res) => {
  try {
    const { payment, subscription, user } = await store.approvePaymentAtomic(Number(req.params.id), req.user.id);
    res.json({ success: true, payment, subscription, user });
  } catch (e) {
    if (e && e.code === 'ALREADY_REVIEWED') {
      return safeError(res, 409, 'Payment has already been reviewed.', { status: e.status });
    }
    if (e && e.code === 'NOT_FOUND') return safeError(res, 404, 'Payment not found.');
    if (e && e.code === 'USER_NOT_FOUND') return safeError(res, 404, 'User not found.');
    if (e && e.code === 'PACKAGE_GONE') return safeError(res, 400, 'Package no longer exists.');
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
  for (const k of ['latestVersion', 'minimumSupportedVersion', 'updateUrl', 'message']) {
    if (req.body[k] !== undefined) patch[k] = String(req.body[k]);
  }
  if (req.body.updateRequired !== undefined) patch.updateRequired = !!req.body.updateRequired;
  const v = await store.upsertVersion(String(req.params.platform || 'android'), patch);
  res.json({ success: true, version: v });
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
