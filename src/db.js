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
    idempotencyKeys: {},
    seq: { user: 1, package: 1, paymentMethod: 1, payment: 1, subscription: 1, appVersion: 1, notification: 1 },
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

module.exports = { DB_PATH, load, save, nextId, normalizeTxid, nowIso, cmpVersions, publicUser };
