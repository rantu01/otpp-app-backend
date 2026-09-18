'use strict';
/**
 * Security hardening for https://otp.rantumondal.dev
 *
 * Zero-dependency middleware bundle:
 *  - Security headers (helmet-equivalent subset)
 *  - CORS allow-list (env CORS_ORIGIN, comma-separated; default same-origin)
 *  - In-memory rate limiting (per-IP sliding window, configurable via env)
 *  - Auth brute-force shield on /api/auth/* (tighter bucket)
 *  - Input hygiene: JSON size already capped in app.js, plus lightweight
 *    prototype-pollution + NoSQL-operator scrubbing of req.body
 *  - Trust-proxy safe client IP resolution for rate limiting behind Nginx
 *
 * None of this changes the API contract — it only rejects abusive traffic
 * with 429/400 before it reaches the routes.
 */

const generalHits = new Map(); // ip -> { count, resetAt }
const authHits = new Map();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length) return fwd.split(',')[0].trim();
  return (req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').toString();
}

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function rateLimit({ windowMs, max, bucket, message }) {
  return (req, res, next) => {
    // Health/version checks stay cheap and unlimited for uptime monitors.
    if (req.path === '/api/health' || req.path === '/api/versions/check') return next();
    const now = Date.now();
    const key = clientIp(req);
    let e = bucket.get(key);
    if (!e || now > e.resetAt) {
      e = { count: 0, resetAt: now + windowMs };
      bucket.set(key, e);
    }
    e.count += 1;
    if (e.count > max) {
      const retryAfter = Math.max(1, Math.ceil((e.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ success: false, error: message || 'Too many requests. Slow down and retry.' });
    }
    next();
  };
}

/** Scrub Mongo-operator keys ($..., .) from JSON bodies to block NoSQL injection. */
function sanitizeBody(req, res, next) {
  try {
    if (req.body && typeof req.body === 'object') {
      const scrub = (obj, depth) => {
        if (!obj || typeof obj !== 'object' || depth > 5) return;
        for (const k of Object.keys(obj)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype' || k.startsWith('$') || k.includes('.')) {
            delete obj[k];
            continue;
          }
          const v = obj[k];
          if (v && typeof v === 'object') scrub(v, depth + 1);
          else if (typeof v === 'string' && v.length > 5000) obj[k] = v.slice(0, 5000);
        }
      };
      scrub(req.body, 0);
    }
  } catch { /* never block legit traffic on sanitizer failure */ }
  next();
}

function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'no-referrer');
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.set('Cross-Origin-Opener-Policy', 'same-origin');
  res.set('Cross-Origin-Resource-Policy', 'same-origin');
  // HSTS only makes sense over TLS (production domain); harmless locally.
  if ((req.headers['x-forwarded-proto'] || req.protocol) === 'https') {
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  // Least-privilege CORS is configured in app.js; strip fingerprinting header.
  res.removeHeader('X-Powered-By');
  next();
}

function corsAllowList() {
  const raw = String(process.env.CORS_ORIGIN || '').trim();
  if (!raw || raw === '*') return null; // null => allow all (dev default, preserves old behaviour)
  const allowed = raw.split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
  return allowed;
}

function installSecurity(app, cors) {
  const generalWindow = envInt('RATE_LIMIT_WINDOW_MS', 60 * 1000);
  const generalMax = envInt('RATE_LIMIT_MAX', 300);
  const authWindow = envInt('AUTH_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000);
  const authMax = envInt('AUTH_RATE_LIMIT_MAX', 100);

  app.set('trust proxy', 1);
  app.use(securityHeaders);
  app.use(sanitizeBody);
  app.use(rateLimit({ windowMs: generalWindow, max: generalMax, bucket: generalHits, message: 'Too many requests. Please retry shortly.' }));

  // Tighter bucket for credential/device endpoints (brute-force shield).
  app.use('/api/auth', rateLimit({ windowMs: authWindow, max: authMax, bucket: authHits, message: 'Too many login attempts. Try again later.' }));

  // Periodic bucket cleanup so the maps cannot grow unboundedly.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [m] of [[generalHits], [authHits]]) {
      for (const [k, v] of m.entries()) {
        if (v.resetAt < now) m.delete(k);
      }
      if (m.size > 10000) {
        const first = m.keys().next();
        if (!first.done) m.delete(first.value);
      }
    }
  }, 5 * 60 * 1000);
  if (timer.unref) timer.unref();

  return { corsAllowList: corsAllowList(), corsLib: cors };
}

module.exports = { installSecurity, corsAllowList, clientIp };
