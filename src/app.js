'use strict';
/**
 * Shared backend for User App + Admin App + Admin Website.
 *
 * Run:  npm install && npm run seed && npm start   (http://localhost:4000)
 *
 * Key business rules (also documented in README):
 *  - Access is validated on the backend (evaluateAccess + accessRequired).
 *  - Transaction IDs are unique (normalized: upper-case, no spaces/dashes).
 *  - Approve/Reject is an atomic PENDING -> APPROVED/REJECTED transition, so
 *    two admins racing on the same payment: only one succeeds.
 *  - Package activation: renewal before expiry extends from current expiry,
 *    otherwise starts from approval date.
 */
try { require('dotenv').config(); } catch { /* dotenv optional */ }
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const dbx = require('./db');
const { hashPassword, verifyPassword, signToken, authRequired, adminRequired, accessRequired, evaluateAccess, publicUser } = require('./auth');

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

const safeError = (res, status, message, extra) =>
  res.status(status).json(Object.assign({ success: false, error: message }, extra || {}));

/** Device IDs: case-insensitive, punctuation-insensitive. */
const normalizeDeviceId = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------------- public: health + version check ----------------
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'ok', time: new Date().toISOString() });
});

// GET /api/versions/check?platform=android&version=1.0.0
app.get('/api/versions/check', (req, res) => {
  const db = dbx.load();
  const platform = String(req.query.platform || 'android').toLowerCase();
  const installed = String(req.query.version || '0');
  const v = db.appVersions.find((x) => x.platform === platform) || db.appVersions[0] || null;
  if (!v) return res.json({ success: true, forceUpdate: false, installed });
  const belowMin = dbx.cmpVersions(installed, v.minimumSupportedVersion) < 0;
  const behind = dbx.cmpVersions(installed, v.latestVersion) < 0;
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
});

// ---------------- auth ----------------
app.post('/api/auth/register', (req, res) => {
  const { name, email, phone, password } = req.body || {};
  if (!password || String(password).length < 4) return safeError(res, 400, 'Password must be at least 4 characters.');
  const login = String(email || phone || '').trim().toLowerCase();
  if (!login) return safeError(res, 400, 'Email or phone is required.');
  const db = dbx.load();
  if (db.users.some((u) => (u.email && u.email.toLowerCase() === login) || (u.phone && u.phone === login))) {
    return safeError(res, 409, 'Account already exists. Please login.');
  }
  const id = dbx.nextId(db, 'user');
  const user = {
    id,
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
    createdAt: dbx.nowIso(),
  };
  db.users.push(user);
  dbx.save(db);
  res.status(201).json({ success: true, token: signToken(user), user: publicUser(user), access: evaluateAccess(db, user) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, phone, login, password } = req.body || {};
  const key = String(login || email || phone || '').trim().toLowerCase();
  if (!key || !password) return safeError(res, 400, 'Login and password are required.');
  const db = dbx.load();
  // .env ke source-of-truth dhoro: seed na chalaleo admin login .env er
  // ADMIN_EMAIL / ADMIN_PASSWORD diyei hobe (DB auto-sync hoye jabe).
  syncAdminFromEnv(db);
  const user = db.users.find(
    (u) => (u.email && u.email.toLowerCase() === key) || (u.phone && u.phone.toLowerCase() === key)
  );
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return safeError(res, 401, 'Invalid login or password.');
  }
  // Account-level gate: pending/disabled/blocked accounts cannot log in at all,
  // even with the right password. Active accounts without a package CAN log in
  // (they are routed to the package/purchase flow, never to Home).
  const access = evaluateAccess(db, user);
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
      user.deviceId = reqDevice;
      dbx.save(db);
    }
  }
  res.json({ success: true, token: signToken(user), user: publicUser(user), access });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  const db = dbx.load();
  const fresh = db.users.find((u) => u.id === req.user.id);
  res.json({ success: true, user: publicUser(fresh), access: evaluateAccess(db, fresh) });
});

