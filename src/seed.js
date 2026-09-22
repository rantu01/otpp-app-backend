'use strict';
/**
 * Seeds the SHARED MongoDB database: admin account, packages, payment
 * methods (bKash/Nagad/Rocket/Upay), android app-version config, and sample
 * users for testing CRUD through the normal API/UI.
 *
 * Run: npm run seed
 * Env: MONGODB_URI / MONGO_DB_NAME + ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME
 *
 * Every record is a real MongoDB document (ObjectId `_id` + numeric `id`)
 * and is fully manageable via the API (view / update / delete) — nothing is
 * hardcoded or read-only, and nothing is written to local JSON files.
 */
try { require('dotenv').config(); } catch { /* optional */ }
const { ensureMongo, getDbName } = require('./mongo');
const { getModels } = require('./models');
const { hashPassword, verifyPassword } = require('./auth');
const store = require('./store');

async function ensureAdmin(models) {
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const name = process.env.ADMIN_NAME || 'Administrator';
  let admin = await models.OtpUser.findOne({ email }).lean();
  if (!admin) {
    const anyAdmin = await models.OtpUser.findOne({ role: 'admin' }).lean();
    if (anyAdmin) {
      await models.OtpUser.updateOne(
        { _id: anyAdmin._id },
        { $set: { email, name, role: 'admin', status: 'active', accessEnabled: true, passwordHash: hashPassword(password) } }
      );
      console.log('[seed] admin migrated/synced from .env:', email);
      return;
    }
    const id = await store.nextId('user');
    await models.OtpUser.create({
      id, name, email, phone: null,
      passwordHash: hashPassword(password),
      role: 'admin', status: 'active', accessEnabled: true,
      currentPackageId: null, currentPackageName: null,
      packageStartDate: null, packageExpireDate: null,
      createdAt: store.nowIso(),
    });
    console.log('[seed] admin created:', email);
    return;
  }
  const patch = {};
  if (admin.name !== name) patch.name = name;
  if (admin.role !== 'admin') patch.role = 'admin';
  if (admin.status !== 'active') patch.status = 'active';
  if (admin.accessEnabled !== true) patch.accessEnabled = true;
   if (!verifyPassword(password, admin.passwordHash)) patch.passwordHash = hashPassword(password);
   patch.activeSessionId = null;
   patch.activeDeviceId = null;
   if (Object.keys(patch).length) {
     await models.OtpUser.updateOne({ _id: admin._id }, { $set: patch });
  }
  console.log('[seed] admin synced from .env:', email);
}

async function ensurePackages(models) {
  const wanted = [
    { name: 'Weekly — 7 Days', price: 20, durationDays: 7, description: '7 days full app access' },
    { name: 'Standard — 20 Days', price: 35, durationDays: 20, description: '20 days full app access' },
    { name: 'Monthly — 30 Days', price: 50, durationDays: 30, description: '30 days full app access' },
    { name: 'Premium — 90 Days', price: 120, durationDays: 90, description: '90 days full app access, best value' },
  ];
  for (const w of wanted) {
    const existing = await models.OtpPackage.findOne({ name: w.name }).lean();
    if (!existing) {
      const id = await store.nextId('package');
      await models.OtpPackage.create({
        id, status: 'active', createdAt: store.nowIso(), updatedAt: store.nowIso(), ...w,
      });
      console.log('[seed] package:', w.name);
    }
  }
}

async function ensureMethods(models) {
  const wanted = [
    { name: 'bKash', walletNumber: '01XXXXXXXXX', accountType: 'Personal', logo: '', instructions: 'Send Money to this bKash number, then submit the Transaction ID below.', sortOrder: 0 },
    { name: 'Nagad', walletNumber: '01XXXXXXXXX', accountType: 'Personal', logo: '', instructions: 'Send Money to this Nagad number, then submit the Transaction ID below.', sortOrder: 1 },
    { name: 'Rocket', walletNumber: '01XXXXXXXXX', accountType: 'Personal', logo: '', instructions: 'Send Money to this Rocket number, then submit the Transaction ID below.', sortOrder: 2 },
    { name: 'Upay', walletNumber: '01XXXXXXXXX', accountType: 'Personal', logo: '', instructions: 'Send Money to this Upay number, then submit the Transaction ID below.', sortOrder: 3 },
  ];
  for (const w of wanted) {
    const existing = await models.OtpMethod.findOne({ name: w.name }).lean();
    if (!existing) {
      const id = await store.nextId('paymentMethod');
      await models.OtpMethod.create({
        id, status: 'active', createdAt: store.nowIso(), updatedAt: store.nowIso(), ...w,
      });
      console.log('[seed] payment method:', w.name);
    }
  }
}

