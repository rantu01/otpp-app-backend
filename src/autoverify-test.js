'use strict';
/**
 * Auto-verify tests (HTTP end-to-end, in-process app + real MongoDB).
 * Run: node src/autoverify-test.js
 *
 * Covers:
 *  A. submit-first, SMS later  -> late-SMS path auto-approves (autoVerified:true)
 *  B. SMS-first, submit later  -> submit path auto-approves immediately
 *  C. amount mismatch          -> stays PENDING + verifyNote explains why
 *  D. double-claim             -> same SMS cannot approve twice (claim is atomic)
 *  E. manual approval still works and stays autoVerified:false
 *  F. admin-Verified SMS       -> still claimable when the customer submits late
 */
try { require('dotenv').config(); } catch { /* optional */ }
const http = require('http');

function call(port, method, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        port, host: '127.0.0.1', path, method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { json = { _raw: buf }; }
          resolve({ status: res.statusCode, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

async function main() {
  const uri = String(process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
  if (!uri) { console.log('SKIP (MONGODB_URI unset)'); process.exit(0); }
  const app = require('./app');
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const uniq = Date.now().toString(36).toUpperCase();

  try {
    const login = await call(port, 'POST', '/api/auth/login', {
      login: process.env.ADMIN_EMAIL || 'admin@example.com',
      password: process.env.ADMIN_PASSWORD || 'admin123',
    });
    check('admin login', login.status === 200 && login.json.token, 'status=' + login.status);
    const adminTok = login.json.token;

    const reg = await call(port, 'POST', '/api/auth/register', {
      name: 'AutoV', email: `autov${uniq}@t.com`, password: 'pass1234',
    });
    check('user register', reg.status === 201 && reg.json.token, 'status=' + reg.status);
    const userTok = reg.json.token;

    const pkgs = await call(port, 'GET', '/api/packages', null, userTok);
    const methods = await call(port, 'GET', '/api/payment-methods', null, userTok);
    const pkg = pkgs.json.packages[0];
    const bkash = (methods.json.paymentMethods || []).find((m) => /bkash/i.test(m.name || '')) || methods.json.paymentMethods[0];
    check('catalog ready', !!pkg && !!bkash, `pkg=${pkg && pkg.price} method=${bkash && bkash.name}`);

    const sms = (tid, amount) => ({
      amount, sender: '01642188277', fee: 0, balance: 1332.31, trxId: tid,
      transactionDate: '2026-09-19', transactionTime: '10:59',
      originalMessage: `You have received Tk ${amount}.00 from 01642188277. TrxID ${tid} at 19/09/2026 10:59`,
      receivedAt: new Date().toISOString(), source: 'bkash_sms',
    });

    // A. submit first (no SMS yet) -> PENDING, then SMS lands -> auto-approved.
    const tidA = `AUTOA${uniq}`;
    const subA = await call(port, 'POST', '/api/payments',
      { packageId: pkg.id, paymentMethodId: bkash.id, transactionId: tidA }, userTok);
    check('A submit stays PENDING (no SMS yet)',
      subA.status === 201 && subA.json.payment.status === 'PENDING'
      && subA.json.autoVerified === false && subA.json.verifyOutcome === 'not_found',
      JSON.stringify(subA.json).slice(0, 160));
    const smsA = await call(port, 'POST', '/api/received-payments', sms(tidA, pkg.price), adminTok);
    check('A late SMS auto-matches', smsA.status === 201 && smsA.json.autoMatched === 1,
      JSON.stringify(smsA.json).slice(0, 120));
    const gotA = await call(port, 'GET', `/api/received-payments/${tidA}`, null, adminTok);
    check('A SMS record used + linked',
      gotA.json.payment && gotA.json.payment.status === 'used'
      && gotA.json.payment.matchedPaymentId === subA.json.payment.id,
      JSON.stringify((gotA.json.payment || {})).slice(0, 160));
    const listA = await call(port, 'GET', `/api/admin/payments?search=${tidA}`, null, adminTok);
    const payA = (listA.json.payments || [])[0];
    check('A payment APPROVED + autoVerified',
      payA && payA.status === 'APPROVED' && payA.autoVerified === true,
      JSON.stringify(payA || {}).slice(0, 160));

    // B. SMS first, then submit -> immediate auto-approval on submit.
    const tidB = `AUTOB${uniq}`;
    await call(port, 'POST', '/api/received-payments', sms(tidB, pkg.price), adminTok);
    const subB = await call(port, 'POST', '/api/payments',
      { packageId: pkg.id, paymentMethodId: bkash.id, transactionId: tidB }, userTok);
    check('B submit auto-approves (SMS already there)',
      subB.status === 201 && subB.json.payment.status === 'APPROVED'
      && subB.json.autoVerified === true && subB.json.payment.autoVerified === true,
      JSON.stringify(subB.json).slice(0, 160));

    // C. amount mismatch -> stays PENDING + reason persisted and returned.
    const tidC = `AUTOC${uniq}`;
    const subC = await call(port, 'POST', '/api/payments',
      { packageId: pkg.id, paymentMethodId: bkash.id, transactionId: tidC }, userTok);
    const smsC = await call(port, 'POST', '/api/received-payments', sms(tidC, pkg.price + 50), adminTok);
    const listC = await call(port, 'GET', `/api/admin/payments?search=${tidC}`, null, adminTok);
    const payC = (listC.json.payments || [])[0];
    check('C mismatch stays PENDING with reason',
      subC.json.payment.status === 'PENDING' && smsC.json.autoMatched === 0
      && payC && payC.status === 'PENDING' && payC.autoVerified !== true
      // Submit-time note (no SMS yet) differs from the post-SMS mismatch note.
      && /No bKash SMS record/.test(subC.json.verifyNote || '')
      && /does not match/.test(payC.verifyNote || ''),
      `autoMatched=${smsC.json.autoMatched} status=${payC && payC.status} note=${payC && payC.verifyNote}`);

    // D. double-claim: re-POST the same SMS -> duplicate, no second approval.
    const dupA = await call(port, 'POST', '/api/received-payments', sms(tidA, pkg.price), adminTok);
    check('D duplicate SMS harmless',
      dupA.json.duplicate === true && (dupA.json.autoMatched === undefined || dupA.json.autoMatched === 0),
      JSON.stringify(dupA.json).slice(0, 120));

    // E. manual approval still works and is NOT flagged auto.
    const manual = await call(port, 'POST', `/api/admin/payments/${subC.json.payment.id}/approve`, {}, adminTok);
    check('E manual approve works, autoVerified=false',
      manual.status === 200 && manual.json.payment.status === 'APPROVED'
      && manual.json.payment.autoVerified !== true,
      JSON.stringify((manual.json.payment || {})).slice(0, 120));

    // F. SMS flipped to `verified` by manual Verify BEFORE the customer
    // submits must still be claimable (Verify confirms funds; it must not
    // burn the record).
    const tidF = `AUTOF${uniq}`;
    const smsF = await call(port, 'POST', '/api/received-payments', sms(tidF, pkg.price), adminTok);
    check('F SMS stored pending', smsF.status === 201 && smsF.json.autoMatched === 0);
    const verF = await call(port, 'POST', '/api/received-payments/verify', { trxId: tidF }, adminTok);
    check('F manual Verify flips to verified',
      verF.status === 200 && verF.json.payment && verF.json.payment.status === 'verified',
      JSON.stringify((verF.json.payment || {})).slice(0, 120));
    const subF = await call(port, 'POST', '/api/payments',
      { packageId: pkg.id, paymentMethodId: bkash.id, transactionId: tidF }, userTok);
    check('F submit after manual Verify still auto-approves',
      subF.status === 201 && subF.json.payment.status === 'APPROVED' && subF.json.autoVerified === true,
      JSON.stringify(subF.json).slice(0, 160));
    const gotF = await call(port, 'GET', `/api/received-payments/${tidF}`, null, adminTok);
    check('F SMS record used + linked',
      gotF.json.payment && gotF.json.payment.status === 'used'
      && gotF.json.payment.matchedPaymentId === subF.json.payment.id);

    // G. health exposes the deployed commit so prod staleness is checkable.
    const health = await call(port, 'GET', '/api/health', null, null);
    check('G health reports autoVerify + build',
      health.json.autoVerify === true && health.json.recvpay === true
      && health.json.build && typeof health.json.build.commit === 'string',
      JSON.stringify(health.json.build || {}));
  } finally {
    server.close();
  }

  console.log(fail === 0 ? `AUTOVERIFY OK (${pass} passed)` : `AUTOVERIFY FAILED (${fail}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