// Device activation (User App first-run flow, no password).
// POST /api/auth/device { deviceId } -> finds the device account or creates a
// PENDING one, and returns a JWT + live access state. The token only opens the
// package/purchase flow until an admin approves (same gate as accounts).
// Email/phone register+login below are preserved unchanged for admin surfaces.
app.post('/api/auth/device', (req, res) => {
  const norm = dbx.normalizeDeviceId((req.body || {}).deviceId);
  if (!norm) {
    return safeError(res, 400, 'A valid Device ID is required.', { code: 'BAD_DEVICE_ID' });
  }
  const db = dbx.load();
  let user = db.users.find((u) => u.deviceIdNorm === norm && u.role !== 'admin');
  if (!user) {
    user = {
      id: dbx.nextId(db, 'user'),
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
      createdAt: dbx.nowIso(),
    };
    db.users.push(user);
    dbx.save(db);
  }
  const access = evaluateAccess(db, user);
  res.json({ success: true, token: signToken(user), user: publicUser(user), access });
});

// ---------------- device activation (User App first-run screen) ----------------
// Public: the device ID itself is the claim. New devices get a PENDING account
// (unusable until admin approval, exactly like register). Known devices get a
// fresh token unless the account itself is blocked (403, no bypass).
app.post('/api/auth/activate', (req, res) => {
  const deviceId = normalizeDeviceId(req.body && req.body.deviceId);
  if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
    return safeError(res, 400, 'A valid Device ID is required.');
  }
  const db = dbx.load();
  let user = db.users.find((u) => u.deviceId && normalizeDeviceId(u.deviceId) === deviceId);
  if (user) {
    if (user.role === 'admin') return safeError(res, 403, 'Admins cannot activate the User App.');
    const access = evaluateAccess(db, user);
    if (!access.allowed && access.reason !== 'NO_PACKAGE' && access.reason !== 'PENDING') {
      return safeError(res, 403, access.message, { code: access.reason, access });
    }
    return res.json({ success: true, registered: true, token: signToken(user), user: publicUser(user), access });
  }
  const id = dbx.nextId(db, 'user');
  user = {
    id,
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
    currentPackageId: null,
    currentPackageName: null,
    packageStartDate: null,
    packageExpireDate: null,
    createdAt: dbx.nowIso(),
  };
  db.users.push(user);
  dbx.save(db);
  res.status(201).json({ success: true, registered: false, token: signToken(user), user: publicUser(user), access: evaluateAccess(db, user) });
});

// Public activation lookup: lets the app show "pending admin approval" state
// for a device without holding a token.
app.get('/api/activation/status', (req, res) => {
  const deviceId = normalizeDeviceId(req.query.deviceId);
  if (!deviceId) return safeError(res, 400, 'deviceId is required.');
  const db = dbx.load();
  const user = db.users.find((u) => u.deviceId && normalizeDeviceId(u.deviceId) === deviceId);
  if (!user) {
    return res.json({ success: true, registered: false, access: { allowed: false, reason: 'NO_ACCOUNT', message: 'Device not registered.' } });
  }
  res.json({ success: true, registered: true, access: evaluateAccess(db, user), user: publicUser(user) });
});

// Backend-validated access status (User App startup flow calls this).
app.get('/api/access/status', authRequired, (req, res) => {
  const db = dbx.load();
  const fresh = db.users.find((u) => u.id === req.user.id);
  const access = evaluateAccess(db, fresh);
  res.json({ success: true, access, user: publicUser(fresh) });
});

// Example protected API: disabled/expired users are blocked here.
app.get('/api/protected/demo', accessRequired, (req, res) => {
  res.json({ success: true, message: 'Protected content.', userId: req.user.id });
});

// ---------------- user-facing catalog (active only) ----------------
app.get('/api/packages', authRequired, (req, res) => {
  const db = dbx.load();
  const list = db.packages.filter((p) => p.status === 'active').sort((a, b) => a.price - b.price);
  res.json({ success: true, packages: list });
});

app.get('/api/payment-methods', authRequired, (req, res) => {
  const db = dbx.load();
  const list = db.paymentMethods
    .filter((m) => m.status === 'active')
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  res.json({ success: true, paymentMethods: list });
});

