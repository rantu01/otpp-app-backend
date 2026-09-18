'use strict';
/**
 * MongoDB-backed data layer. Every function talks to the single shared
 * MongoDB database — no filesystem, no db.json, no local JSON files.
 * All documents are JSON-compatible; `_id` (ObjectId) is serialized to string.
 */
const { getModels } = require('./models');

/* ---------- pure helpers (no I/O) ---------- */

function normalizeTxid(txid) {
  return String(txid || '').trim().toUpperCase().replace(/[\s-]+/g, '');
}

function normalizeDeviceId(deviceId) {
  const norm = String(deviceId || '').trim().toLowerCase().replace(/[\s\-:]/g, '');
  return /^[a-f0-9]{6,64}$/.test(norm) ? norm : '';
}

function nowIso() {
  return new Date().toISOString();
}

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
  const obj = u && u.toObject ? u.toObject() : { ...u };
  delete obj.passwordHash;
  return serialize(obj);
}

/** Convert Mongoose docs / ObjectIds to plain JSON-compatible objects. */
function serialize(doc) {
  if (doc === null || doc === undefined) return doc;
  if (Array.isArray(doc)) return doc.map(serialize);
  let o = doc;
  if (o && typeof o.toObject === 'function') o = o.toObject();
  else if (o && typeof o === 'object') o = { ...o };
  else return o;
  if (o._id !== undefined && o._id !== null) o._id = String(o._id);
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v !== null && typeof v === 'object' && v._bsontype === 'ObjectId') o[k] = String(v);
  }
  return o;
}

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

function summarizeProfit(approvedPayments, withdrawals) {
  const amt = (p) => Number(p.amount) || 0;
  const tsOf = (p) => Date.parse(p.reviewedAt || p.submittedAt) || 0;
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  let daily = 0;
  let weekly = 0;
  let total = 0;
  for (const p of approvedPayments) {
    const a = amt(p);
    total += a;
    if (dayKey(p.reviewedAt || p.submittedAt) === today) daily += a;
    if (now - tsOf(p) <= 7 * 24 * 60 * 60 * 1000) weekly += a;
  }
  const withdrawnTotal = (withdrawals || []).reduce((s, w) => s + (Number(w.amount) || 0), 0);
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
    withdrawableNow: Math.round(Math.max(0, remaining) * pl.pct) / 100,
  }));
  return {
    daily, weekly, total, withdrawnTotal,
    remaining,
    count: approvedPayments.length,
    withdrawalCount: (withdrawals || []).length,
    people: shares,
    generatedAt: new Date().toISOString(),
  };
}

/* ---------- atomic id counters ---------- */

async function nextId(kind) {
  const { OtpCounter } = await getModels();
  const doc = await OtpCounter.findOneAndUpdate(
    { kind },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  ).lean();
  return doc.seq;
}

/* ---------- users ---------- */

async function findUserById(id) {
  const { OtpUser } = await getModels();
  return serialize(await OtpUser.findOne({ id: Number(id) }).lean());
}

async function findUserRawById(id) {
  const { OtpUser } = await getModels();
  return OtpUser.findOne({ id: Number(id) });
}

async function findUserByLogin(login) {
  const { OtpUser } = await getModels();
  const key = String(login || '').trim().toLowerCase();
  if (!key) return null;
  const user = await OtpUser.findOne({
    $or: [{ email: key }, { phone: key }],
  }).lean();
  return serialize(user);
}

async function userLoginExists(login) {
  return !!(await findUserByLogin(login));
}

async function findUserByDeviceNorm(norm) {
  const { OtpUser } = await getModels();
  if (!norm) return null;
  const user = await OtpUser.findOne({ deviceIdNorm: norm, role: { $ne: 'admin' } }).lean();
  return serialize(user);
}

async function findUserByDevice(deviceId) {
  const { OtpUser } = await getModels();
  const norm = String(deviceId || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!norm) return null;
  const users = await OtpUser.find({ deviceId: { $ne: null } }).lean();
  const hit = users.find((u) => String(u.deviceId || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '') === norm);
  return serialize(hit || null);
}

