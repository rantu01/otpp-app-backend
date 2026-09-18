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

async function getModels() {
  const mongoose = await ensureMongo();
  if (cached) return cached;
  if (mongoose.models.OtpUser && mongoose.models.OtpCounter) {
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
  userSchema.index({ email: 1 }, { sparse: true, unique: true });
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
  notificationSchema.index({ id: -1 });

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
  };

  // Ensure indexes exist (safe to call repeatedly).
  await Promise.all(Object.values(cached).map((m) => m.syncIndexes().catch(() => null)));

  return cached;
}

module.exports = { getModels };