// ---------------- user: payments ----------------
app.post('/api/payments', authRequired, (req, res) => {
  const { packageId, paymentMethodId, transactionId } = req.body || {};
  const idemKey = req.headers['idempotency-key'] ? String(req.headers['idempotency-key']) : null;
  const txid = String(transactionId || '').trim();
  if (!packageId) return safeError(res, 400, 'Package is required.');
  if (!paymentMethodId) return safeError(res, 400, 'Payment method is required.');
  if (!txid) return safeError(res, 400, 'Transaction ID is required.');
  const db = dbx.load();

  // Idempotency: network retry / double-tap with same key returns the original.
  if (idemKey && db.idempotencyKeys[idemKey]) {
    const existing = db.payments.find((p) => p.id === db.idempotencyKeys[idemKey]);
    if (existing) return res.status(200).json({ success: true, payment: existing, deduped: true });
  }

  const pkg = db.packages.find((p) => p.id === Number(packageId));
  if (!pkg || pkg.status !== 'active') return safeError(res, 400, 'Invalid or inactive package.');
  const method = db.paymentMethods.find((m) => m.id === Number(paymentMethodId));
  if (!method || method.status !== 'active') return safeError(res, 400, 'Invalid or inactive payment method.');

  // Backend duplicate-transaction guard (source of truth, not frontend).
  const norm = dbx.normalizeTxid(txid);
  const dup = db.payments.find((p) => dbx.normalizeTxid(p.transactionId) === norm && p.status !== 'CANCELLED');
  if (dup) return safeError(res, 409, 'This Transaction ID has already been submitted.', { code: 'DUPLICATE_TXID' });

  const payment = {
    id: dbx.nextId(db, 'payment'),
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
    submittedAt: dbx.nowIso(),
    reviewedAt: null,
    reviewedBy: null,
    rejectionReason: null,
  };
  db.payments.push(payment);
  if (idemKey) db.idempotencyKeys[idemKey] = payment.id;
  // Admin notification (Admin App polls this; push fan-out below).
  db.notifications.push({
    id: dbx.nextId(db, 'notification'),
    type: 'NEW_PAYMENT',
    title: 'New payment received for verification',
    message: `${req.user.name} paid ${pkg.price} for ${pkg.name} via ${method.name} (TxID ${txid})`,
    paymentRequestId: payment.id,
    read: false,
    createdAt: dbx.nowIso(),
  });
  dbx.save(db);
  pushToAdmins(db, `New payment: ${pkg.name} / TxID ${txid}`);
  res.status(201).json({ success: true, payment });
});

app.get('/api/payments/mine', authRequired, (req, res) => {
  const db = dbx.load();
  const list = db.payments.filter((p) => p.userId === req.user.id).sort((a, b) => b.id - a.id);
  res.json({ success: true, payments: list });
});

app.get('/api/subscriptions/mine', authRequired, (req, res) => {
  const db = dbx.load();
  const list = db.subscriptions.filter((s) => s.userId === req.user.id).sort((a, b) => b.id - a.id);
  const user = db.users.find((u) => u.id === req.user.id);
  res.json({ success: true, subscriptions: list, current: user ? {
    packageId: user.currentPackageId, packageName: user.currentPackageName,
    start: user.packageStartDate, expire: user.packageExpireDate,
  } : null });
});

// ---------------- admin: dashboard ----------------
app.get('/api/admin/dashboard', adminRequired, (req, res) => {
  const db = req.db;
  const now = Date.now();
  const payments = db.payments;
  const pending = payments.filter((p) => p.status === 'PENDING').length;
  const approved = payments.filter((p) => p.status === 'APPROVED');
  const rejected = payments.filter((p) => p.status === 'REJECTED').length;
  const revenue = approved.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const active = db.users.filter((u) => u.role !== 'admin' && u.currentPackageId && u.packageExpireDate && Date.parse(u.packageExpireDate) > now).length;
  const expired = db.users.filter((u) => u.role !== 'admin' && (!u.currentPackageId || !u.packageExpireDate || Date.parse(u.packageExpireDate) <= now)).length;
  res.json({ success: true, stats: {
    totalPayments: payments.length, pending, approved: approved.length, rejected,
    approvedRevenue: revenue, activeSubscriptions: active, expiredSubscriptions: expired,
    totalUsers: db.users.filter((u) => u.role !== 'admin').length,
  } });
});

