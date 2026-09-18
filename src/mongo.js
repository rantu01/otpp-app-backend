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
      // Pool: one shared client for all requests. maxPoolSize 10 fits small
      // Atlas tiers while absorbing admin-dashboard + user-app bursts;
      // minPoolSize 2 keeps warm sockets so hot paths skip handshakes.
      maxPoolSize: 10,
      minPoolSize: 2,
      // Fail fast on unreachable clusters instead of hanging requests.
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
      maxIdleTimeMS: 30000,
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
