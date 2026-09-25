'use strict';
/**
 * Auth helpers: password hashing, JWT, and middleware.
 *
 * Roles: user | admin | free  (stored on user.role)
 * - authRequired: any logged-in account (user loaded fresh from MongoDB).
 * - adminRequired: role === 'admin'.
 * - accessRequired: active + accessEnabled + active subscription.
 * - notBlockedRequired: kill-switch for DISABLED / ACCESS_DENIED accounts.
 */
try { require('dotenv').config(); } catch { /* dotenv optional */ }
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const store = require('./store');

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
function signToken(user, sessionId) {
  const payload = { sub: user.id, role: user.role };
  // sid binds the JWT to one login session so simultaneous logins on two
  // devices cannot both stay live (see single-session check below).
  if (sessionId) payload.sid = String(sessionId);
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}
function publicUser(u) {
  return store.publicUser(u);
}

async function authRequired(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ success: false, error: 'Not authenticated' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = await store.findUserById(Number(payload.sub));
    if (!user) return res.status(401).json({ success: false, error: 'Account not found' });
    // Single-session enforcement: if this account logged in again from the
    // same device (session rotated) or was logged out, an older token no
    // longer matches the live session and must stop working. Legacy tokens
    // issued before sessions existed carry no sid and are grandfathered.
    if (user.activeSessionId && payload.sid && user.activeSessionId !== String(payload.sid)) {
      return res.status(401).json({
        success: false,
        error: 'This account is currently logged in on another device. Please log out from that device first, then log in here.',
        code: 'SESSION_IN_USE',
      });
    }
    req.auth = payload;
    req.user = user;
    next();
  } catch (e) {
    if (e && (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError')) {
      return res.status(401).json({ success: false, error: 'Session expired. Please login again.' });
    }
    return res.status(500).json({ success: false, error: 'Authentication failed. Please retry.' });
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
function evaluateAccess(dbOrNull, user) {
  void dbOrNull;
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
  if (user.role === 'free') {
    return {
      allowed: true,
      reason: 'FREE',
      message: 'Free access granted.',
      packageId: user.currentPackageId || null,
      packageName: user.currentPackageName || 'Free',
      packageExpireDate: user.packageExpireDate || null,
      free: true,
    };
  }
  const exp = user.packageExpireDate ? Date.parse(user.packageExpireDate) : NaN;
  const trialExp = user.freeTrialExpiresAt ? Date.parse(user.freeTrialExpiresAt) : NaN;
  if (Number.isFinite(trialExp) && trialExp > now && (!user.currentPackageId || Number.isNaN(exp) || exp <= now)) {
    return {
      allowed: true,
      reason: 'REFERRAL_FREE',
      message: 'Referral free access granted.',
      packageId: null,
      packageName: 'Referral free access',
      packageExpireDate: user.freeTrialExpiresAt,
      freeTrialExpiresAt: user.freeTrialExpiresAt,
      freeTrialDays: Number(user.freeTrialDays || 0),
      free: true,
    };
  }
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
    if (req.user.role === 'admin') return next();
    const result = evaluateAccess(null, req.user);
    if (!result.allowed) {
      return res.status(403).json({ success: false, error: result.message, code: result.reason, access: result });
    }
    req.access = result;
    next();
  });
}

/**
 * Server-side kill-switch for disabled accounts. Allows PENDING and
 * NO_PACKAGE through (purchase flow); blocks DISABLED / ACCESS_DENIED /
 * NO_ACCOUNT even with a valid JWT.
 */
function notBlockedRequired(req, res, next) {
  authRequired(req, res, () => {
    if (req.user.role === 'admin') return next();
    const result = evaluateAccess(null, req.user);
    if (!result.allowed && result.reason !== 'PENDING' && result.reason !== 'NO_PACKAGE') {
      return res.status(403).json({ success: false, error: result.message, code: result.reason, access: result });
    }
    req.access = result;
    next();
  });
}

module.exports = { hashPassword, verifyPassword, signToken, authRequired, adminRequired, accessRequired, notBlockedRequired, evaluateAccess, publicUser };