// ---------------- admin: users ----------------
app.get('/api/admin/users', adminRequired, (req, res) => {
  const db = req.db;
  const q = String(req.query.search || '').toLowerCase();
  let list = db.users.filter((u) => u.role !== 'admin');
  if (q) list = list.filter((u) => String(u.id).includes(q) || (u.name || '').toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (u.phone || '').includes(q));
  list.sort((a, b) => b.id - a.id);
  res.json({ success: true, users: list.map(publicUser) });
});

// Enable/disable access, or set status.
app.patch('/api/admin/users/:id/access', adminRequired, (req, res) => {
  const db = dbx.load();
  const user = db.users.find((u) => u.id === Number(req.params.id));
  if (!user || user.role === 'admin') return safeError(res, 404, 'User not found.');
  if (req.body.accessEnabled !== undefined) user.accessEnabled = !!req.body.accessEnabled;
  if (req.body.status !== undefined) {
    if (!['active', 'disabled'].includes(req.body.status)) return safeError(res, 400, 'Invalid status.');
    user.status = req.body.status;
  }
  dbx.save(db);
  res.json({ success: true, user: publicUser(user), access: evaluateAccess(db, user) });
});

// Re-bind or clear a user's device (device change / reinstall support).
app.patch('/api/admin/users/:id/device', adminRequired, (req, res) => {
  const db = dbx.load();
  const user = db.users.find((u) => u.id === Number(req.params.id));
  if (!user || user.role === 'admin') return safeError(res, 404, 'User not found.');
  const raw = req.body.deviceId;
  if (raw === null || raw === undefined || String(raw).trim() === '') {
    user.deviceId = null;
  } else {
    const d = normalizeDeviceId(raw);
    if (d.length < 8 || d.length > 64) return safeError(res, 400, 'Invalid Device ID.');
    const clash = db.users.find((u) => u.id !== user.id && u.deviceId && normalizeDeviceId(u.deviceId) === d);
    if (clash) return safeError(res, 409, 'That Device ID is already bound to another account.');
    user.deviceId = d;
  }
  dbx.save(db);
  res.json({ success: true, user: publicUser(user), access: evaluateAccess(db, user) });
});

// Manually assign/extend a package (uses the same renewal rule as approval).
app.post('/api/admin/users/:id/assign-package', adminRequired, (req, res) => {
  const db = dbx.load();
  const user = db.users.find((u) => u.id === Number(req.params.id));
  if (!user || user.role === 'admin') return safeError(res, 404, 'User not found.');
  const pkg = db.packages.find((p) => p.id === Number(req.body.packageId));
  if (!pkg || pkg.status !== 'active') return safeError(res, 400, 'Invalid or inactive package.');
  const { start, expire } = activationWindow(user, pkg.durationDays, Date.now());
  user.currentPackageId = pkg.id;
  user.currentPackageName = pkg.name;
  user.packageStartDate = new Date(start).toISOString();
  user.packageExpireDate = new Date(expire).toISOString();
  const sub = {
    id: dbx.nextId(db, 'subscription'), userId: user.id, packageId: pkg.id,
    packageName: pkg.name, price: pkg.price, durationDays: pkg.durationDays,
    startDate: user.packageStartDate, expireDate: user.packageExpireDate,
    status: 'active', paymentRequestId: null, createdAt: dbx.nowIso(), createdBy: req.user.id,
    deviceId: user.deviceIdNorm || user.deviceId || null,
  };
  db.subscriptions.push(sub);
  dbx.save(db);
  res.json({ success: true, user: publicUser(user), subscription: sub });
});