async function listUsers(search) {
  const { OtpUser } = await getModels();
  const q = String(search || '').toLowerCase();
  let users = await OtpUser.find({ role: { $ne: 'admin' } }).sort({ id: -1 }).lean();
  if (q) {
    users = users.filter((u) => String(u.id).includes(q)
      || (u.name || '').toLowerCase().includes(q)
      || (u.email || '').toLowerCase().includes(q)
      || (u.phone || '').includes(q));
  }
  return serialize(users);
}

async function createUser(data) {
  const { OtpUser } = await getModels();
  const id = await nextId('user');
  const doc = await OtpUser.create({ id, ...data });
  return serialize(doc.toObject());
}

async function updateUserById(id, patch) {
  const { OtpUser } = await getModels();
  const doc = await OtpUser.findOneAndUpdate({ id: Number(id) }, { $set: patch }, { new: true }).lean();
  return serialize(doc);
}

async function deleteUserById(id) {
  const { OtpUser } = await getModels();
  const doc = await OtpUser.findOneAndDelete({ id: Number(id), role: { $ne: 'admin' } }).lean();
  return serialize(doc);
}

async function countUsers() {
  const { OtpUser } = await getModels();
  return OtpUser.countDocuments({ role: { $ne: 'admin' } });
}

/* ---------- packages ---------- */

async function listPackages(activeOnly) {
  const { OtpPackage } = await getModels();
  const filter = activeOnly ? { status: 'active' } : {};
  const docs = await OtpPackage.find(filter).lean();
  docs.sort((a, b) => (activeOnly ? a.price - b.price : a.id - b.id));
  return serialize(docs);
}

async function findPackageById(id) {
  const { OtpPackage } = await getModels();
  return serialize(await OtpPackage.findOne({ id: Number(id) }).lean());
}

async function createPackage(data) {
  const { OtpPackage } = await getModels();
  const id = await nextId('package');
  const doc = await OtpPackage.create({
    id, status: 'active', createdAt: nowIso(), updatedAt: nowIso(), ...data, id,
  });
  return serialize(doc.toObject());
}

async function updatePackageById(id, patch) {
  const { OtpPackage } = await getModels();
  const doc = await OtpPackage.findOneAndUpdate(
    { id: Number(id) }, { $set: { ...patch, updatedAt: nowIso() } }, { new: true }
  ).lean();
  return serialize(doc);
}

async function deletePackageById(id) {
  const { OtpPackage } = await getModels();
  const doc = await OtpPackage.findOneAndDelete({ id: Number(id) }).lean();
  return serialize(doc);
}

/* ---------- payment methods ---------- */

async function listMethods(activeOnly) {
  const { OtpMethod } = await getModels();
  const filter = activeOnly ? { status: 'active' } : {};
  const docs = await OtpMethod.find(filter).lean();
  docs.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  return serialize(docs);
}

async function findMethodById(id) {
  const { OtpMethod } = await getModels();
  return serialize(await OtpMethod.findOne({ id: Number(id) }).lean());
}

async function createMethod(data) {
  const { OtpMethod } = await getModels();
  const id = await nextId('paymentMethod');
  const count = await OtpMethod.countDocuments();
  const doc = await OtpMethod.create({
    id, status: 'active', sortOrder: count, createdAt: nowIso(), updatedAt: nowIso(), ...data, id,
  });
  return serialize(doc.toObject());
}

async function updateMethodById(id, patch) {
  const { OtpMethod } = await getModels();
  const doc = await OtpMethod.findOneAndUpdate(
    { id: Number(id) }, { $set: { ...patch, updatedAt: nowIso() } }, { new: true }
  ).lean();
  return serialize(doc);
}

async function deleteMethodById(id) {
  const { OtpMethod } = await getModels();
  const doc = await OtpMethod.findOneAndDelete({ id: Number(id) }).lean();
  return serialize(doc);
}

/* ---------- payments ---------- */

async function findPaymentById(id) {
  const { OtpPayment } = await getModels();
  return serialize(await OtpPayment.findOne({ id: Number(id) }).lean());
}

