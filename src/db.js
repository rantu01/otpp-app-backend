'use strict';
/**
 * Pure helpers (no I/O). Persistent storage lives ONLY in MongoDB via
 * src/store.js — this module intentionally performs no filesystem access
 * and never reads/writes db.json.
 */
const store = require('./store');

function load() {
  throw new Error('db.load() is retired: all data lives in MongoDB via src/store.js.');
}

function save() {
  throw new Error('db.save() is retired: all data lives in MongoDB via src/store.js.');
}

module.exports = {
  DB_PATH: null,
  load,
  save,
  nextId: store.nextId,
  normalizeTxid: store.normalizeTxid,
  normalizeDeviceId: store.normalizeDeviceId,
  nowIso: store.nowIso,
  cmpVersions: store.cmpVersions,
  publicUser: store.publicUser,
  profitConfig: store.profitConfig,
  profitSummary: (...args) => {
    throw new Error('db.profitSummary(db) is retired: use store.profitSummary() (async, MongoDB).');
  },
};