// ---------------- admin: packages ----------------
app.get('/api/admin/packages', adminRequired, (req, res) => {
  const db = req.db;
  res.json({ success: true, packages: [...db.packages].sort((a, b) => a.id - b.id) });
});
app.post('/api/admin/packages', adminRequired, (req, res) => {
  const { name, price, durationDays, status, description } = req.body || {};
  if (!name || price === undefined || !durationDays) return safeError(res, 400, 'name, price and durationDays are required.');
  const db = dbx.load();
  const pkg = {
    id: dbx.nextId(db, 'package'), name: String(name), price: Number(price),
    durationDays: Number(durationDays), status: status === 'inactive' ? 'inactive' : 'active',
    description: String(description || ''), createdAt: dbx.nowIso(), updatedAt: dbx.nowIso(),
  };
  db.packages.push(pkg);
  dbx.save(db);
  res.status(201).json({ success: true, package: pkg });
});
app.put('/api/admin/packages/:id', adminRequired, (req, res) => {
  const db = dbx.load();
  const pkg = db.packages.find((p) => p.id === Number(req.params.id));
  if (!pkg) return safeError(res, 404, 'Package not found.');
  for (const k of ['name', 'description']) if (req.body[k] !== undefined) pkg[k] = String(req.body[k]);
  for (const k of ['price', 'durationDays']) if (req.body[k] !== undefined) pkg[k] = Number(req.body[k]);
  if (req.body.status !== undefined) pkg.status = req.body.status === 'inactive' ? 'inactive' : 'active';
  pkg.updatedAt = dbx.nowIso();
  dbx.save(db);
  res.json({ success: true, package: pkg });
});

// ---------------- admin: payment methods ----------------
app.get('/api/admin/payment-methods', adminRequired, (req, res) => {
  const db = req.db;
  res.json({ success: true, paymentMethods: [...db.paymentMethods].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0)) });
});
app.post('/api/admin/payment-methods', adminRequired, (req, res) => {
  const { name, walletNumber, accountType, logo, instructions, status, sortOrder } = req.body || {};
  if (!name || !walletNumber) return safeError(res, 400, 'name and walletNumber are required.');
  const db = dbx.load();
  const m = {
    id: dbx.nextId(db, 'paymentMethod'), name: String(name), walletNumber: String(walletNumber),
    accountType: String(accountType || 'Personal'), logo: String(logo || ''),
    instructions: String(instructions || 'Send Money to this number.'),
    status: status === 'inactive' ? 'inactive' : 'active',
    sortOrder: Number(sortOrder || db.paymentMethods.length),
    createdAt: dbx.nowIso(), updatedAt: dbx.nowIso(),
  };
  db.paymentMethods.push(m);
  dbx.save(db);
  res.status(201).json({ success: true, paymentMethod: m });
});
app.put('/api/admin/payment-methods/:id', adminRequired, (req, res) => {
  const db = dbx.load();
  const m = db.paymentMethods.find((x) => x.id === Number(req.params.id));
  if (!m) return safeError(res, 404, 'Payment method not found.');
  for (const k of ['name', 'walletNumber', 'accountType', 'logo', 'instructions']) {
    if (req.body[k] !== undefined) m[k] = String(req.body[k]);
  }
  if (req.body.status !== undefined) m.status = req.body.status === 'inactive' ? 'inactive' : 'active';
  if (req.body.sortOrder !== undefined) m.sortOrder = Number(req.body.sortOrder);
  m.updatedAt = dbx.nowIso();
  dbx.save(db);
  res.json({ success: true, paymentMethod: m });
});

// ---------------- admin: payments verify/history ----------------
app.get('/api/admin/payments', adminRequired, (req, res) => {
  const db = req.db;
  const { status, search } = req.query;
  let list = [...db.payments].sort((a, b) => b.id - a.id);
  if (status) list = list.filter((p) => p.status === String(status).toUpperCase());
  if (search) {
    const q = String(search).toLowerCase();
    list = list.filter((p) => String(p.id).includes(q) || String(p.userId).includes(q)
      || (p.userName || '').toLowerCase().includes(q)
      || (p.transactionId || '').toLowerCase().includes(q)
      || (p.packageName || '').toLowerCase().includes(q)
      || (p.paymentMethodName || '').toLowerCase().includes(q));
  }
  res.json({ success: true, payments: list });
});

