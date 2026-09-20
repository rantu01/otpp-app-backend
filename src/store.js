'use strict';
/**
 * MongoDB-backed data layer. Every function talks to the single shared
 * MongoDB database — no filesystem, no db.json, no local JSON files.
 * All documents are JSON-compatible; `_id` (ObjectId) is serialized to string.
 *
 * Performance rules applied throughout:
 *  - lean() plain objects everywhere (no Mongoose document hydration).
 *  - passwordHash is excluded at the DB level except where login needs it.
 *  - Filters/sorts/limits run in MongoDB (indexed), never in JS over full
 *    collections. In-memory scans were removed (device lookup, list search,
 *    dashboard/profit rollups).
 *  - Independent queries run concurrently via Promise.all.
 *  - Heavy rollups (dashboard/profit) use single server-side aggregations.
 *  - Writes are single atomic ops (no read-before-write unless logic needs it).
 */
const { getModels, deviceKey } = require('./models');

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

function buildProfitShares(total, daily, weekly, withdrawnTotal, count, withdrawalCount) {
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
    count,
    withdrawalCount,
    people: shares,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Apply a just-recorded withdrawal to an existing profit snapshot without
 * re-querying the database. Totals/daily/weekly are untouched by a payout,
 * so the result is exactly what a recompute would return.
 */
function applyWithdrawalProfit(profit, sum) {
  const withdrawnTotal = Math.round((profit.withdrawnTotal + sum) * 100) / 100;
  return buildProfitShares(
    profit.total, profit.daily, profit.weekly,
    withdrawnTotal, profit.count, profit.withdrawalCount + 1
  );
}

/* ---------- pagination / search helpers ---------- */

function pageParams(input = {}, def = 200, max = 500) {
  let limit = Number(input.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = def;
  limit = Math.min(Math.max(1, Math.floor(limit)), max);
  let page = Number(input.page);
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.floor(page);
  return { page, limit, skip: (page - 1) * limit };
}

/** Indexed count when filtered; collection metadata count when unfiltered. */
async function fastCount(model, filter) {
  if (!filter || !Object.keys(filter).length) {
    try {
      return await model.estimatedDocumentCount();
    } catch {
      return model.countDocuments({});
    }
  }
  return model.countDocuments(filter);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ---------- atomic id counters ---------- */

async function nextId(kind) {
  const { OtpCounter } = await getModels();
  const doc = await OtpCounter.findOneAndUpdate(
    { kind },
    { $inc: { seq: 1 } },
    { returnDocument: 'after', upsert: true }
  ).lean();
  return doc.seq;
}

/* ---------- users ---------- */

const NO_HASH = '-passwordHash';

/** Fresh user for request gating. Hash excluded — none of the gates need it. */
async function findUserById(id) {
  const { OtpUser } = await getModels();
  return serialize(await OtpUser.findOne({ id: Number(id) }).select(NO_HASH).lean());
}

async function findUserRawById(id) {
  const { OtpUser } = await getModels();
  return OtpUser.findOne({ id: Number(id) });
}

/** Login path only — the password hash IS required for verification. */
async function findUserByLogin(login) {
  const { OtpUser } = await getModels();
  const key = String(login || '').trim().toLowerCase();
  if (!key) return null;
  const user = await OtpUser.findOne({
    $or: [{ email: key }, { phone: key }],
  }).lean();
  return serialize(user);
}

/** Duplicate-account check without fetching the whole document. */
async function loginExists(login) {
  const { OtpUser } = await getModels();
  const key = String(login || '').trim().toLowerCase();
  if (!key) return false;
  const hit = await OtpUser.exists({ $or: [{ email: key }, { phone: key }] });
  return !!hit;
}

async function userLoginExists(login) {
  return loginExists(login);
}

async function findUserByDeviceNorm(norm) {
  const { OtpUser } = await getModels();
  if (!norm) return null;
  const user = await OtpUser.findOne({ deviceIdNorm: norm, role: { $ne: 'admin' } }).select(NO_HASH).lean();
  return serialize(user);
}

/**
 * Indexed device lookup by normalized key (replaces the old full-collection
 * scan). Matches legacy rows too — deviceIdNorm is backfilled at boot.
 */
async function findUserByDevice(deviceId) {
  const { OtpUser } = await getModels();
  const norm = deviceKey(deviceId);
  if (!norm) return null;
  const user = await OtpUser.findOne({ deviceIdNorm: norm }).select(NO_HASH).lean();
  return serialize(user);
}

function userSearchFilter(search) {
  const base = { role: { $in: ['user', 'free'] } };
  const q = String(search || '').trim();
  if (!q) return base;
  const or = [
    { name: { $regex: escapeRegex(q), $options: 'i' } },
    { email: { $regex: escapeRegex(q), $options: 'i' } },
    { phone: { $regex: escapeRegex(q), $options: 'i' } },
  ];
  if (/^\d+$/.test(q)) or.push({ id: Number(q) });
  return { ...base, $or: or };
}

/**
 * DB-filtered, DB-sorted, paginated user list.
 * Default limit keeps admin UI behavior (sees everything at current scale).
 */
async function listUsers(search, opts = {}) {
  const { OtpUser } = await getModels();
  const { page, limit, skip } = pageParams(opts);
  const filter = userSearchFilter(search);
  const [users, total] = await Promise.all([
    OtpUser.find(filter).select(NO_HASH).sort({ id: -1 }).skip(skip).limit(limit).lean(),
    fastCount(OtpUser, filter),
  ]);
  return { users: serialize(users), total, page, limit, hasMore: skip + users.length < total };
}

async function createUser(data) {
  const { OtpUser } = await getModels();
  const id = await nextId('user');
  try {
    const doc = await OtpUser.create({ id, ...data });
    return serialize(doc.toObject());
  } catch (e) {
    if (e && e.code === 11000) {
      const err = new Error('Account already exists.');
      err.code = 'DUPLICATE_LOGIN';
      throw err;
    }
    throw e;
  }
}

async function updateUserById(id, patch) {
  const { OtpUser } = await getModels();
  const doc = await OtpUser.findOneAndUpdate({ id: Number(id) }, { $set: patch }, { returnDocument: 'after' }).select(NO_HASH).lean();
  return serialize(doc);
}

async function deleteUserById(id) {
  const { OtpUser } = await getModels();
  const doc = await OtpUser.findOneAndDelete({ id: Number(id), role: { $ne: 'admin' } }).lean();
  return serialize(doc);
}

async function countUsers() {
  const { OtpUser } = await getModels();
  return OtpUser.countDocuments({ role: { $in: ['user', 'free'] } });
}

/* ---------- packages ---------- */

async function listPackages(activeOnly) {
  const { OtpPackage } = await getModels();
  if (activeOnly) {
    // Covered by { status: 1, price: 1 } — filter + sort in the index.
    return serialize(await OtpPackage.find({ status: 'active' }).sort({ price: 1 }).lean());
  }
  return serialize(await OtpPackage.find({}).sort({ id: 1 }).lean());
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

/** Single atomic op (was read-then-write); null when missing. */
async function updatePackageById(id, patch) {
  const { OtpPackage } = await getModels();
  const doc = await OtpPackage.findOneAndUpdate(
    { id: Number(id) }, { $set: { ...patch, updatedAt: nowIso() } }, { returnDocument: 'after' }
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
  if (activeOnly) {
    // Covered by { status: 1, sortOrder: 1 }.
    return serialize(await OtpMethod.find({ status: 'active' }).sort({ sortOrder: 1 }).lean());
  }
  return serialize(await OtpMethod.find({}).sort({ sortOrder: 1 }).lean());
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

/** Single atomic op (was read-then-write); null when missing. */
async function updateMethodById(id, patch) {
  const { OtpMethod } = await getModels();
  const doc = await OtpMethod.findOneAndUpdate(
    { id: Number(id) }, { $set: { ...patch, updatedAt: nowIso() } }, { returnDocument: 'after' }
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

function paymentFilter({ status, search, before } = {}) {
  const filter = {};
  if (status) filter.status = String(status).toUpperCase();
  if (before !== undefined && before !== null && String(before).trim() !== '') {
    filter.id = { $lt: Number(before) };
  }
  if (search) {
    const q = String(search).trim();
    if (q) {
      const or = [
        { userName: { $regex: escapeRegex(q), $options: 'i' } },
        { transactionId: { $regex: escapeRegex(q), $options: 'i' } },
        { packageName: { $regex: escapeRegex(q), $options: 'i' } },
        { paymentMethodName: { $regex: escapeRegex(q), $options: 'i' } },
      ];
      if (/^\d+$/.test(q)) {
        const n = Number(q);
        or.push({ id: n }, { userId: n });
      }
      filter.$or = or;
    }
  }
  return filter;
}

/**
 * DB-filtered, DB-sorted ({ status: 1, id: -1 } / id index), paginated.
 * `before` enables cursor paging (id < before, newest first — no skip cost).
 */
async function listPayments({ status, search, page, limit, before } = {}) {
  const { OtpPayment } = await getModels();
  const pg = pageParams({ page, limit });
  const filter = paymentFilter({ status, search, before });
  const skip = before ? 0 : pg.skip;
  const [docs, total] = await Promise.all([
    OtpPayment.find(filter).sort({ id: -1 }).skip(skip).limit(pg.limit).lean(),
    fastCount(OtpPayment, filter),
  ]);
  return { payments: serialize(docs), total, page: before ? 1 : pg.page, limit: pg.limit, hasMore: before ? docs.length === pg.limit : skip + docs.length < total };
}

async function listUserPayments(userId, opts = {}) {
  const { OtpPayment } = await getModels();
  const pg = pageParams({ ...opts, limit: opts.limit ?? 200 });
  const filter = { userId: Number(userId) };
  const [docs, total] = await Promise.all([
    // Covered by { userId: 1, id: -1 }.
    OtpPayment.find(filter).sort({ id: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    fastCount(OtpPayment, filter),
  ]);
  return serialize(docs);
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
  return serialize(await OtpPayment.findOne({ transactionIdNorm: norm, status: { $ne: 'CANCELLED' } }).select({ _id: 1, id: 1 }).lean());
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
  const { OtpPayment, OtpUser, OtpPackage, OtpSubscription } = await getModels();
  const reviewedAt = nowIso();
  const payment = await OtpPayment.findOneAndUpdate(
    { id: Number(paymentId), status: 'PENDING' },
    { $set: { status: 'APPROVED', reviewedAt, reviewedBy: reviewerId } },
    { returnDocument: 'after' }
  ).lean();
  if (!payment) {
    const existing = await OtpPayment.findOne({ id: Number(paymentId) }).select({ status: 1 }).lean();
    const err = new Error(existing ? 'Payment has already been reviewed.' : 'Payment not found.');
    err.code = existing ? 'ALREADY_REVIEWED' : 'NOT_FOUND';
    err.status = existing ? existing.status : null;
    throw err;
  }
  // Independent reads, concurrently.
  const [userDoc, pkgDoc] = await Promise.all([
    OtpUser.findOne({ id: payment.userId }),
    OtpPackage.findOne({ id: payment.packageId }).lean(),
  ]);
  if (!userDoc) {
    const err = new Error('User not found.');
    err.code = 'USER_NOT_FOUND';
    throw err;
  }
  if (!pkgDoc) {
    const err = new Error('Package no longer exists.');
    err.code = 'PACKAGE_GONE';
    throw err;
  }
  const { start, expire } = activationWindow(userDoc.toObject(), pkgDoc.durationDays, Date.now());
  const startIso = new Date(start).toISOString();
  const expireIso = new Date(expire).toISOString();
  // Single atomic user update (was fetch-mutate-save round trips).
  const updatedUser = await OtpUser.findOneAndUpdate(
    { id: userDoc.id },
    {
      $set: {
        currentPackageId: pkgDoc.id,
        currentPackageName: pkgDoc.name,
        packageStartDate: startIso,
        packageExpireDate: expireIso,
        ...(userDoc.status !== 'active' ? { status: 'active' } : {}),
      },
    },
    { returnDocument: 'after' }
  ).select(NO_HASH).lean();
  const subId = await nextId('subscription');
  const sub = await OtpSubscription.create({
    id: subId,
    userId: userDoc.id,
    packageId: pkgDoc.id,
    packageName: pkgDoc.name,
    price: payment.amount,
    durationDays: pkgDoc.durationDays,
    startDate: startIso,
    expireDate: expireIso,
    status: 'active',
    paymentRequestId: payment.id,
    createdAt: nowIso(),
    createdBy: reviewerId,
    deviceId: userDoc.deviceIdNorm || userDoc.deviceId || null,
  });
  return { payment: serialize(payment), subscription: serialize(sub.toObject()), user: publicUser(updatedUser) };
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
    { returnDocument: 'after' }
  ).lean();
  if (!payment) {
    const existing = await OtpPayment.findOne({ id: Number(paymentId) }).select({ status: 1 }).lean();
    const err = new Error(existing ? 'Payment has already been reviewed.' : 'Payment not found.');
    err.code = existing ? 'ALREADY_REVIEWED' : 'NOT_FOUND';
    err.status = existing ? existing.status : null;
    throw err;
  }
  return serialize(payment);
}

/* ---------- subscriptions ---------- */

async function listUserSubscriptions(userId, opts = {}) {
  const { OtpSubscription } = await getModels();
  const pg = pageParams({ ...opts, limit: opts.limit ?? 200 });
  // Covered by { userId: 1, id: -1 }.
  const docs = await OtpSubscription.find({ userId: Number(userId) }).sort({ id: -1 }).skip(pg.skip).limit(pg.limit).lean();
  return serialize(docs);
}

async function listAllSubscriptions(opts = {}) {
  const { OtpSubscription } = await getModels();
  const pg = pageParams(opts);
  const [docs, total] = await Promise.all([
    OtpSubscription.find({}).sort({ id: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    fastCount(OtpSubscription, {}),
  ]);
  return { subscriptions: serialize(docs), total, page: pg.page, limit: pg.limit, hasMore: pg.skip + docs.length < total };
}

async function createSubscription(data) {
  const { OtpSubscription } = await getModels();
  const id = await nextId('subscription');
  const doc = await OtpSubscription.create({ id, ...data });
  return serialize(doc.toObject());
}

/* ---------- notifications / fcm / versions ---------- */

async function listNotifications(opts = {}) {
  const { OtpNotification } = await getModels();
  const pg = pageParams({ ...opts, limit: opts.limit ?? 100, page: opts.page ?? 1 }, 100);
  const [docs, total] = await Promise.all([
    OtpNotification.find({}).sort({ id: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    fastCount(OtpNotification, {}),
  ]);
  return { notifications: serialize(docs), total, page: pg.page, limit: pg.limit, hasMore: pg.skip + docs.length < total };
}

async function countUnreadNotifications() {
  const { OtpNotification } = await getModels();
  // Covered by { read: 1, id: -1 } prefix.
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

/**
 * App-version config is tiny and read on every app start but changes almost
 * never. Short TTL cache (60s) with invalidation on write — reads stay live
 * enough for update prompts while skipping a DB round trip on hot paths.
 */
const VERSION_TTL_MS = 60 * 1000;
let versionCache = { at: 0, docs: null };
function clearVersionCache() {
  versionCache = { at: 0, docs: null };
}

async function listVersions() {
  if (versionCache.docs && Date.now() - versionCache.at < VERSION_TTL_MS) return versionCache.docs;
  const { OtpVersion } = await getModels();
  const docs = serialize(await OtpVersion.find({}).lean());
  versionCache = { at: Date.now(), docs };
  return docs;
}

async function findVersion(platform) {
  const plat = String(platform || 'android').toLowerCase();
  const all = await listVersions();
  return all.find((v) => String(v.platform).toLowerCase() === plat) || null;
}

async function findFirstVersion() {
  const all = await listVersions();
  return all[0] || null;
}

async function upsertVersion(platform, patch) {
  const { OtpVersion } = await getModels();
  const plat = String(platform || 'android').toLowerCase();
  // Update-first: the common case is a single atomic op.
  const updated = await OtpVersion.findOneAndUpdate(
    { platform: plat }, { $set: { ...patch, updatedAt: nowIso() } }, { returnDocument: 'after' }
  ).lean();
  clearVersionCache();
  if (updated) return serialize(updated);
  const id = await nextId('appVersion');
  try {
    const created = await OtpVersion.create({
      id, platform: plat, latestVersion: '1.0.0', minimumSupportedVersion: '1.0.0',
      updateRequired: false, updateUrl: '', message: '', updatedAt: nowIso(), ...patch,
    });
    return serialize(created.toObject());
  } catch (e) {
    if (e && e.code === 11000) {
      // Lost a create race — read back the winner.
      const winner = await OtpVersion.findOneAndUpdate(
        { platform: plat }, { $set: { ...patch, updatedAt: nowIso() } }, { returnDocument: 'after' }
      ).lean();
      return serialize(winner);
    }
    throw e;
  }
}

/* ---------- withdrawals + profit (aggregation, no full scans) ---------- */

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Single server-side pass over payments: status counts + revenue (for the
 * dashboard) and daily/weekly/total APPROVED sums (for profit). $match first,
 * no documents cross the wire.
 */
async function paymentRollup() {
  const { OtpPayment } = await getModels();
  const nowMs = Date.now();
  const todayStr = new Date(nowMs).toISOString().slice(0, 10);
  const rows = await OtpPayment.aggregate([
    {
      $facet: {
        byStatus: [
          { $match: { status: { $in: ['PENDING', 'APPROVED', 'REJECTED'] } } },
          { $group: { _id: '$status', n: { $sum: 1 }, rev: { $sum: '$amount' } } },
        ],
        profit: [
          { $match: { status: 'APPROVED' } },
          {
            $project: {
              amount: 1,
              ts: {
                $dateFromString: {
                  dateString: { $ifNull: ['$reviewedAt', '$submittedAt'] },
                  onError: null,
                  onNull: null,
                },
              },
            },
          },
          {
            $group: {
              _id: null,
              n: { $sum: 1 },
              total: { $sum: '$amount' },
              daily: {
                $sum: {
                  $cond: [
                    { $eq: [{ $dateToString: { format: '%Y-%m-%d', date: '$ts' } }, todayStr] },
                    '$amount',
                    0,
                  ],
                },
              },
              weekly: {
                $sum: { $cond: [{ $lte: [{ $subtract: ['$$NOW', '$ts'] }, WEEK_MS] }, '$amount', 0] },
              },
            },
          },
        ],
      },
    },
  ]);
  const facet = (rows && rows[0]) || { byStatus: [], profit: [] };
  const byStatus = {};
  for (const r of facet.byStatus || []) byStatus[r._id] = { n: r.n || 0, rev: r.rev || 0 };
  return {
    byStatus,
    profit: (facet.profit || [])[0] || null,
  };
}

async function withdrawalRollup() {
  const { OtpWithdrawal } = await getModels();
  const rows = await OtpWithdrawal.aggregate([
    { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$amount' } } },
  ]);
  const r = rows[0] || {};
  return { n: r.n || 0, total: r.total || 0 };
}

async function profitSummary() {
  const [pay, wd] = await Promise.all([paymentRollup(), withdrawalRollup()]);
  const p = pay.profit || {};
  return buildProfitShares(
    p.total || 0, p.daily || 0, p.weekly || 0,
    wd.total, p.n || 0, wd.n
  );
}

async function dashboardStats() {
  const { OtpUser, OtpPayment } = await getModels();
  const nowStr = nowIso();
  // One payment pipeline (status counts + profit, no doc transfer) plus
  // metadata/indexed counts — all concurrently. totalPayments uses
  // collection metadata (O(1)) instead of scanning.
  const [pay, totalPayments, totalUsers, activeUsers, wd] = await Promise.all([
    paymentRollup(),
    OtpPayment.estimatedDocumentCount().catch(() => OtpPayment.countDocuments({})),
    OtpUser.countDocuments({ role: { $in: ['user', 'free'] } }),
    OtpUser.countDocuments({
      role: { $in: ['user', 'free'] },
      currentPackageId: { $ne: null },
      packageExpireDate: { $gt: nowStr },
    }),
    withdrawalRollup(),
  ]);
  const st = (k) => (pay.byStatus[k] ? pay.byStatus[k].n : 0);
  const p = pay.profit || {};
  const profit = buildProfitShares(p.total || 0, p.daily || 0, p.weekly || 0, wd.total, p.n || 0, wd.n);
  return {
    stats: {
      totalPayments,
      pending: st('PENDING'),
      approved: st('APPROVED'),
      rejected: st('REJECTED'),
      approvedRevenue: pay.byStatus.APPROVED ? pay.byStatus.APPROVED.rev : 0,
      activeSubscriptions: activeUsers,
      expiredSubscriptions: Math.max(0, totalUsers - activeUsers),
      totalUsers,
      dailyProfit: profit.daily, weeklyProfit: profit.weekly, totalProfit: profit.total,
      withdrawnTotal: profit.withdrawnTotal, remainingProfit: profit.remaining,
      withdrawalCount: profit.withdrawalCount,
    },
    profit,
  };
}

/* ---------- withdrawals list ---------- */

async function listWithdrawals(opts = {}) {
  const { OtpWithdrawal } = await getModels();
  const pg = pageParams(opts);
  const [docs, total] = await Promise.all([
    OtpWithdrawal.find({}).sort({ id: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    fastCount(OtpWithdrawal, {}),
  ]);
  return { withdrawals: serialize(docs), total, page: pg.page, limit: pg.limit, hasMore: pg.skip + docs.length < total };
}

async function createWithdrawal(data) {
  const { OtpWithdrawal } = await getModels();
  const id = await nextId('withdrawal');
  const doc = await OtpWithdrawal.create({ id, ...data });
  return serialize(doc.toObject());
}

/* ---------- idempotency ---------- */

async function findPaymentIdByIdemKey(key) {
  if (!key) return null;
  const { OtpIdemKey } = await getModels();
  const row = await OtpIdemKey.findOne({ key: String(key) }).select({ paymentId: 1 }).lean();
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

/* ---------- received bKash SMS payments (Recive payment app) ---------- */

function normalizeRecvTrx(s) {
  return String(s || '').trim().toUpperCase().replace(/[\s-]+/g, '');
}

function validateReceivedPayload(b) {
  const errs = [];
  const amount = Number(b && b.amount);
  if (!Number.isFinite(amount) || amount <= 0) errs.push('amount must be a positive number.');
  const trxId = String((b && (b.trxId || b.transactionId)) || '').trim();
  if (!/^[A-Z0-9]{6,20}$/i.test(trxId)) errs.push('trxId must be 6-20 alphanumeric characters.');
  const sender = String((b && b.sender) || '').trim();
  if (sender && !/^[0-9+]{6,16}$/.test(sender.replace(/[\s-]/g, ''))) errs.push('sender must be a phone number.');
  if (b && b.transactionDate !== undefined && b.transactionDate !== null && String(b.transactionDate).trim() !== '') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.transactionDate).trim()) && !/^\d{2}\/\d{2}\/\d{4}$/.test(String(b.transactionDate).trim())) {
      errs.push('transactionDate must be YYYY-MM-DD or DD/MM/YYYY.');
    }
  }
  return { errs, amount, trxId, sender };
}

async function createReceivedPayment(data) {
  const { OtpReceivedPayment } = await getModels();
  const norm = normalizeRecvTrx(data.trxId);
  const existing = await OtpReceivedPayment.findOne({ trxIdNorm: norm }).lean();
  if (existing) {
    return { doc: serialize(existing), duplicate: true };
  }
  const id = await nextId('receivedPayment');
  try {
    const doc = await OtpReceivedPayment.create({
      id,
      amount: data.amount,
      sender: data.sender || '',
      fee: data.fee !== undefined && data.fee !== null ? Number(data.fee) : 0,
      balance: data.balance !== undefined && data.balance !== null && data.balance !== '' ? Number(data.balance) : null,
      trxId: String(data.trxId).trim().toUpperCase(),
      trxIdNorm: norm,
      transactionDate: data.transactionDate || null,
      transactionTime: data.transactionTime || null,
      originalMessage: String(data.originalMessage || '').slice(0, 2000),
      receivedAt: data.receivedAt || nowIso(),
      deviceInfo: String(data.deviceInfo || '').slice(0, 500),
      source: String(data.source || 'bkash_sms').slice(0, 50),
      status: 'pending',
      matchedPaymentId: null,
      verifiedBy: null,
      verifiedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    return { doc: serialize(doc.toObject()), duplicate: false };
  } catch (e) {
    if (e && e.code === 11000) {
      const winner = await OtpReceivedPayment.findOne({ trxIdNorm: norm }).lean();
      return { doc: serialize(winner), duplicate: true };
    }
    throw e;
  }
}

async function findReceivedByTrx(trxId) {
  const { OtpReceivedPayment } = await getModels();
  const norm = normalizeRecvTrx(trxId);
  if (!norm) return null;
  return serialize(await OtpReceivedPayment.findOne({ trxIdNorm: norm }).lean());
}

function receivedFilter({ status, search, date, sender } = {}) {
  const filter = {};
  if (status) filter.status = String(status).toLowerCase();
  if (date) filter.transactionDate = String(date).trim();
  if (sender) filter.sender = { $regex: escapeRegex(String(sender).trim()), $options: 'i' };
  if (search) {
    const q = String(search).trim();
    if (q) {
      filter.$or = [
        { trxId: { $regex: escapeRegex(q), $options: 'i' } },
        { trxIdNorm: { $regex: escapeRegex(q.toUpperCase()), $options: 'i' } },
        { sender: { $regex: escapeRegex(q), $options: 'i' } },
      ];
    }
  }
  return filter;
}

async function listReceivedPayments(opts = {}) {
  const { OtpReceivedPayment } = await getModels();
  const pg = pageParams(opts);
  const filter = receivedFilter(opts);
  const [docs, total] = await Promise.all([
    OtpReceivedPayment.find(filter).sort({ id: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    fastCount(OtpReceivedPayment, filter),
  ]);
  return { payments: serialize(docs), total, page: pg.page, limit: pg.limit, hasMore: pg.skip + docs.length < total };
}

/**
 * Verify a customer-submitted TrxID against the received_payments collection.
 * Never trusts the client: the SMS record must exist, and the amount must
 * match (within tolerance) when an expected amount is supplied.
 */
async function verifyReceivedPayment(trxId, expectedAmount, actorId) {
  const { OtpReceivedPayment } = await getModels();
  const norm = normalizeRecvTrx(trxId);
  if (!norm) {
    const err = new Error('trxId is required.');
    err.code = 'BAD_TRX';
    throw err;
  }
  const rec = await OtpReceivedPayment.findOne({ trxIdNorm: norm }).lean();
  if (!rec) {
    return { found: false, payment: null };
  }
  let amountOk = true;
  if (expectedAmount !== undefined && expectedAmount !== null && String(expectedAmount).trim() !== '') {
    const exp = Number(expectedAmount);
    amountOk = Number.isFinite(exp) && Math.abs(Number(rec.amount) - exp) < 0.005;
  }
  if (amountOk && rec.status === 'pending') {
    const updated = await OtpReceivedPayment.findOneAndUpdate(
      { _id: rec._id, status: 'pending' },
      { $set: { status: 'verified', verifiedBy: actorId || null, verifiedAt: nowIso(), updatedAt: nowIso() } },
      { returnDocument: 'after' }
    ).lean();
    return { found: true, amountOk, payment: serialize(updated || rec) };
  }
  return { found: true, amountOk, payment: serialize(rec) };
}

async function setReceivedStatus(trxId, status, actorId, matchedPaymentId) {
  const { OtpReceivedPayment } = await getModels();
  const allowed = ['pending', 'verified', 'used', 'rejected'];
  const want = String(status || '').toLowerCase();
  if (!allowed.includes(want)) {
    const err = new Error('status must be one of: ' + allowed.join(', '));
    err.code = 'BAD_STATUS';
    throw err;
  }
  const patch = { status: want, updatedAt: nowIso() };
  if (want === 'verified' || want === 'used') {
    patch.verifiedBy = actorId || null;
    patch.verifiedAt = nowIso();
  }
  if (matchedPaymentId !== undefined && matchedPaymentId !== null && String(matchedPaymentId).trim() !== '') {
    patch.matchedPaymentId = Number(matchedPaymentId);
  }
  const doc = await OtpReceivedPayment.findOneAndUpdate(
    { trxIdNorm: normalizeRecvTrx(trxId) }, { $set: patch }, { returnDocument: 'after' }
  ).lean();
  return serialize(doc);
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
  normalizeTxid, normalizeDeviceId, deviceKey, nowIso, cmpVersions, publicUser,
  profitConfig, profitSummary, applyWithdrawalProfit, serialize,
  // counters
  nextId,
  // users
  findUserById, findUserRawById, findUserByLogin, userLoginExists, loginExists,
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
  addFcmToken, countFcmTokens, listVersions, findVersion, findFirstVersion, upsertVersion,
  clearVersionCache,
  // withdrawals / profit
  listWithdrawals, createWithdrawal, dashboardStats,
  // idempotency
  findPaymentIdByIdemKey, saveIdemKey,
  // received bKash payments
  normalizeRecvTrx, validateReceivedPayload, createReceivedPayment,
  findReceivedByTrx, listReceivedPayments, verifyReceivedPayment, setReceivedStatus,
  // misc
  activationWindow,
};
