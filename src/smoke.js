'use strict';
/** Minimal smoke test: boots the app in-process and exercises key flows. Run: npm test */
const request = require('http');

function call(port, method, path, body, token, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = request.request(
      { port, host: '127.0.0.1', path, method, headers: Object.assign({
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      }, headers || {}) },
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

async function main() {
  try { require('dotenv').config(); } catch { /* optional */ }
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const { execSync } = require('child_process');
  try { execSync('node src/seed.js', { cwd: __dirname + '/..', stdio: 'ignore' }); } catch {}
  const app = require('./app');
  const server = app.listen(0);
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  const results = [];
  const check = (name, cond, detail) => {
    results.push({ name, ok: !!cond, detail });
    console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  };

  const adminLogin = await call(port, 'POST', '/api/auth/login', { login: process.env.ADMIN_EMAIL || 'admin@example.com', password: process.env.ADMIN_PASSWORD || 'admin123' });
  check('admin login', adminLogin.status === 200 && adminLogin.json.token, JSON.stringify(adminLogin.json).slice(0, 120));
  const adminTok = adminLogin.json.token;

  const reg = await call(port, 'POST', '/api/auth/register', { name: 'Rahim', email: 'rahim' + Date.now() + '@t.com', password: 'pass1234' });
  check('user register', reg.status === 201 && reg.json.token, 'status=' + reg.status);
  const userTok = reg.json.token;

  const pkgs = await call(port, 'GET', '/api/packages', null, userTok);
  check('list packages', pkgs.status === 200 && pkgs.json.packages.length >= 2, 'count=' + (pkgs.json.packages || []).length);
  const methods = await call(port, 'GET', '/api/payment-methods', null, userTok);
  check('list payment methods', methods.status === 200 && methods.json.paymentMethods.length >= 1, 'count=' + (methods.json.paymentMethods || []).length);

  const access0 = await call(port, 'GET', '/api/access/status', null, userTok);
  check('access blocked w/o package', access0.json.access && access0.json.access.allowed === false, access0.json.access && access0.json.access.reason);

  const pkg = pkgs.json.packages[0];
  const method = methods.json.paymentMethods[0];
  const txid = 'TX' + Date.now();
  const pay = await call(port, 'POST', '/api/payments', { packageId: pkg.id, paymentMethodId: method.id, transactionId: txid }, userTok, { 'Idempotency-Key': 'k-' + txid });
  check('submit payment', pay.status === 201 && pay.json.payment.status === 'PENDING', 'status=' + pay.status);
  const dup = await call(port, 'POST', '/api/payments', { packageId: pkg.id, paymentMethodId: method.id, transactionId: txid.toLowerCase() }, userTok);
  check('duplicate txid rejected', dup.status === 409, 'status=' + dup.status);
  const retry = await call(port, 'POST', '/api/payments', { packageId: pkg.id, paymentMethodId: method.id, transactionId: txid }, userTok, { 'Idempotency-Key': 'k-' + txid });
  check('idempotent retry deduped', retry.json.deduped === true, 'status=' + retry.status);

  const pend = await call(port, 'GET', '/api/admin/payments/pending-count', null, adminTok);
  check('pending count >= 1', pend.json.pending >= 1, 'pending=' + pend.json.pending);

  const pid = pay.json.payment.id;
  const approve = await call(port, 'POST', `/api/admin/payments/${pid}/approve`, {}, adminTok);
  check('approve payment', approve.status === 200 && approve.json.payment.status === 'APPROVED', 'status=' + approve.status);
  const approve2 = await call(port, 'POST', `/api/admin/payments/${pid}/approve`, {}, adminTok);
  check('double approve rejected (race guard)', approve2.status === 409, 'status=' + approve2.status);

  const access1 = await call(port, 'GET', '/api/access/status', null, userTok);
  check('access allowed after approval', access1.json.access && access1.json.access.allowed === true, access1.json.access && access1.json.access.reason);
  const prot = await call(port, 'GET', '/api/protected/demo', null, userTok);
  check('protected API allows active user', prot.status === 200, 'status=' + prot.status);

  const ver = await call(port, 'GET', '/api/versions/check?platform=android&version=1.2.0', null, null);
  check('force update for old version', ver.json.forceUpdate === true, JSON.stringify(ver.json).slice(0, 100));

  const dash = await call(port, 'GET', '/api/admin/dashboard', null, adminTok);
  check('dashboard stats real', dash.status === 200 && dash.json.stats.totalPayments >= 1, 'total=' + (dash.json.stats || {}).totalPayments);

  server.close();
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed === 0 ? 'SMOKE OK' : `SMOKE FAILED (${failed})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error('SMOKE ERROR', e); process.exit(1); });