async function listPayments({ status, search } = {}) {
  const { OtpPayment } = await getModels();
  const filter = {};
  if (status) filter.status = String(status).toUpperCase();
  let docs = await OtpPayment.find(filter).sort({ id: -1 }).lean();
  if (search) {
    const q = String(search).toLowerCase();
    docs = docs.filter((p) => String(p.id).includes(q) || String(p.userId).includes(q)
      || (p.userName || '').toLowerCase().includes(q)
      || (p.transactionId || '').toLowerCase().includes(q)
      || (p.packageName || '').toLowerCase().includes(q)
      || (p.paymentMethodName || '').toLowerCase().includes(q));
  }
  return serialize(docs);
}

async function listUserPayments(userId) {
  const { OtpPayment } = await getModels();
  return serialize(await OtpPayment.find({ userId: Number(userId) }).sort({ id: -1 }).lean());
}

async function countPendingPayments() {
  const { OtpPayment } = await getModels();
  return OtpPayment.countDocuments({ status: 'PENDING' });
}

async function hasPendingRefToPackage(packageId) {
  const { OtpPayment } = await getModels();
  return (await OtpPayment.countDocuments({ packageId: Number(packageId), status: 'PENDING' })) > 0;
}

async function hasPendingRefToMethod(methodId) {
  const { OtpPayment } = await getModels();
  return (await OtpPayment.countDocuments({ paymentMethodId: Number(methodId), status: 'PENDING' })) > 0;
}

async function findDuplicateTxid(norm) {
  const { OtpPayment } = await getModels();
  return serialize(await OtpPayment.findOne({ transactionIdNorm: norm, status: { $ne: 'CANCELLED' } }).lean());
}

async function createPayment(data) {
  const { OtpPayment } = await getModels();
  const id = await nextId('payment');
  try {
    const doc = await OtpPayment.create({ id, ...data });
    return serialize(doc.toObject());
  } catch (e) {
    if (e && (e.code === 11000)) {
      const dup = await findDuplicateTxid(data.transactionIdNorm);
      const err = new Error('This Transaction ID has already been submitted.');
      err.code = 'DUPLICATE_TXID';
      err.duplicate = dup;
      throw err;
    }
    throw e;
  }
}

/**
 * Atomic PENDING -> APPROVED. Only one concurrent caller wins (MongoDB
 * findOneAndUpdate with a status filter = compare-and-swap).
 */
async function approvePaymentAtomic(paymentId, reviewerId) {
  const { OtpPayment, OtpUser, OtpSubscription } = await getModels();
  const reviewedAt = nowIso();
  const payment = await OtpPayment.findOneAndUpdate(
    { id: Number(paymentId), status: 'PENDING' },
    { $set: { status: 'APPROVED', reviewedAt, reviewedBy: reviewerId } },
    { new: true }
  ).lean();
  if (!payment) {
    const existing = await OtpPayment.findOne({ id: Number(paymentId) }).lean();
    const err = new Error(existing ? 'Payment has already been reviewed.' : 'Payment not found.');
    err.code = existing ? 'ALREADY_REVIEWED' : 'NOT_FOUND';
    err.status = existing ? existing.status : null;
    throw err;
  }
  const user = await OtpUser.findOne({ id: payment.userId });
  if (!user) {
    const err = new Error('User not found.');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }
  const pkgDoc = await getModels().then((m) => m.OtpPackage.findOne({ id: payment.packageId }).lean());
  if (!pkgDoc) {
    const err = new Error('Package no longer exists.');
    err.code = 'PACKAGE_GONE';
    throw err;
  }
  const { start, expire } = activationWindow(user.toObject(), pkgDoc.durationDays, Date.now());
  user.currentPackageId = pkgDoc.id;
  user.currentPackageName = pkgDoc.name;
  user.packageStartDate = new Date(start).toISOString();
  user.packageExpireDate = new Date(expire).toISOString();
  if (user.status !== 'active') user.status = 'active';
  await user.save();
  const subId = await nextId('subscription');
  const sub = await OtpSubscription.create({
    id: subId,
    userId: user.id,
    packageId: pkgDoc.id,
    packageName: pkgDoc.name,
    price: payment.amount,
    durationDays: pkgDoc.durationDays,
    startDate: user.packageStartDate,
    expireDate: user.packageExpireDate,
    status: 'active',
    paymentRequestId: payment.id,
    createdAt: nowIso(),
    createdBy: reviewerId,
    deviceId: user.deviceIdNorm || user.deviceId || null,
  });
  return { payment: serialize(payment), subscription: serialize(sub.toObject()), user: publicUser(user.toObject()) };
}

