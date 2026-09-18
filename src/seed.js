'use strict';
/**
 * Seeds the shared database: admin account, packages (৳20/7d, ৳35/20d),
 * payment methods (bKash/Nagad/Rocket), and android app-version config.
 *
 * Run: npm run seed
 * Env: ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_NAME (see .env.example)
 */
try { require('dotenv').config(); } catch { /* optional */ }
const dbx = require('./db');
const { hashPassword } = require('./auth');

const db = dbx.load();

function ensureAdmin() {
  const email = (process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  let admin = db.users.find((u) => u.email === email);
  if (!admin) {
    admin = {
      id: dbx.nextId(db, 'user'),
      name: process.env.ADMIN_NAME || 'Administrator',
      email,
      phone: null,
      passwordHash: hashPassword(process.env.ADMIN_PASSWORD || 'admin123'),
      role: 'admin',
      status: 'active',
      accessEnabled: true,
      currentPackageId: null,
      currentPackageName: null,
      packageStartDate: null,
      packageExpireDate: null,
      createdAt: dbx.nowIso(),
    };
    db.users.push(admin);
    console.log('[seed] admin created:', email);
  } else {
    console.log('[seed] admin exists:', email);
  }
}

function ensurePackages() {
  const wanted = [
    { name: 'Weekly — 7 Days', price: 20, durationDays: 7, description: '7 days full app access' },
    { name: 'Standard — 20 Days', price: 35, durationDays: 20, description: '20 days full app access' },
  ];
  for (const w of wanted) {
    if (!db.packages.some((p) => p.name === w.name)) {
      db.packages.push(Object.assign({ id: dbx.nextId(db, 'package'), status: 'active', createdAt: dbx.nowIso(), updatedAt: dbx.nowIso() }, w));
      console.log('[seed] package:', w.name);
    }
  }
}

function ensureMethods() {
  const wanted = [
    { name: 'bKash', walletNumber: '01XXXXXXXXX', accountType: 'Personal', logo: '', instructions: 'Send Money to this bKash number, then submit the Transaction ID below.', sortOrder: 0 },
    { name: 'Nagad', walletNumber: '01XXXXXXXXX', accountType: 'Personal', logo: '', instructions: 'Send Money to this Nagad number, then submit the Transaction ID below.', sortOrder: 1 },
    { name: 'Rocket', walletNumber: '01XXXXXXXXX', accountType: 'Personal', logo: '', instructions: 'Send Money to this Rocket number, then submit the Transaction ID below.', sortOrder: 2 },
  ];
  for (const w of wanted) {
    if (!db.paymentMethods.some((m) => m.name === w.name)) {
      db.paymentMethods.push(Object.assign({ id: dbx.nextId(db, 'paymentMethod'), status: 'active', createdAt: dbx.nowIso(), updatedAt: dbx.nowIso() }, w));
      console.log('[seed] payment method:', w.name);
    }
  }
}

function ensureVersion() {
  if (!db.appVersions.some((v) => v.platform === 'android')) {
    db.appVersions.push({
      id: dbx.nextId(db, 'appVersion'),
      platform: 'android',
      latestVersion: '1.5.0',
      minimumSupportedVersion: '1.3.0',
      updateRequired: false,
      updateUrl: '',
      message: 'A new version is available. Please update to continue.',
      updatedAt: dbx.nowIso(),
    });
    console.log('[seed] app version: android 1.5.0 / min 1.3.0');
  }
}

ensureAdmin();
ensurePackages();
ensureMethods();
ensureVersion();
db.meta.seededAt = dbx.nowIso();
dbx.save(db);
console.log('[seed] done ->', dbx.DB_PATH);
