'use strict';
/**
 * MongoDB connection manager — single shared connection for the whole app.
 *
 * - Uses MONGODB_URI / MONGO_URI + MONGO_DB_NAME from `.env` (no hardcoding).
 * - Connection is created once and reused (Mongoose pooling, maxPoolSize 10).
 * - All application data lives in MongoDB as JSON-compatible documents.
 *   There is intentionally NO filesystem / db.json fallback.
 */

let mongoose = null;
let connectPromise = null;

function getUri() {
  return String(process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
}

function getDbName() {
  return String(process.env.MONGO_DB_NAME || process.env.MONGO_DB || 'otpdb').trim() || 'otpdb';
}

function requireDriver() {
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    return require('mongoose');
  } catch (e) {
    throw new Error('`mongoose` is not installed. Run `npm install mongoose` to enable MongoDB storage.');
  }
}

/**
 * Connect once, reuse everywhere. Resolves to the connected mongoose instance.
 * Throws when MONGODB_URI is missing or the cluster is unreachable.
 */
function ensureMongo() {
  if (mongoose && mongoose.connection && mongoose.connection.readyState === 1) {
    return Promise.resolve(mongoose);
  }
  if (connectPromise) return connectPromise;
  const uri = getUri();
  if (!uri) {
    return Promise.reject(new Error('MONGODB_URI is not set. Set it in `.env` (see .env.example).'));
  }
  const driver = requireDriver();
  driver.set('strictQuery', true);
  connectPromise = driver
    .connect(uri, {
      dbName: getDbName(),
      maxPoolSize: 10,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 10000,
    })
    .then(() => {
      mongoose = driver;
      console.log(`[mongo] connected to MongoDB (db="${getDbName()}").`);
      return mongoose;
    })
    .catch((e) => {
      connectPromise = null;
      throw e;
    });
  return connectPromise;
}

function isConnected() {
  return !!(mongoose && mongoose.connection && mongoose.connection.readyState === 1);
}

function getMongoose() {
  return mongoose;
}

/** Back-compat: old boot path called connectBestEffort(). Now it connects (non-fatal). */
function connectBestEffort() {
  ensureMongo().catch((e) => {
    console.warn('[mongo] connection failed:', e && e.message);
  });
  return null;
}

async function closeMongo() {
  if (mongoose) {
    try {
      await mongoose.disconnect();
    } catch { /* ignore */ }
    mongoose = null;
    connectPromise = null;
  }
}

module.exports = {
  ensureMongo,
  connectBestEffort,
  isConnected,
  getMongoose,
  getUri,
  getDbName,
  closeMongo,
};