async function rejectPaymentAtomic(paymentId, reviewerId, reason) {
  const { OtpPayment } = await getModels();
  const payment = await OtpPayment.findOneAndUpdate(
    { id: Number(paymentId), status: 'PENDING' },
    {
      $set: {
        status: 'REJECTED',
        reviewedAt: nowIso(),
        reviewedBy: reviewerId,
        rejectionReason: String(reason || 'Transaction ID could not be verified.'),
      },
    },
    { new: true }
  ).lean();
  if (!payment) {
    const existing = await OtpPayment.findOne({ id: Number(paymentId) }).lean();
    const err = new Error(existing ? 'Payment has already been reviewed.' : 'Payment not found.');
    err.code = existing ? 'ALREADY_REVIEWED' : 'NOT_FOUND';
    err.status = existing ? existing.status : null;
    throw err;
  }
  return serialize(payment);
}

/* ---------- subscriptions ---------- */

async function listUserSubscriptions(userId) {
  const { OtpSubscription } = await getModels();
  return serialize(await OtpSubscription.find({ userId: Number(userId) }).sort({ id: -1 }).lean());
}

async function listAllSubscriptions() {
  const { OtpSubscription } = await getModels();
  return serialize(await OtpSubscription.find({}).sort({ id: -1 }).lean());
}

async function createSubscription(data) {
  const { OtpSubscription } = await getModels();
  const id = await nextId('subscription');
  const doc = await OtpSubscription.create({ id, ...data });
  return serialize(doc.toObject());
}

/* ---------- notifications / fcm / versions ---------- */

async function listNotifications(limit = 100) {
  const { OtpNotification } = await getModels();
  return serialize(await OtpNotification.find({}).sort({ id: -1 }).limit(limit).lean());
}

async function countUnreadNotifications() {
  const { OtpNotification } = await getModels();
  return OtpNotification.countDocuments({ read: false });
}

async function createNotification(data) {
  const { OtpNotification } = await getModels();
  const id = await nextId('notification');
  const doc = await OtpNotification.create({ id, read: false, createdAt: nowIso(), ...data, id });
  return serialize(doc.toObject());
}

async function markAllNotificationsRead() {
  const { OtpNotification } = await getModels();
  await OtpNotification.updateMany({ read: false }, { $set: { read: true } });
}

async function addFcmToken({ token, platform, adminId }) {
  const { OtpFcmToken } = await getModels();
  await OtpFcmToken.updateOne(
    { token: String(token) },
    { $setOnInsert: { token: String(token), platform: String(platform || 'android'), adminId: adminId || null, createdAt: nowIso() } },
    { upsert: true }
  );
}

async function countFcmTokens() {
  const { OtpFcmToken } = await getModels();
  return OtpFcmToken.countDocuments();
}

async function listVersions() {
  const { OtpVersion } = await getModels();
  return serialize(await OtpVersion.find({}).lean());
}

async function findVersion(platform) {
  const { OtpVersion } = await getModels();
  return serialize(await OtpVersion.findOne({ platform: String(platform).toLowerCase() }).lean());
}

async function upsertVersion(platform, patch) {
  const { OtpVersion } = await getModels();
  const plat = String(platform || 'android').toLowerCase();
  let doc = await OtpVersion.findOne({ platform: plat }).lean();
  if (!doc) {
    const id = await nextId('appVersion');
    const created = await OtpVersion.create({
      id, platform: plat, latestVersion: '1.0.0', minimumSupportedVersion: '1.0.0',
      updateRequired: false, updateUrl: '', message: '', updatedAt: nowIso(), ...patch,
    });
    return serialize(created.toObject());
  }
  const updated = await OtpVersion.findOneAndUpdate(
    { platform: plat }, { $set: { ...patch, updatedAt: nowIso() } }, { new: true }
  ).lean();
  return serialize(updated);
}

/* ---------- withdrawals + profit ---------- */

async function listWithdrawals() {
  const { OtpWithdrawal } = await getModels();
  return serialize(await OtpWithdrawal.find({}).sort({ id: -1 }).lean());
}

