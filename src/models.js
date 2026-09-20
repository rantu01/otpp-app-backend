'use strict';
/**
 * Canonical Mongoose models — every application record is a JSON-compatible
 * MongoDB document in the single shared database (MONGO_DB_NAME).
 *
 * Compatibility note: the REST API + Android apps use numeric `id` fields
 * (e.g. packageId, paymentMethodId). Each document therefore keeps BOTH:
 *   - `_id`  : real MongoDB ObjectId (primary key, exposed as string)
 *   - `id`   : numeric auto-increment id (API contract, via `counters`)
 * New code should treat `_id` as the document identity and `id` as the
 * stable API-facing identifier.
 */
const { ensureMongo } = require('./mongo');

let cached = null;
let backfilled = false;

/**
 * Canonical device lookup key: case-insensitive, punctuation-insensitive.
 * Stored in `deviceIdNorm` so device queries hit an index instead of
 * scanning the users collection.
 */
function deviceKey(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** One-time backfill: normalize `deviceIdNorm` for pre-existing rows. */
async function backfillDeviceNorms(models) {
  const missing = await models.OtpUser
    .find({ deviceId: { $ne: null }, deviceIdNorm: null }, { deviceId: 1 })
    .lean();
  if (!missing.length) return 0;
  const ops = missing.map((d) => ({
    updateOne: { filter: { _id: d._id }, update: { $set: { deviceIdNorm: deviceKey(d.deviceId) } } },
  }));
  try {
    await models.OtpUser.bulkWrite(ops, { ordered: false });
  } catch (e) {
    // Non-fatal: lookups still work, just slower for un-backfilled rows.
    console.warn('[mongo] deviceIdNorm backfill incomplete:', e && e.message);
    return 0;
  }
  console.log(`[mongo] backfilled deviceIdNorm for ${missing.length} user(s).`);
  return missing.length;
}

async function getModels() {
  const mongoose = await ensureMongo();
  if (cached && cached.OtpReceivedPayment) return cached;
  cached = null;
  if (mongoose.models.OtpUser && mongoose.models.OtpCounter && mongoose.models.OtpReceivedPayment) {
    cached = mongoose.models;
    return cached;
  }

  const { Schema } = mongoose;
  const isoNow = () => new Date().toISOString();

  const counterSchema = new Schema(
    { kind: { type: String, required: true, unique: true }, seq: { type: Number, default: 1 } },
    { collection: 'counters', versionKey: false }
  );

  const userSchema = new Schema(
    {
      id: { type: Number, required: true, unique: true },
      name: { type: String, default: '' },
      email: { type: String, default: null },
      phone: { type: String, default: null },
      passwordHash: { type: String, required: true },
      role: { type: String, enum: ['user', 'admin', 'free'], default: 'user' },
      status: { type: String, enum: ['active', 'pending', 'disabled'], default: 'pending' },
      accessEnabled: { type: Boolean, default: true },
      deviceId: { type: String, default: null },
      deviceIdNorm: { type: String, default: null },
      currentPackageId: { type: Number, default: null },
      currentPackageName: { type: String, default: null },
      packageStartDate: { type: String, default: null },
      packageExpireDate: { type: String, default: null },
      createdAt: { type: String, default: isoNow },
    },
    { collection: 'users', versionKey: false, strict: true }
  );
  // Email uniqueness applies ONLY to real string emails. Device accounts
  // (email null/missing) must never collide — the old sparse+unique index
  // treated null as a value and blocked every 2nd device activation with
  // E11000 -> HTTP 500 "Internal server error" on POST /api/auth/device
  // (admin login was unaffected, which is why only the User App broke).
  userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
  // Login $or branch: { email } | { phone } — each branch needs its own index.
  userSchema.index({ phone: 1 }, { sparse: true });
  // Admin user list: { role: $in:[user,free] } + sort { id: -1 }.
  userSchema.index({ role: 1, id: -1 });
  // Dashboard active-subscription count: role + packageExpireDate range
  // (ISO strings compare lexicographically; $ne currentPackageId filtered).
  userSchema.index({ role: 1, packageExpireDate: 1 });
  userSchema.index({ deviceIdNorm: 1 }, { sparse: true });

  const packageSchema = new Schema(
    {
      id: { type: Number, required: true, unique: true },
      name: { type: String, required: true },
      price: { type: Number, required: true, min: 0 },
      durationDays: { type: Number, required: true, min: 1 },
      status: { type: String, enum: ['active', 'inactive'], default: 'active' },
      description: { type: String, default: '' },
      createdAt: { type: String, default: isoNow },
      updatedAt: { type: String, default: isoNow },
    },
    { collection: 'packages', versionKey: false, strict: true }
  );
  // User catalog: { status: 'active' } + sort { price: 1 }.
  packageSchema.index({ status: 1, price: 1 });

  const methodSchema = new Schema(
    {
      id: { type: Number, required: true, unique: true },
      name: { type: String, required: true },
      walletNumber: { type: String, required: true },
      accountType: { type: String, default: 'Personal' },
      logo: { type: String, default: '' },
      instructions: { type: String, default: 'Send Money to this number.' },
      status: { type: String, enum: ['active', 'inactive'], default: 'active' },
      sortOrder: { type: Number, default: 0 },
      createdAt: { type: String, default: isoNow },
      updatedAt: { type: String, default: isoNow },
    },
    { collection: 'paymentmethods', versionKey: false, strict: true }
  );
  // User catalog: { status: 'active' } + sort { sortOrder: 1 }.
  methodSchema.index({ status: 1, sortOrder: 1 });

  const paymentSchema = new Schema(
    {
      id: { type: Number, required: true, unique: true },
      userId: { type: Number, required: true },
      userName: { type: String, default: '' },
      userEmail: { type: String, default: null },
      deviceId: { type: String, default: null },
      packageId: { type: Number, default: null },
      packageName: { type: String, default: '' },
      amount: { type: Number, default: 0 },
      durationDays: { type: Number, default: 0 },
      paymentMethodId: { type: Number, default: null },
      paymentMethodName: { type: String, default: '' },
      walletNumber: { type: String, default: '' },
      transactionId: { type: String, required: true },
      transactionIdNorm: { type: String, required: true },
      status: { type: String, enum: ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'], default: 'PENDING' },
      submittedAt: { type: String, default: isoNow },
      reviewedAt: { type: String, default: null },
      reviewedBy: { type: Number, default: null },
      rejectionReason: { type: String, default: null },
    },
    { collection: 'payments', versionKey: false, strict: true }
  );
  // Backend duplicate-transaction guard at the DB level (CANCELLED may repeat).
  paymentSchema.index(
    { transactionIdNorm: 1 },
    { unique: true, partialFilterExpression: { status: { $ne: 'CANCELLED' } } }
  );
  paymentSchema.index({ userId: 1, id: -1 });
  paymentSchema.index({ status: 1, id: -1 });
  // Delete guards: pending references per package / payment method.
  paymentSchema.index({ packageId: 1, status: 1 });
  paymentSchema.index({ paymentMethodId: 1, status: 1 });

  const receivedPaymentSchema = new Schema(
    {
      id: { type: Number, required: true, unique: true },
      amount: { type: Number, required: true, min: 0 },
      sender: { type: String, required: true },
      fee: { type: Number, default: 0 },
      balance: { type: Number, default: null },
      trxId: { type: String, required: true },
      trxIdNorm: { type: String, required: true },
      transactionDate: { type: String, default: null },
      transactionTime: { type: String, default: null },
      originalMessage: { type: String, default: '' },
      receivedAt: { type: String, default: isoNow },
      deviceInfo: { type: String, default: '' },
      source: { type: String, default: 'bkash_sms' },
      status: {
        type: String,
        enum: ['pending', 'verified', 'used', 'rejected', 'duplicate'],
        default: 'pending',
      },
      matchedPaymentId: { type: Number, default: null },
      verifiedBy: { type: Number, default: null },
      verifiedAt: { type: String, default: null },
      createdAt: { type: String, default: isoNow },
      updatedAt: { type: String, default: isoNow },
    },
    { collection: 'received_payments', versionKey: false, strict: true }
  );
  // Duplicate protection: one document per bKash TrxID (final authority).
  receivedPaymentSchema.index({ trxIdNorm: 1 }, { unique: true });
  receivedPaymentSchema.index({ transactionDate: 1 });
  receivedPaymentSchema.index({ sender: 1 });
  receivedPaymentSchema.index({ createdAt: 1 });
  receivedPaymentSchema.index({ status: 1, id: -1 });

  const subscriptionSchema = new Schema(
    {
      id: { type: Number, required: true, unique: true },
      userId: { type: Number, required: true },
      packageId: { type: Number, default: null },
      packageName: { type: String, default: '' },
      price: { type: Number, default: 0 },
      durationDays: { type: Number, default: 0 },
      startDate: { type: String, default: null },
      expireDate: { type: String, default: null },
      status: { type: String, default: 'active' },
      paymentRequestId: { type: Number, default: null },
      createdAt: { type: String, default: isoNow },
      createdBy: { type: Number, default: null },
      deviceId: { type: String, default: null },
    },
    { collection: 'subscriptions', versionKey: false, strict: true }
  );
  subscriptionSchema.index({ userId: 1, id: -1 });

  const versionSchema = new Schema(
    {
      id: { type: Number, required: true, unique: true },
      platform: { type: String, required: true, unique: true },
      latestVersion: { type: String, default: '1.0.0' },
      minimumSupportedVersion: { type: String, default: '1.0.0' },
      updateRequired: { type: Boolean, default: false },
      updateUrl: { type: String, default: '' },
      message: { type: String, default: '' },
      updatedAt: { type: String, default: isoNow },
    },
    { collection: 'appversions', versionKey: false, strict: true }
  );

  const notificationSchema = new Schema(
    {
      id: { type: Number, required: true, unique: true },
      type: { type: String, default: 'NEW_PAYMENT' },
      title: { type: String, default: '' },
      message: { type: String, default: '' },
      paymentRequestId: { type: Number, default: null },
      read: { type: Boolean, default: false },
      createdAt: { type: String, default: isoNow },
    },
    { collection: 'notifications', versionKey: false, strict: true }
  );
  // Latest-first list (sort { id: -1 } served by the unique id index) +
  // unread badge count ({ read: false }). Compound serves both.
  notificationSchema.index({ read: 1, id: -1 });

  const fcmSchema = new Schema(
    {
      token: { type: String, required: true, unique: true },
      platform: { type: String, default: 'android' },
      adminId: { type: Number, default: null },
      createdAt: { type: String, default: isoNow },
    },
    { collection: 'fcmtokens', versionKey: false, strict: true }
  );

  const withdrawalSchema = new Schema(
    {
      id: { type: Number, required: true, unique: true },
      person: { type: String, required: true },
      personKey: { type: String, default: '' },
      phone: { type: String, default: '' },
      amount: { type: Number, required: true, min: 0 },
      totalProfitAtTime: { type: Number, default: 0 },
      withdrawnTotalBefore: { type: Number, default: 0 },
      remainingAfter: { type: Number, default: 0 },
      sharesAtTime: { type: Schema.Types.Mixed, default: [] },
      note: { type: String, default: '' },
      createdBy: { type: Number, default: null },
      createdAt: { type: String, default: isoNow },
    },
    { collection: 'withdrawals', versionKey: false, strict: true }
  );

  const idemSchema = new Schema(
    {
      key: { type: String, required: true, unique: true },
      paymentId: { type: Number, required: true },
      createdAt: { type: String, default: isoNow },
    },
    { collection: 'idempotencykeys', versionKey: false, strict: true }
  );

  cached = {
    OtpCounter: mongoose.model('OtpCounter', counterSchema),
    OtpUser: mongoose.model('OtpUser', userSchema),
    OtpPackage: mongoose.model('OtpPackage', packageSchema),
    OtpMethod: mongoose.model('OtpMethod', methodSchema),
    OtpPayment: mongoose.model('OtpPayment', paymentSchema),
    OtpSubscription: mongoose.model('OtpSubscription', subscriptionSchema),
    OtpVersion: mongoose.model('OtpVersion', versionSchema),
    OtpNotification: mongoose.model('OtpNotification', notificationSchema),
    OtpFcmToken: mongoose.model('OtpFcmToken', fcmSchema),
    OtpWithdrawal: mongoose.model('OtpWithdrawal', withdrawalSchema),
    OtpIdemKey: mongoose.model('OtpIdemKey', idemSchema),
    OtpReceivedPayment: mongoose.models.OtpReceivedPayment || mongoose.model('OtpReceivedPayment', receivedPaymentSchema),
  };

  // Migrate the legacy sparse+unique email index (blocked multiple null
  // emails) to the partial-unique index defined above. syncIndexes() alone
  // may keep the old index when name/key match, so drop the stale shape
  // explicitly before syncing.
  try {
    const list = await cached.OtpUser.collection.listIndexes().toArray();
    const emailIdx = (list || []).find((i) => i && i.name === 'email_1');
    if (emailIdx && (emailIdx.sparse || !emailIdx.partialFilterExpression)) {
      await cached.OtpUser.collection.dropIndex('email_1').catch(() => null);
      console.log('[mongo] dropped legacy sparse email index (email_1).');
    }
  } catch (e) {
    console.warn('[mongo] email index check skipped:', e && e.message);
  }

  // Ensure indexes exist (safe to call repeatedly).
  await Promise.all(Object.values(cached).map((m) => m.syncIndexes().catch(() => null)));

  // One-time data repair so indexed device lookups cover legacy rows.
  if (!backfilled) {
    backfilled = true;
    try {
      await backfillDeviceNorms(cached);
    } catch (e) {
      console.warn('[mongo] backfill skipped:', e && e.message);
    }
  }

  return cached;
}

module.exports = { getModels, deviceKey };
