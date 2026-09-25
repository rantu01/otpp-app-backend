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
const crypto = require('crypto');

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

const REFERRAL_REQUIRED = Math.max(1, Number(process.env.REFERRAL_REQUIRED || 4));
const REFERRER_REWARD_DAYS = Math.max(1, Number(process.env.REFERRER_REWARD_DAYS || 5));
const REFERRED_REWARD_DAYS = Math.max(1, Number(process.env.REFERRED_REWARD_DAYS || 3));

function referralConfig() {
  return {
    enabled: String(process.env.REFERRAL_ENABLED || 'true').toLowerCase() !== 'false',
    requiredReferrals: REFERRAL_REQUIRED,
    referrerRewardDays: REFERRER_REWARD_DAYS,
    referredRewardDays: REFERRED_REWARD_DAYS,
  };
}

function makeReferralCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let code = 'OTP';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return code;
}

async function uniqueReferralCode() {
  const { OtpUser } = await getModels();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = makeReferralCode();
    if (!(await OtpUser.exists({ referralCode: code }))) return code;
  }
  throw new Error('Could not generate a unique referral code.');
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

async function findUserByReferralCode(code) {
  const { OtpUser } = await getModels();
  const value = String(code || '').trim().toUpperCase();
  if (!value) return null;
  return serialize(await OtpUser.findOne({ referralCode: value, role: { $ne: 'admin' } }).select(NO_HASH).lean());
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
    const doc = await OtpUser.create({ id, ...data, referralCode: data.referralCode || await uniqueReferralCode() });
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

async function createReferral(data) {
  const { OtpReferral } = await getModels();
  try {
    const doc = await OtpReferral.create({ ...data, referralCode: String(data.referralCode || '').toUpperCase() });
    return { ...serialize(doc.toObject()), created: true };
  } catch (e) {
    if (e && e.code === 11000) return { ...serialize(await OtpReferral.findOne({ referrerUserId: data.referrerUserId, referredUserId: data.referredUserId }).lean()), created: false };
    throw e;
  }
}

async function verifyReferralForUser(referredUserId) {
  const config = referralConfig();
  if (!config.enabled) return { verified: false, reason: 'DISABLED' };
  const { OtpReferral, OtpUser } = await getModels();
  const referral = await OtpReferral.findOneAndUpdate(
    { referredUserId: Number(referredUserId), status: 'pending', rewardGranted: false },
    { $set: { status: 'verified', verifiedAt: nowIso() } },
    { returnDocument: 'after', updatePipeline: true }
  ).lean();
  if (!referral) return { verified: false, reason: 'ALREADY_VERIFIED' };

  const referred = await OtpUser.findOneAndUpdate(
    { id: Number(referredUserId), referredBy: Number(referral.referrerUserId) },
    [
      { $set: {
        freeTrialDays: { $add: [{ $ifNull: ['$freeTrialDays', 0] }, config.referredRewardDays] },
        freeTrialExpiresAt: {
          $dateToString: {
            date: { $add: [
              { $cond: [
                { $gt: [
                  { $convert: { input: '$freeTrialExpiresAt', to: 'date', onError: new Date(0), onNull: new Date(0) } },
                  '$$NOW',
                ] },
                { $convert: { input: '$freeTrialExpiresAt', to: 'date', onError: new Date(0), onNull: new Date(0) } },
                '$$NOW',
              ] },
              config.referredRewardDays * 86400000,
            ] },
            format: '%Y-%m-%dT%H:%M:%S.%LZ',
          },
        },
      } },
    ],
    { returnDocument: 'after', updatePipeline: true }
  ).select(NO_HASH).lean();
  if (!referred) return { verified: false, reason: 'REFERRED_USER_CHANGED' };

  const referrer = await OtpUser.findOneAndUpdate(
    { id: Number(referral.referrerUserId) },
    { $inc: { successfulReferralCount: 1 } },
    { returnDocument: 'after' }
  ).select(NO_HASH).lean();
  if (!referrer) return { verified: false, reason: 'REFERRER_NOT_FOUND' };

  const milestone = Math.floor(Number(referrer.successfulReferralCount || 0) / config.requiredReferrals);
  let reward = null;
  if (milestone > Number(referrer.referralRewardCount || 0)) {
    reward = await OtpUser.findOneAndUpdate(
      { id: Number(referrer.id), referralRewardCount: { $lt: milestone } },
      [
        { $set: {
          referralRewardCount: { $add: ['$referralRewardCount', 1] },
          freeTrialDays: { $add: ['$freeTrialDays', config.referrerRewardDays] },
          freeTrialExpiresAt: {
            $dateToString: {
              date: { $add: [
                { $cond: [
                  { $gt: [
                    { $convert: { input: '$freeTrialExpiresAt', to: 'date', onError: new Date(0), onNull: new Date(0) } },
                    '$$NOW',
                  ] },
                  { $convert: { input: '$freeTrialExpiresAt', to: 'date', onError: new Date(0), onNull: new Date(0) } },
                  '$$NOW',
                ] },
                config.referrerRewardDays * 86400000,
              ] },
              format: '%Y-%m-%dT%H:%M:%S.%LZ',
            },
          },
        } },
      ],
      { returnDocument: 'after', updatePipeline: true }
    ).select(NO_HASH).lean();
    if (reward) {
      const milestoneRows = await OtpReferral.find({ referrerUserId: referrer.id, status: 'verified', rewardGranted: false })
        .sort({ verifiedAt: 1 }).limit(config.requiredReferrals).select({ _id: 1 }).lean();
      if (milestoneRows.length === config.requiredReferrals) {
        await OtpReferral.updateMany(
          { _id: { $in: milestoneRows.map((row) => row._id) } },
          { $set: { status: 'rewarded', rewardGranted: true, rewardGrantedAt: nowIso() } }
        ).catch(() => null);
      }
    }
  }
  return { verified: true, referral: serialize(referral), referred: serialize(referred), referrer: serialize(reward || referrer), rewardGranted: !!reward };
}

async function getMyReferral(userId) {
  const { OtpUser, OtpReferral } = await getModels();
  const [user, referrals] = await Promise.all([
    OtpUser.findOne({ id: Number(userId) }).select(NO_HASH).lean(),
    OtpReferral.find({ referrerUserId: Number(userId) }).sort({ createdAt: -1 }).lean(),
  ]);
  const config = referralConfig();
  const count = Number(user && user.successfulReferralCount || 0);
  const totalRewards = Number(user && user.referralRewardCount || 0);
  const freeTrialDays = Number(user && user.freeTrialDays || 0);
  const rewardMessage = user && user.referredBy && freeTrialDays > 0
    ? `You joined through a referral and received ${REFERRED_REWARD_DAYS} free days.`
    : totalRewards > 0
      ? `Congratulations! You completed ${totalRewards * config.requiredReferrals} referrals and received ${totalRewards * config.referrerRewardDays} free days.`
      : '';
  return {
    referralCode: user && user.referralCode || null,
    referralCount: Number(user && user.referralCount || 0),
    successfulReferralCount: count,
    requiredReferrals: config.requiredReferrals,
    remainingReferrals: Math.max(0, config.requiredReferrals - (count % config.requiredReferrals)),
    rewardDays: config.referrerRewardDays,
    totalRewards,
    freeTrialDays,
    freeTrialExpiresAt: user && user.freeTrialExpiresAt || null,
    rewardMessage,
    referrals: serialize(referrals),
  };
}

async function listReferrals(opts = {}) {
  const { OtpReferral, OtpUser } = await getModels();
  const pg = pageParams(opts, 50, 100);
  const filter = {};
  if (opts.status && ['pending', 'verified', 'rewarded', 'rejected'].includes(String(opts.status))) filter.status = String(opts.status);
  const search = String(opts.search || '').trim();
  if (search) {
    const userOr = [
      { name: { $regex: escapeRegex(search), $options: 'i' } },
      { email: { $regex: escapeRegex(search), $options: 'i' } },
      { phone: { $regex: escapeRegex(search), $options: 'i' } },
    ];
    if (/^\d+$/.test(search)) userOr.push({ id: Number(search) });
    const matchingUsers = await OtpUser.find({ $or: userOr }).select({ id: 1 }).lean();
    const ids = matchingUsers.map((user) => user.id);
    filter.$or = [{ referralCode: { $regex: escapeRegex(search), $options: 'i' } }, { referrerUserId: { $in: ids } }, { referredUserId: { $in: ids } }];
  }
  const [rows, total] = await Promise.all([
    OtpReferral.find(filter).sort({ createdAt: -1 }).skip(pg.skip).limit(pg.limit).lean(),
    fastCount(OtpReferral, filter),
  ]);
  const ids = [...new Set(rows.flatMap((r) => [r.referrerUserId, r.referredUserId]))];
  const users = await OtpUser.find({ id: { $in: ids } }).select({ passwordHash: 0 }).lean();
  const byId = new Map(users.map((u) => [u.id, u]));
  return { referrals: rows.map((r) => ({ ...serialize(r), referrer: publicUser(byId.get(r.referrerUserId)), referred: publicUser(byId.get(r.referredUserId)) })), total, page: pg.page, limit: pg.limit, hasMore: pg.skip + rows.length < total };
}

async function referralStats() {
  const { OtpReferral, OtpUser } = await getModels();
  const [totalUsers, joined, successful, rewards, days] = await Promise.all([
    OtpUser.countDocuments({ role: { $in: ['user', 'free'] } }),
    OtpReferral.countDocuments({}),
    OtpReferral.countDocuments({ status: { $in: ['verified', 'rewarded'] } }),
    OtpUser.aggregate([{ $group: { _id: null, count: { $sum: '$referralRewardCount' }, days: { $sum: '$freeTrialDays' } } }]),
    OtpUser.find({ role: { $in: ['user', 'free'] }, successfulReferralCount: { $gt: 0 } }).select({ id: 1, name: 1, referralCode: 1, successfulReferralCount: 1, referralRewardCount: 1 }).sort({ successfulReferralCount: -1 }).limit(10).lean(),
  ]);
  const totals = rewards[0] || { count: 0, days: 0 };
  return { totalUsers, joinedThroughReferrals: joined, successfulReferrals: successful, totalReferralRewards: totals.count || 0, totalFreeDaysDistributed: totals.days || 0, topReferrers: serialize(days), config: referralConfig() };
}

async function updateUserById(id, patch) {
  const { OtpUser } = await getModels();
  const doc = await OtpUser.findOneAndUpdate({ id: Number(id) }, { $set: patch }, { returnDocument: 'after' }).select(NO_HASH).lean();
  return serialize(doc);
}

async function incrementUserCounters(id, increments) {
  const { OtpUser } = await getModels();
  const doc = await OtpUser.findOneAndUpdate(
    { id: Number(id) },
    { $inc: increments },
    { returnDocument: 'after' }
  ).select(NO_HASH).lean();
  return serialize(doc);
}

async function deleteUserById(id) {
  const { OtpUser } = await getModels();
  const doc = await OtpUser.findOneAndDelete({ id: Number(id), role: { $ne: 'admin' } }).lean();
  return serialize(doc);
}

/** Password-only update: the login identity (email/phone) is never touched. */
async function updateUserPassword(id, passwordHash) {
  const { OtpUser } = await getModels();
  const doc = await OtpUser.findOneAndUpdate(
    { id: Number(id) },
    { $set: { passwordHash: String(passwordHash) } },
    { returnDocument: 'after' }
  ).select(NO_HASH).lean();
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
async function approvePaymentAtomic(paymentId, reviewerId, opts) {
  const { OtpPayment, OtpUser, OtpPackage, OtpSubscription } = await getModels();
  const reviewedAt = nowIso();
  const auto = !!(opts && opts.auto);
  const payment = await OtpPayment.findOneAndUpdate(
    { id: Number(paymentId), status: 'PENDING' },
    {
      $set: {
        status: 'APPROVED',
        reviewedAt,
        reviewedBy: reviewerId,
        autoVerified: auto,
        // Manual review supersedes any earlier auto-verify note; an
        // auto-approval records its own positive note below.
        verifyNote: null,
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
    // subscriptions.createdBy is numeric (admin id) — AUTO approvals store null.
    createdBy: typeof reviewerId === 'number' ? reviewerId : null,
    deviceId: userDoc.deviceIdNorm || userDoc.deviceId || null,
  });
  await verifyReferralForUser(userDoc.id);
  // Auto-approvals stamp a positive note (manual approvals cleared any
  // stale auto-verify note in the $set above, so they stay null).
  let outPayment = serialize(payment);
  if (auto) {
    try {
      const note = `Payment verified automatically. TrxID ${payment.transactionId} matched bKash SMS record.`;
      await OtpPayment.updateOne({ id: payment.id }, { $set: { verifyNote: note } });
      outPayment.verifyNote = note;
    } catch (e) {
      console.warn('[approve] auto note skipped:', e && e.message);
    }
  }
  return { payment: outPayment, subscription: serialize(sub.toObject()), user: publicUser(updatedUser) };
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
        // A human decision supersedes any earlier auto-verify note.
        verifyNote: null,
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
      id, platform: plat, latestVersion: '1.0.0', latestVersionCode: 1, minimumSupportedVersion: '1.0.0',
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

/* ---------- auto-verify: match customer payments against SMS records ---------- */

/** PENDING customer payments claiming one bKash TrxID (normally 0-1 rows). */
async function findPendingPaymentsByTxNorm(norm) {
  const { OtpPayment } = await getModels();
  const n = normalizeTxid(norm);
  if (!n) return [];
  return serialize(await OtpPayment.find({ transactionIdNorm: n, status: 'PENDING' }).sort({ id: 1 }).lean());
}

function isBkashMethod(payment) {
  return /bkash/i.test(String((payment && payment.paymentMethodName) || ''));
}

/**
 * Automatic approval rule — TrxID match PLUS amount match are both required:
 *   received_payments.trxIdNorm === payments.transactionIdNorm
 *   AND |received.amount - payment.amount| < 0.005
 * A record is claimable only while UNMATCHED: status pending/verified AND
 * no matchedPaymentId yet (Mongo null-match covers both null and missing).
 * Amount is checked BEFORE claiming so a wrong-amount SMS is never consumed:
 * mismatches stay PENDING with an explanatory note for manual review.
 *
 * Returns { outcome, payment } with outcome one of:
 *   not_found | already_used | amount_mismatch | claimed
 * The claim is a single atomic compare-and-swap
 * (-> verified + matchedPaymentId + verifiedBy AUTO), so two racers for
 * the same TrxID cannot both win, and an already-matched record is never
 * reassigned to another payment. No new received_payments record is created.
 */
async function claimReceivedForPayment(trxNorm, paymentId, expectedAmount) {
  const { OtpReceivedPayment } = await getModels();
  const norm = normalizeRecvTrx(trxNorm);
  if (!norm) return { outcome: 'not_found', payment: null };
  const rec = await OtpReceivedPayment.findOne({ trxIdNorm: norm }).lean();
  if (!rec) return { outcome: 'not_found', payment: null };
  if (rec.matchedPaymentId !== undefined && rec.matchedPaymentId !== null) {
    return { outcome: 'already_used', payment: serialize(rec) };
  }
  // Backend amount verification: the SMS amount must equal the package price
  // the customer is claiming. E.g. package 100 BDT vs SMS 40 BDT -> reject.
  if (expectedAmount !== undefined && expectedAmount !== null && String(expectedAmount).trim() !== '') {
    const exp = Number(expectedAmount);
    if (Number.isFinite(exp) && Math.abs(Number(rec.amount) - exp) >= 0.005) {
      return { outcome: 'amount_mismatch', payment: serialize(rec) };
    }
  }
  const updated = await OtpReceivedPayment.findOneAndUpdate(
    {
      _id: rec._id,
      status: { $in: ['pending', 'verified'] },
      // Re-check unmatched inside the atomic op: a record matched between
      // our read and this write loses the race instead of being reassigned.
      $or: [{ matchedPaymentId: null }, { matchedPaymentId: { $exists: false } }],
    },
    {
      $set: {
        status: 'verified',
        matchedPaymentId: paymentId,
        verifiedBy: 'AUTO',
        verifiedAt: nowIso(),
        updatedAt: nowIso(),
      },
    },
    { returnDocument: 'after' }
  ).lean();
  if (!updated) {
    const cur = await OtpReceivedPayment.findOne({ _id: rec._id }).lean();
    return { outcome: 'already_used', payment: serialize(cur) };
  }
  return { outcome: 'claimed', payment: serialize(updated) };
}

/**
 * Persist the auto-verify reason on a still-PENDING payment so admins (and
 * API clients) can see WHY it was (not) auto-approved. The PENDING filter
 * guarantees a later manual approve/reject is never clobbered.
 */
async function stampVerifyNote(paymentId, note) {
  if (!note) return;
  try {
    const { OtpPayment } = await getModels();
    await OtpPayment.updateOne(
      { id: Number(paymentId), status: 'PENDING' },
      { $set: { verifyNote: String(note).slice(0, 500) } }
    );
  } catch (e) {
    console.warn('[auto-verify] note skipped:', e && e.message);
  }
}

/**
 * Try to auto-verify one PENDING payment: claim the matching SMS record and,
 * on success, approve through the same atomic path as manual approval
 * (subscription activation included), flagged autoVerified: true.
 * Anything else (no record yet, amount mismatch, non-bKash method, lost
 * race) leaves the payment PENDING for manual review — never auto-rejects.
 */
async function tryAutoApprove(payment) {
  const tid = payment && (payment.transactionIdNorm || payment.transactionId);
  const log = (msg) => console.log(`[PAYMENT AUTO VERIFY] ${msg}`);
  try {
    if (!payment || payment.status !== 'PENDING') {
      // Safety: an already-approved payment is never processed again.
      if (payment && payment.status === 'APPROVED') log(`Payment already approved (payment #${payment.id}, tid=${tid})`);
      return { auto: false, outcome: 'not_pending', payment, note: null };
    }
    if (!isBkashMethod(payment)) {
      log(`tid=${tid} skipped: payment method is not bKash (${(payment && payment.paymentMethodName) || '?'})`);
      return { auto: false, outcome: 'not_bkash', payment, note: null };
    }
    log(`Searching received_payments.trxIdNorm = ${tid}`);
    const claim = await claimReceivedForPayment(payment.transactionIdNorm, payment.id, payment.amount);
    if (claim.outcome !== 'claimed') {
      if (claim.outcome === 'amount_mismatch') {
        const smsAmt = claim.payment ? claim.payment.amount : '?';
        const note = `Amount mismatch: this TrxID was paid Tk ${smsAmt} but the package costs Tk ${payment.amount}. Manual review required.`;
        log(`tid=${tid} amount mismatch (sms=${smsAmt} vs package=${payment.amount}) — staying PENDING`);
        await stampVerifyNote(payment.id, note);
        payment = { ...payment, verifyNote: note };
        return { auto: false, outcome: claim.outcome, payment, note };
      }
      if (claim.outcome === 'not_found') {
        const note = 'No bKash SMS record for this TrxID yet — waiting for the payment phone to upload it.';
        log(`No matching received payment found (tid=${tid})`);
        await stampVerifyNote(payment.id, note);
        payment = { ...payment, verifyNote: note };
        return { auto: false, outcome: claim.outcome, payment, note };
      }
      const mid = claim.payment && claim.payment.matchedPaymentId;
      const note = mid ? `This TrxID was already used by payment #${mid}.` : 'This TrxID was already used by another payment.';
      log(`tid=${tid} already matched to payment #${mid || '?'} — not reassigning`);
      await stampVerifyNote(payment.id, note);
      payment = { ...payment, verifyNote: note };
      return { auto: false, outcome: claim.outcome, payment, note };
    }
    log(`Matching received payment found (tid=${tid})`);
    log(`Matching payments.transactionIdNorm found (payment #${payment.id})`);
    try {
      const { payment: approved } = await approvePaymentAtomic(payment.id, 'AUTO', { auto: true });
      log(`Payment automatically approved (payment #${approved.id}, reviewedBy=AUTO)`);
      log(`RECVPAY updated (trx=${tid} status=verified matchedPaymentId=${approved.id} verifiedBy=AUTO)`);
      try {
        await createNotification({
          type: 'AUTO_APPROVED',
          title: 'Payment auto-verified via bKash SMS',
          message: `${approved.userName} — ${approved.packageName} (TxID ${approved.transactionId}) matched SMS record.`,
          paymentRequestId: approved.id,
        });
      } catch (e) {
        console.warn('[PAYMENT AUTO VERIFY] notification skipped:', e && e.message);
      }
      return { auto: true, outcome: 'claimed', payment: approved, note: approved.verifyNote || null };
    } catch (e) {
      // Approval lost a race (already reviewed) — the claim stands recorded;
      // an admin resolves it manually.
      const note = 'SMS matched but the approval was already processed — needs manual review.';
      log(`tid=${tid} approval race lost — needs manual review`);
      await stampVerifyNote(payment.id, note);
      const cur = await findPaymentById(payment.id);
      return { auto: false, outcome: 'approve_failed', payment: cur || payment, note };
    }
  } catch (e) {
    console.warn('[PAYMENT AUTO VERIFY] attempt failed:', e && e.message);
    return { auto: false, outcome: 'error', payment, note: null };
  }
}

/* ---------- app releases (APK files on filesystem, metadata in MongoDB) ---------- */

const APP_RELEASES_DIR = process.env.APP_RELEASES_DIR || '';

function sanitizeFileName(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

async function ensureReleasesDir() {
  return APP_RELEASES_DIR || require('path').join(__dirname, '..', 'uploads');
}

async function listReleases() {
  const { OtpAppRelease } = await getModels();
  const docs = await OtpAppRelease.find({}).sort({ versionCode: -1 }).lean();
  return serialize(docs);
}

async function findPublishedRelease(versionCode) {
  const { OtpAppRelease } = await getModels();
  const doc = await OtpAppRelease.findOne({ versionCode: Number(versionCode), isPublished: true }).lean();
  return serialize(doc);
}

async function findLatestPublishedRelease() {
  const { OtpAppRelease } = await getModels();
  const doc = await OtpAppRelease.findOne({ isPublished: true }).sort({ versionCode: -1 }).lean();
  return serialize(doc);
}

async function createRelease(data) {
  const { OtpAppRelease } = await getModels();
  const id = await nextId('appRelease');
  const doc = await OtpAppRelease.create({ id, createdAt: nowIso(), publishedAt: null, ...data, id });
  clearVersionCache();
  return serialize(doc);
}

async function updateRelease(versionCode, patch) {
  const { OtpAppRelease } = await getModels();
  const doc = await OtpAppRelease.findOneAndUpdate(
    { versionCode: Number(versionCode) },
    { $set: patch },
    { returnDocument: 'after' }
  ).lean();
  clearVersionCache();
  return serialize(doc);
}

async function deleteRelease(versionCode) {
  const { OtpAppRelease } = await getModels();
  const doc = await OtpAppRelease.findOneAndDelete({ versionCode: Number(versionCode) }).lean();
  clearVersionCache();
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
  findUserById, findUserRawById, findUserByLogin, findUserByReferralCode, userLoginExists, loginExists,
  findUserByDeviceNorm, findUserByDevice, listUsers, createUser,
  updateUserById, incrementUserCounters, updateUserPassword, deleteUserById, countUsers,
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
  // app releases
  listReleases, findPublishedRelease, findLatestPublishedRelease, createRelease, updateRelease, deleteRelease,
  ensureReleasesDir, sanitizeFileName,
  // withdrawals / profit
  listWithdrawals, createWithdrawal, dashboardStats,
  // idempotency
  findPaymentIdByIdemKey, saveIdemKey,
  // received bKash payments
  normalizeRecvTrx, validateReceivedPayload, createReceivedPayment,
  findReceivedByTrx, listReceivedPayments, verifyReceivedPayment, setReceivedStatus,
  findPendingPaymentsByTxNorm, claimReceivedForPayment, tryAutoApprove,
  // misc
  activationWindow,
  referralConfig, uniqueReferralCode, createReferral, verifyReferralForUser,
  getMyReferral, listReferrals, referralStats,
};
