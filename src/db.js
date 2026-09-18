'use strict';
/**
 * Tiny JSON-file database (zero native deps).
 * Single Node process => synchronous read-modify-write is atomic for our
 * approve/reject race-condition requirement (PENDING -> APPROVED/REJECTED
 * compare-and-swap happens inside one synchronous save() call).
 *
 * For production scale, swap this module for SQLite/Postgres keeping the
 * same function names; all routes depend only on this interface.
 */
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db.json');

function emptyDb() {
  return {
    meta: { seededAt: null, version: 1 },
    users: [],
    packages: [],
    paymentMethods: [],
    payments: [],
    subscriptions: [],
    appVersions: [],
    notifications: [],
    fcmTokens: [],
    withdrawals: [],
    idempotencyKeys: {},
    seq: { user: 1, package: 1, paymentMethod: 1, payment: 1, subscription: 1, appVersion: 1, notification: 1, withdrawal: 1 },
  };
}

function load() {
  try {
    if (!fs.existsSync(DB_PATH)) {
      const db = emptyDb();
      save(db);
      return db;
    }
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const db = Object.assign(emptyDb(), JSON.parse(raw || '{}'));
    for (const k of Object.keys(emptyDb())) if (db[k] === undefined) db[k] = emptyDb()[k];
    return db;
  } catch (e) {
    console.error('[db] load failed, starting empty:', e.message);
    return emptyDb();
  }
}

/** Atomic write via temp file + rename. */
function save(db) {
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_PATH);
}

function nextId(db, kind) {
  const id = db.seq[kind] || 1;
  db.seq[kind] = id + 1;
  return id;
}

/** Transaction IDs are compared case-insensitively, ignoring spaces/dashes. */
function normalizeTxid(txid) {
  return String(txid || '').trim().toUpperCase().replace(/[\s-]+/g, '');
}

/**
 * Device IDs (Android ANDROID_ID style hex) are compared lower-cased,
 * ignoring spaces/dashes/colons. Returns '' when invalid (valid = 6-64 hex).
 */
function normalizeDeviceId(deviceId) {
  const norm = String(deviceId || '').trim().toLowerCase().replace(/[\s\-:]/g, '');
  return /^[a-f0-9]{6,64}$/.test(norm) ? norm : '';
}

function nowIso() {
  return new Date().toISOString();
}

/** Semver compare: returns -1/0/1. Non-numeric parts ignored. */
function cmpVersions(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function publicUser(u) {
  if (!u) return null;
  const { passwordHash, ...rest } = u;
  return rest;
}

/** Profit splits: Alamin 20 / Rantu 40 / Rony 40 (overridable via env). */
function profitConfig() {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  return [
    { key: 'alamin', name: 'Alamin', pct: num(process.env.PROFIT_ALAMIN_PCT, 20), phone: String(process.env.WITHDRAW_ALAMIN_PHONE || '') },
    { key: 'rantu', name: 'Rantu', pct: num(process.env.PROFIT_RANTU_PCT, 40), phone: String(process.env.WITHDRAW_RANTU_PHONE || '') },
    { key: 'rony', name: 'Rony', pct: num(process.env.PROFIT_RONY_PCT, 40), phone: String(process.env.WITHDRAW_RONY_PHONE || '') },
  ];
}

function dayKey(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

/**
 * Transparent profit summary from APPROVED payments.
 * daily   = approved revenue with reviewedAt/submittedAt == today (UTC)
 * weekly  = approved revenue in the last 7x24h
 * total   = all-time approved revenue
 * withdrawnTotal = sum of withdrawals; remaining = total - withdrawnTotal
 * shares  = per-person entitlement (pct of each bucket) + withdrawable now
 */
function profitSummary(db) {
  const approved = (db.payments || []).filter((p) => p.status === 'APPROVED');
  const amt = (p) => Number(p.amount) || 0;
  const tsOf = (p) => Date.parse(p.reviewedAt || p.submittedAt) || 0;
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  let daily = 0;
  let weekly = 0;
  let total = 0;
  for (const p of approved) {
    const a = amt(p);
    total += a;
    if (dayKey(p.reviewedAt || p.submittedAt) === today) daily += a;
    if (now - tsOf(p) <= 7 * 24 * 60 * 60 * 1000) weekly += a;
  }
  const withdrawals = db.withdrawals || [];
  const withdrawnTotal = withdrawals.reduce((s, w) => s + (Number(w.amount) || 0), 0);
  const remaining = total - withdrawnTotal;
  const people = profitConfig();
  const shares = people.map((pl) => ({
    key: pl.key,
    name: pl.name,
    phone: pl.phone,
    pct: pl.pct,
    totalEntitled: Math.round(total * pl.pct) / 100,
    dailyEntitled: Math.round(daily * pl.pct) / 100,
    weeklyEntitled: Math.round(weekly * pl.pct) / 100,
    // Receivable right now from the remaining pool (proportional split).
    withdrawableNow: Math.round(Math.max(0, remaining) * pl.pct) / 100,
  }));
  return {
    daily, weekly, total, withdrawnTotal,
    remaining,
    count: approved.length,
    withdrawalCount: withdrawals.length,
    people: shares,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { DB_PATH, load, save, nextId, normalizeTxid, normalizeDeviceId, nowIso, cmpVersions, publicUser, profitConfig, profitSummary };
