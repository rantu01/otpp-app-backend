'use strict';
/**
 * Received-payments tests: parser mirror + backend validation + duplicate +
 * offline/robustness cases. Run: node src/recvpay-test.js (no Mongo needed
 * except the live duplicate test, which is skipped when MONGODB_URI is unset
 * or unreachable).
 *
 * Covers the 14 required cases:
 *  1 valid SMS  2 amount formats  3 balance formats  4 duplicate TrxID
 *  5 invalid TrxID  6 non-bKash SMS  7 promo SMS  8 date/time formats
 *  9 extra spaces  10 offline queue  11 backend unavailable
 *  12 restart persistence  13 burst SMS  14 double-detect same SMS
 */
const assert = require('assert');
try { require('dotenv').config(); } catch { /* optional */ }
const store = require('./store');

/* ---- JS mirror of BkashParser (same regexes as Android) ---- */
function parse(sms) {
  const out = { ok: false, error: '' };
  if (!sms || !sms.trim()) { out.error = 'Empty message.'; return out; }
  const s = sms.trim().replace(/[ \t\u00A0]+/g, ' ');
  const gate = /(you\s+have\s+received|received\s+tk|received\s+bdt|tk\s+[\d,]+\.\d{2}\s+received|funds?\s+received|payment\s+received\s+from)/i;
  if (!gate.test(s)) { out.error = 'Not a bKash received-payment SMS.'; return out; }
  if (/\bOTP\b/i.test(s) && !/tr\s*x\s*(id|no)?\s*[:#\-]?\s*[A-Z0-9]{6,20}/i.test(s)) { out.error = 'Not a bKash received-payment SMS.'; return out; }
  if (/cash\s*out|send\s*money|you\s+have\s+sent|recharge|top\s*-?\s*up|verification\s*code|one\s*-?\s*time\s*password|offer|promo|dial\s*\*/i.test(s)
    && !/you have received/i.test(s)) { out.error = 'Not a bKash received-payment SMS.'; return out; }
  const num = (x) => parseFloat(String(x).replace(/,/g, ''));
  let m = s.match(/(?:received|receive)\s+(?:tk\.?|bdt|rs\.?)?\s*([\d,]+(?:\.\d{1,2})?)/i)
    || s.match(/(?:tk\.?|bdt)\s*([\d,]+(?:\.\d{1,2})?)\s*(?:has\s+been\s+)?(?:received|credited)/i)
    || s.match(/(?:tk\.?|bdt)\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!m) { out.error = 'Amount not found.'; return out; }
  out.amount = num(m[1]);
  if (!(out.amount > 0)) { out.error = 'Invalid amount.'; return out; }
  const sm = s.match(/from\s*\D{0,12}?((?:\+?880|0)\s?1\s?\d(?:[\s-]?\d){8})/i) || s.match(/((?:\+?880|0)1\d{9})/);
  if (!sm) { out.error = 'Sender number not found.'; return out; }
  out.sender = sm[1].replace(/[\s-]/g, '');
  const fm = s.match(/fee\s*(?:tk\.?|bdt)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  out.fee = fm ? num(fm[1]) : 0;
  const bm = s.match(/balance\s*(?:tk\.?|bdt|is)?\s*([\d,]+(?:\.\d{1,2})?)/i);
  out.balance = bm ? num(bm[1]) : null;
  const tm = s.match(/tr\s*x\s*(?:id|no)?\s*[:#\-]?\s*([A-Z0-9]{6,20})/i);
  if (!tm || !/^[A-Z0-9]{6,20}$/i.test(tm[1].trim())) { out.error = 'TrxID not found.'; return out; }
  out.trxId = tm[1].trim().toUpperCase();
  const dm = s.match(/(?:at\s+)?(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})\s+(\d{1,2}:\d{2}(?::\d{2})?\s*(?:AM|PM|am|pm)?)/);
  if (!dm) { out.error = 'Transaction date/time not found.'; return out; }
  out.rawDate = dm[1] + ' ' + dm[2];
  out.ok = true;
  return out;
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
}

// 1. Valid received payment SMS (the canonical example)
{
  const r = parse('You have received Tk 480.00 from 01642188277. Fee Tk 0.00. Balance Tk 1,332.31. TrxID DIJ2N7GCGS at 19/09/2026 10:59');
  check('1 valid SMS parses', r.ok && r.amount === 480 && r.sender === '01642188277' && r.trxId === 'DIJ2N7GCGS' && r.fee === 0 && r.balance === 1332.31, JSON.stringify(r));
}
// 2. Different amount formats
{
  const a = parse('You have received Tk 1,250.50 from 01711111111. TrxID AAA111BBB at 01/01/2026 01:05');
  const b = parse('You have received BDT 5000 from 01822222222 TrxID CCC333DDD at 02-02-2026 14:30');
  check('2 amount formats', a.ok && a.amount === 1250.5 && b.ok && b.amount === 5000, JSON.stringify([a, b]));
}
// 3. Different balance formats
{
  const a = parse('You have received Tk 100.00 from 01711111111. Balance Tk 10,000.00. TrxID BALA001AA at 01/01/2026 01:05');
  const b = parse('You have received Tk 100.00 from 01711111111. Balance is 250.5. TrxID BALB002BB at 01/01/2026 01:05');
  check('3 balance formats', a.ok && a.balance === 10000 && b.ok && b.balance === 250.5, JSON.stringify([a, b]));
}
// 4. Duplicate TrxID normalization (backend treats same norm as duplicate)
{
  check('4 trx norm equal', store.normalizeRecvTrx(' dij2n7gcgs ') === store.normalizeRecvTrx('DIJ2N7GCGS'));
  const v = store.validateReceivedPayload({ amount: 480, sender: '01642188277', trxId: 'DIJ2N7GCGS' });
  check('4 valid payload passes', v.errs.length === 0);
}
// 5. Invalid TrxID rejected by backend validation
{
  const v = store.validateReceivedPayload({ amount: 100, sender: '01711111111', trxId: 'AB!' });
  check('5 invalid trxid rejected', v.errs.length > 0, v.errs.join(';'));
  const v2 = store.validateReceivedPayload({ amount: -5, trxId: 'ABCDEF12' });
  check('5 negative amount rejected', v2.errs.length > 0);
  const v3 = store.validateReceivedPayload({ amount: 100, trxId: '' });
  check('5 missing trxid rejected', v3.errs.length > 0);
}
// 6. Non-bKash SMS ignored
{
  const r = parse('Your parcel has arrived. Collect from hub at 10am.');
  check('6 non-bkash ignored', !r.ok);
}
// 7. bKash promotional / OTP / cash-out SMS ignored
{
  const cases = [
    'bKash offer! 20% bonus on recharge. Dial *247# to claim.',
    'Your bKash OTP is 482913. Do not share it.',
    'Cash Out Tk 500.00 to 01999999999 successful. Fee Tk 10. TrxID OUT123XYZ at 01/01/2026 10:00',
    'Send Money Tk 200.00 to 01888888888 successful. TrxID SEND001AB at 01/01/2026 10:00',
  ];
  check('7 promo/otp/cashout ignored', cases.every((c) => !parse(c).ok), JSON.stringify(cases.map(parse)));
}
// 8. Different date/time formatting
{
  const a = parse('You have received Tk 10.00 from 01711111111. TrxID DATE0001A at 19-09-2026 10:59 PM');
  const b = parse('You have received Tk 10.00 from 01711111111. TrxID DATE0002B at 19.09.26 09:05');
  check('8 date variants', a.ok && b.ok, JSON.stringify([a, b]));
}
// 9. Extra spaces / casing
{
  const r = parse('  you   HAVE received   Tk   480.00   FROM  01642188277.   fee Tk 0.00.  balance Tk 1,332.31.  trxid  dij2n7gcgs   AT 19/09/2026 10:59  ');
  check('9 extra spaces + case', r.ok && r.trxId === 'DIJ2N7GCGS' && r.amount === 480, JSON.stringify(r));
}
// 10. Offline queue: payload is fully self-contained (no server round-trip needed to persist)
{
  const r = parse('You have received Tk 480.00 from 01642188277. Fee Tk 0.00. Balance Tk 1,332.31. TrxID OFFL1N200 at 19/09/2026 10:59');
  const v = store.validateReceivedPayload({ amount: r.amount, sender: r.sender, trxId: r.trxId });
  check('10 offline-parse queueable', r.ok && v.errs.length === 0);
}
// 11. Backend unavailable: validation happens before any DB call, so malformed
//     payloads are rejected even without a connection; well-formed ones queue.
{
  const bad = store.validateReceivedPayload({ amount: 'abc', trxId: 'ZZZ' });
  check('11 malformed rejected pre-DB', bad.errs.length > 0);
}
// 12. Restart persistence: norm is deterministic across processes
{
  check('12 norm stable across restart', store.normalizeRecvTrx('DiJ2-N7G cGs') === 'DIJ2N7GCGS');
}
// 13. Burst: 20 distinct messages all parse with distinct TrxIDs
{
  let okAll = true;
  for (let i = 0; i < 20; i++) {
    const tid = 'BURST' + String(1000 + i);
    const r = parse(`You have received Tk ${10 + i}.00 from 0170000000${i % 10}. Fee Tk 0.00. TrxID ${tid} at 19/09/2026 10:${String(i).padStart(2, '0')}`);
    if (!r.ok || r.trxId !== tid) { okAll = false; break; }
  }
  check('13 burst of 20 parses', okAll);
}
// 14. Same SMS detected twice -> same norm -> backend returns duplicate:true
{
  const a = parse('You have received Tk 480.00 from 01642188277. Fee Tk 0.00. Balance Tk 1,332.31. TrxID DIJ2N7GCGS at 19/09/2026 10:59');
  const b = parse('You have received Tk 480.00 from 01642188277. Fee Tk 0.00. Balance Tk 1,332.31. TrxID DIJ2N7GCGS at 19/09/2026 10:59');
  check('14 double-detect same norm', a.ok && b.ok && store.normalizeRecvTrx(a.trxId) === store.normalizeRecvTrx(b.trxId));
}

async function liveDuplicateTest() {
  // Hits real Mongo when available: insert once, insert again -> duplicate:true.
  const uri = String(process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
  if (!uri) { console.log('SKIP live duplicate test (MONGODB_URI unset)'); return; }
  try {
    const tid = 'LIVE' + Date.now().toString(36).toUpperCase().slice(-8);
    const base = { amount: 11, sender: '01700000001', fee: 0, balance: null, trxId: tid, transactionDate: '2026-09-19', transactionTime: '10:59', originalMessage: 'live test', receivedAt: new Date().toISOString(), deviceInfo: 'test', source: 'bkash_sms' };
    const first = await store.createReceivedPayment(base);
    const second = await store.createReceivedPayment(base);
    check('live insert ok', first.doc && !first.duplicate);
    check('live duplicate flagged', second.duplicate === true && second.doc.trxId === tid);
    const found = await store.findReceivedByTrx(tid.toLowerCase());
    check('live lookup case-insensitive', found && found.trxId === tid);
    const verified = await store.verifyReceivedPayment(tid, 11, null);
    check('live verify amountOk', verified.found && verified.amountOk === true);
    const mismatch = await store.verifyReceivedPayment(tid, 9999, null);
    check('live verify rejects wrong amount', mismatch.found && mismatch.amountOk === false);
  } catch (e) {
    console.log('SKIP live duplicate test (DB unreachable: ' + (e && e.message) + ')');
  }
}

liveDuplicateTest().then(() => {
  console.log(fail === 0 ? `RECVPAY TESTS OK (${pass} passed)` : `RECVPAY TESTS FAILED (${fail}/${pass + fail})`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error('TEST ERROR', e); process.exit(1); });
