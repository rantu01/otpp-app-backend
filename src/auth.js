'use strict';
/**
 * Auth helpers: password hashing, JWT, and middleware.
 *
 * Roles: user | admin  (stored on user.role)
 * - authRequired: any logged-in account.
 * - adminRequired: role === 'admin'.
 * - accessRequired: user account active + accessEnabled + active subscription.
 *   Used by protected APIs so a disabled/expired user cannot continue even
 *   with a still-valid JWT (Scenario 3 & 4).
 */
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { load, publicUser } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-to-a-long-random-secret';
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '30d';

function hashPassword(pw) {
  return bcrypt.hashSync(String(pw), 10);
}
function verifyPassword(pw, hash) {
  try {
    return bcrypt.compareSync(String(pw), String(hash));
  } catch {
    return false;
  }
}
function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const db = load();
    const user = db.users.find((u) => u.id === Number(payload.sub));
    if (!user) return res.status(401).json({ success: false, error: 'Account not found' });
    req.auth = payload;
    req.user = user;
    req.db = db;
    next();
  } catch (e) {
    return res.status(401).json({ success: false, error: 'Session expired. Please login again.' });
  }
}

function adminRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, error: 'Admin access required' });
    }
    next();
  });
}

/** Backend source-of-truth access evaluation for one user record. */
function evaluateAccess(db, user) {
  const now = Date.now();
  if (!user) return { allowed: false, reason: 'NO_ACCOUNT', message: 'Account not found.' };
  if (user.status === 'pending') {
    return { allowed: false, reason: 'PENDING', message: 'Your account is pending admin approval.' };
  }
  if (user.status !== 'active') {
    return { allowed: false, reason: 'DISABLED', message: 'Your account has been disabled. Contact support.' };
  }
  if (user.accessEnabled === false) {
    return { allowed: false, reason: 'ACCESS_DENIED', message: 'Access has been disabled by admin.' };
  }
  const exp = user.packageExpireDate ? Date.parse(user.packageExpireDate) : NaN;
  if (!user.currentPackageId || Number.isNaN(exp) || exp <= now) {
    return { allowed: false, reason: 'NO_PACKAGE', message: 'No active package. Please choose a package.' };
  }
  return {
    allowed: true,
    reason: 'OK',
    message: 'Access granted.',
    packageId: user.currentPackageId,
    packageName: user.currentPackageName || null,
    packageExpireDate: user.packageExpireDate,
  };
}

/** Blocks disabled/expired users from protected APIs even with a valid JWT. */
function accessRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role === 'admin') return next(); // admins bypass subscription gate
    const result = evaluateAccess(req.db, req.user);
    if (!result.allowed) {
      return res.status(403).json({ success: false, error: result.message, code: result.reason, access: result });
    }
    req.access = result;
    next();
  });
}

module.exports = { hashPassword, verifyPassword, signToken, authRequired, adminRequired, accessRequired, evaluateAccess, publicUser };