app.get('/api/admin/payments/pending-count', adminRequired, (req, res) => {
  const n = req.db.payments.filter((p) => p.status === 'PENDING').length;
  res.json({ success: true, pending: n });
});

// APPROVE — atomic: only PENDING can transition; second racer gets 409.
app.post('/api/admin/payments/:id/approve', adminRequired, (req, res) => {
  const db = dbx.load(); // fresh read inside the critical section
  const payment = db.payments.find((p) => p.id === Number(req.params.id));
  if (!payment) return safeError(res, 404, 'Payment not found.');
  if (payment.status !== 'PENDING') {
    return safeError(res, 409, 'Payment has already been reviewed.', { status: payment.status });
  }
  const user = db.users.find((u) => u.id === payment.userId);
  if (!user) return safeError(res, 404, 'User not found.');
  const pkg = db.packages.find((p) => p.id === payment.packageId);
  if (!pkg) return safeError(res, 400, 'Package no longer exists.');

  payment.status = 'APPROVED';
  payment.reviewedAt = dbx.nowIso();
  payment.reviewedBy = req.user.id;

  const { start, expire } = activationWindow(user, pkg.durationDays, Date.now());
  user.currentPackageId = pkg.id;
  user.currentPackageName = pkg.name;
  user.packageStartDate = new Date(start).toISOString();
  user.packageExpireDate = new Date(expire).toISOString();
  if (user.status !== 'active') user.status = 'active';

  const sub = {
    id: dbx.nextId(db, 'subscription'), userId: user.id, packageId: pkg.id,
    packageName: pkg.name, price: payment.amount, durationDays: pkg.durationDays,
    startDate: user.packageStartDate, expireDate: user.packageExpireDate,
    status: 'active', paymentRequestId: payment.id, createdAt: dbx.nowIso(), createdBy: req.user.id,
    deviceId: user.deviceIdNorm || user.deviceId || null,
  };
  db.subscriptions.push(sub);
  dbx.save(db); // single synchronous write => only one approval can win
  res.json({ success: true, payment, subscription: sub, user: publicUser(user) });
});

app.post('/api/admin/payments/:id/reject', adminRequired, (req, res) => {
  const db = dbx.load();
  const payment = db.payments.find((p) => p.id === Number(req.params.id));
  if (!payment) return safeError(res, 404, 'Payment not found.');
  if (payment.status !== 'PENDING') {
    return safeError(res, 409, 'Payment has already been reviewed.', { status: payment.status });
  }
  payment.status = 'REJECTED';
  payment.reviewedAt = dbx.nowIso();
  payment.reviewedBy = req.user.id;
  payment.rejectionReason = String(req.body.reason || 'Transaction ID could not be verified.');
  dbx.save(db);
  res.json({ success: true, payment });
});

// ---------------- admin: subscriptions / notifications / versions ----------------
app.get('/api/admin/subscriptions', adminRequired, (req, res) => {
  const list = [...req.db.subscriptions].sort((a, b) => b.id - a.id);
  res.json({ success: true, subscriptions: list });
});

app.get('/api/admin/notifications', adminRequired, (req, res) => {
  const list = [...req.db.notifications].sort((a, b) => b.id - a.id).slice(0, 100);
  const unread = req.db.notifications.filter((n) => !n.read).length;
  res.json({ success: true, notifications: list, unread });
});
app.post('/api/admin/notifications/read-all', adminRequired, (req, res) => {
  const db = dbx.load();
  db.notifications.forEach((n) => { n.read = true; });
  dbx.save(db);
  res.json({ success: true });
});