async function ensureVersion(models) {
  const existing = await models.OtpVersion.findOne({ platform: 'android' }).lean();
  if (!existing) {
    const id = await store.nextId('appVersion');
    await models.OtpVersion.create({
      id,
      platform: 'android',
      latestVersion: '1.5.0',
      latestVersionCode: 1,
      minimumSupportedVersion: '1.3.0',
      updateRequired: false,
      updateUrl: '',
      message: 'A new version is available. Please update to continue.',
      updatedAt: store.nowIso(),
    });
    console.log('[seed] app version: android 1.5.0 / min 1.3.0');
  }
}

async function ensureSampleUsers(models) {
  // 4 sample users covering the main states; all fully editable via API.
  const wanted = [
    { name: 'Karim Hossain', email: 'karim@test.com', phone: null, password: 'user1234', role: 'user', status: 'active' },
    { name: 'Salim Uddin', email: 'salim@test.com', phone: null, password: 'user1234', role: 'user', status: 'active' },
    { name: 'Mina Akter', email: 'mina@test.com', phone: null, password: 'user1234', role: 'user', status: 'pending' },
    { name: 'Free Demo', email: 'freedemo@test.com', phone: null, password: 'user1234', role: 'free', status: 'active' },
  ];
  for (const w of wanted) {
    const existing = await models.OtpUser.findOne({ email: w.email }).lean();
    if (!existing) {
      const id = await store.nextId('user');
      await models.OtpUser.create({
        id,
        name: w.name,
        email: w.email,
        phone: w.phone,
        passwordHash: hashPassword(w.password),
        role: w.role,
        status: w.status,
        accessEnabled: true,
        currentPackageId: null,
        currentPackageName: w.role === 'free' ? 'Free' : null,
        packageStartDate: null,
        packageExpireDate: null,
        createdAt: store.nowIso(),
      });
      console.log('[seed] sample user:', w.email, `(${w.role}/${w.status})`);
    } else {
   // Keep seed deterministic without destroying admin edits to packages:
      // only sync identity fields + password + clear any stale session.
      const patch = {};
      if (existing.name !== w.name) patch.name = w.name;
      if (existing.role !== w.role) patch.role = w.role;
      if (!verifyPassword(w.password, existing.passwordHash)) patch.passwordHash = hashPassword(w.password);
      patch.activeSessionId = null;
      patch.activeDeviceId = null;
      if (Object.keys(patch).length) {
        await models.OtpUser.updateOne({ _id: existing._id }, { $set: patch });
        console.log('[seed] sample user synced:', w.email);
      }
    }
  }
}

async function main() {
  await ensureMongo();
  const models = await getModels();
  await ensureAdmin(models);
  // Independent collections — seed concurrently.
  await Promise.all([
    ensurePackages(models),
    ensureMethods(models),
    ensureVersion(models),
    ensureSampleUsers(models),
  ]);
  const [users, packages, paymentMethods, appVersions] = await Promise.all([
    models.OtpUser.estimatedDocumentCount(),
    models.OtpPackage.estimatedDocumentCount(),
    models.OtpMethod.estimatedDocumentCount(),
    models.OtpVersion.estimatedDocumentCount(),
  ]);
  const counts = { users, packages, paymentMethods, appVersions };
  console.log(`[seed] done -> mongodb db="${getDbName()}"`, JSON.stringify(counts));
  const { closeMongo } = require('./mongo');
  await closeMongo();
}

main().catch((e) => {
  console.error('[seed] FAILED:', e && e.message);
  process.exit(1);
});