async function createWithdrawal(data) {
  const { OtpWithdrawal } = await getModels();
  const id = await nextId('withdrawal');
  const doc = await OtpWithdrawal.create({ id, ...data });
  return serialize(doc.toObject());
}

async function profitSummary() {
  const { OtpPayment, OtpWithdrawal } = await getModels();
  const approved = await OtpPayment.find({ status: 'APPROVED' }).lean();
  const withdrawals = await OtpWithdrawal.find({}).lean();
  return summarizeProfit(approved, withdrawals);
}

async function dashboardStats() {
  const { OtpPayment, OtpUser } = await getModels();
  const payments = await OtpPayment.find({}).lean();
  const pending = payments.filter((p) => p.status === 'PENDING').length;
  const approved = payments.filter((p) => p.status === 'APPROVED');
  const rejected = payments.filter((p) => p.status === 'REJECTED').length;
  const revenue = approved.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const now = Date.now();
  const users = await OtpUser.find({ role: { $ne: 'admin' } }).lean();
  const active = users.filter((u) => u.currentPackageId && u.packageExpireDate && Date.parse(u.packageExpireDate) > now).length;
  const expired = users.filter((u) => !u.currentPackageId || !u.packageExpireDate || Date.parse(u.packageExpireDate) <= now).length;
  const profit = summarizeProfit(approved, await listWithdrawals());
  return {
    stats: {
      totalPayments: payments.length, pending, approved: approved.length, rejected,
      approvedRevenue: revenue, activeSubscriptions: active, expiredSubscriptions: expired,
      totalUsers: users.length,
      dailyProfit: profit.daily, weeklyProfit: profit.weekly, totalProfit: profit.total,
      withdrawnTotal: profit.withdrawnTotal, remainingProfit: profit.remaining,
      withdrawalCount: profit.withdrawalCount,
    },
    profit,
  };
}

/* ---------- idempotency ---------- */

async function findPaymentIdByIdemKey(key) {
  if (!key) return null;
  const { OtpIdemKey } = await getModels();
  const row = await OtpIdemKey.findOne({ key: String(key) }).lean();
  return row ? row.paymentId : null;
}

async function saveIdemKey(key, paymentId) {
  if (!key) return;
  const { OtpIdemKey } = await getModels();
  await OtpIdemKey.updateOne(
    { key: String(key) },
    { $setOnInsert: { key: String(key), paymentId, createdAt: nowIso() } },
    { upsert: true }
  );
}

/* ---------- misc ---------- */

function activationWindow(user, durationDays, nowMs) {
  const days = Math.max(1, Number(durationDays) || 1);
  const currentExp = user.packageExpireDate ? Date.parse(user.packageExpireDate) : NaN;
  const start = !Number.isNaN(currentExp) && currentExp > nowMs ? currentExp : nowMs;
  return { start, expire: start + days * 24 * 60 * 60 * 1000 };
}

module.exports = {
  // pure helpers
  normalizeTxid, normalizeDeviceId, nowIso, cmpVersions, publicUser,
  profitConfig, profitSummary, serialize,
  // counters
  nextId,
  // users
  findUserById, findUserRawById, findUserByLogin, userLoginExists,
  findUserByDeviceNorm, findUserByDevice, listUsers, createUser,
  updateUserById, deleteUserById, countUsers,
  // packages / methods
  listPackages, findPackageById, createPackage, updatePackageById, deletePackageById,
  listMethods, findMethodById, createMethod, updateMethodById, deleteMethodById,
  // payments
  findPaymentById, listPayments, listUserPayments, countPendingPayments,
  hasPendingRefToPackage, hasPendingRefToMethod, findDuplicateTxid, createPayment,
  approvePaymentAtomic, rejectPaymentAtomic,
  // subscriptions
  listUserSubscriptions, listAllSubscriptions, createSubscription,
  // notifications / fcm / versions
  listNotifications, countUnreadNotifications, createNotification, markAllNotificationsRead,
  addFcmToken, countFcmTokens, listVersions, findVersion, upsertVersion,
  // withdrawals / profit
  listWithdrawals, createWithdrawal, dashboardStats,
  // idempotency
  findPaymentIdByIdemKey, saveIdemKey,
  // misc
  activationWindow,
};
