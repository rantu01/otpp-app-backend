'use strict';
/**
 * Optional MongoDB connector.
 *
 * The app keeps its zero-dependency JSON-file store (src/db.js) as the
 * default so `npm start` works with no configuration. When the operator sets
 * MONGODB_URI in `.env`, this module connects via Mongoose (if installed)
 * and exposes the connection for future collection-backed storage.
 *
 * Design: best-effort + non-blocking. A missing driver or unreachable
 * cluster NEVER prevents the server from starting — it logs a warning and
 * continues on the JSON store, so existing functionality cannot break.
 */
function connectBestEffort() {
  const uri = String(process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
  if (!uri) {
    console.log('[mongo] MONGODB_URI not set — using local JSON store (db.json).');
    return null;
  }
  let mongoose = null;
  try {
    // Optional dependency: only required when MongoDB storage is desired.
    // Install with: npm install mongoose
    mongoose = require('mongoose');
  } catch {
    console.warn('[mongo] MONGODB_URI is set but `mongoose` is not installed. Run `npm install mongoose` to enable MongoDB storage. Continuing on JSON store.');
    return null;
  }
  mongoose.set('strictQuery', true);
  mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 })
    .then(() => console.log('[mongo] connected to MongoDB.'))
    .catch((e) => console.warn('[mongo] connection failed, continuing on JSON store:', e && e.message));
  return mongoose;
}

/* Canonical Mongoose schemas mirroring the JSON store shape.
 * Used once the deployment opts into MongoDB; kept here so the data model
 * is explicit and reviewable even while the JSON store is active. */
function registerModels(mongoose) {
  if (!mongoose || mongoose.models.OtpUser) return mongoose.models;
  const s = (extra) => new mongoose.Schema(Object.assign({
    createdAt: { type: String, default: () => new Date().toISOString() },
  }, extra), { strict: false, versionKey: false });
  mongoose.model('OtpUser', s({
    name: String, email: String, phone: String, passwordHash: String,
    role: { type: String, default: 'user' }, status: String,
    accessEnabled: Boolean, deviceId: String, deviceIdNorm: String,
    currentPackageId: Number, currentPackageName: String,
    packageStartDate: String, packageExpireDate: String,
  }), 'users');
  mongoose.model('OtpPayment', s({
    userId: Number, userName: String, amount: Number, status: String,
    packageId: Number, packageName: String, transactionId: String,
    submittedAt: String, reviewedAt: String,
  }), 'payments');
  mongoose.model('OtpWithdrawal', s({
    person: String, phone: String, amount: Number,
    remainingAfter: Number, note: String, createdBy: Number,
  }), 'withdrawals');
  return mongoose.models;
}

module.exports = { connectBestEffort, registerModels };