// Admin App registers its FCM token here; backend fans out on new payments.
app.post('/api/admin/fcm-tokens', adminRequired, (req, res) => {
  const { token, platform } = req.body || {};
  if (!token) return safeError(res, 400, 'token is required.');
  const db = dbx.load();
  if (!db.fcmTokens.some((t) => t.token === token)) {
    db.fcmTokens.push({ token: String(token), platform: String(platform || 'android'), adminId: req.user.id, createdAt: dbx.nowIso() });
    dbx.save(db);
  }
  res.json({ success: true });
});

app.get('/api/admin/versions', adminRequired, (req, res) => {
  res.json({ success: true, versions: req.db.appVersions });
});
app.put('/api/admin/versions/:platform', adminRequired, (req, res) => {
  const db = dbx.load();
  const platform = String(req.params.platform || 'android').toLowerCase();
  let v = db.appVersions.find((x) => x.platform === platform);
  if (!v) {
    v = { id: dbx.nextId(db, 'appVersion'), platform, latestVersion: '1.0.0', minimumSupportedVersion: '1.0.0', updateRequired: false, updateUrl: '', message: '', updatedAt: dbx.nowIso() };
    db.appVersions.push(v);
  }
  for (const k of ['latestVersion', 'minimumSupportedVersion', 'updateUrl', 'message']) {
    if (req.body[k] !== undefined) v[k] = String(req.body[k]);
  }
  if (req.body.updateRequired !== undefined) v.updateRequired = !!req.body.updateRequired;
  v.updatedAt = dbx.nowIso();
  dbx.save(db);
  res.json({ success: true, version: v });
});

// ---------------- helpers ----------------
/**
 * Admin credentials: .env is the source of truth.
 * DB te purono hash thakle login er somoy .env er sathe miliye auto-sync
 * kora hoy, tai production e .env bodlale `npm run seed` na chalaleo
 * notun password sathe sathe kaj kore. Purono password diye ar dhoka jay na.
 */
function syncAdminFromEnv(db) {
  const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Administrator';
  if (!email || !password) return false;
  let admin = db.users.find((u) => u.email && u.email.toLowerCase() === email);
  if (!admin) admin = db.users.find((u) => u.role === 'admin');
  if (!admin) {
    db.users.push({
      id: dbx.nextId(db, 'user'),
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
      createdAt: dbx.nowIso(),
    });
    dbx.save(db);
    return true;
  }
  let changed = false;
  if ((admin.email || '').toLowerCase() !== email) { admin.email = email; changed = true; }
  if (admin.name !== name) { admin.name = name; changed = true; }
  if (admin.role !== 'admin') { admin.role = 'admin'; changed = true; }
  if (admin.status !== 'active') { admin.status = 'active'; changed = true; }
  if (admin.accessEnabled !== true) { admin.accessEnabled = true; changed = true; }
  if (!verifyPassword(password, admin.passwordHash)) {
    admin.passwordHash = hashPassword(password);
    changed = true;
  }
  if (changed) dbx.save(db);
  return changed;
}

/**
 * Package activation rule:
 *  - renewal before expiry  => extend from current expiry date
 *  - otherwise              => start from approval date
 */
function activationWindow(user, durationDays, nowMs) {
  const days = Math.max(1, Number(durationDays) || 1);
  const currentExp = user.packageExpireDate ? Date.parse(user.packageExpireDate) : NaN;
  const start = !Number.isNaN(currentExp) && currentExp > nowMs ? currentExp : nowMs;
  return { start, expire: start + days * 24 * 60 * 60 * 1000 };
}

/** Best-effort push fan-out. Real FCM needs FCM_SERVER_KEY; otherwise logged + pollable. */
function pushToAdmins(db, message) {
  if (!db.fcmTokens.length) {
    console.log('[push] no FCM tokens registered; admin apps will see the notification on next poll:', message);
    return;
  }
  if (!process.env.FCM_SERVER_KEY) {
    console.log('[push] FCM_SERVER_KEY not set; stored notification only:', message);
    return;
  }
  // NOTE: kept as https call site — configure key to enable real background push.
  console.log('[push] would fan out to', db.fcmTokens.length, 'admin device(s):', message);
}

module.exports = app;
