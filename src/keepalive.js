'use strict';
/**
 * Keep-alive pinger — prevents the Render-hosted backend from sleeping.
 *
 * Render's free tier sleeps a web service after ~15 minutes without inbound
 * traffic. This script periodically sends a lightweight `GET /api/health`
 * request so the deployed server stays warm. It runs as a SEPARATE process
 * (Render Background Worker, a second Render Cron Job, or any always-on
 * machine) — never inside the web service itself, because a sleeping
 * service also suspends its own timers, so self-pinging cannot work.
 *
 * The health endpoint is public, tiny, and exempt from rate limiting
 * (see src/security.js), so pings are cheap and never lock accounts.
 *
 * Usage:
 *   npm run keepalive         # loop: ping now, then repeat every N minutes
 *   npm run keepalive:once    # single ping and exit (for external schedulers)
 *   node src/keepalive.js --once
 *
 * +====================================================================+
 * |  CONFIG — TO CHANGE THE INTERVAL, EDIT JUST THIS ONE VALUE:        |
 * |                                                                    |
 * |      KEEPALIVE_INTERVAL_MINUTES = 7   (default: every 7 minutes)    |
 * |                                                                    |
 * |  Example: for every 10 minutes, change 7 -> 10 below (or set       |
 * |  KEEPALIVE_INTERVAL_MINUTES=10 in `.env` — env wins when set).     |
 * +====================================================================+
 */
try { require('dotenv').config(); } catch { /* dotenv optional */ }

const http = require('http');
const https = require('https');

// ------------------------------ config ------------------------------

/** Ping interval in minutes. Change 7 -> 10 for every 10 minutes. */
const KEEPALIVE_INTERVAL_MINUTES = Number(process.env.KEEPALIVE_INTERVAL_MINUTES || 7);

/** Deployed backend base URL (no trailing slash). Set to your Render URL. */
const KEEPALIVE_URL = String(
  process.env.KEEPALIVE_URL || process.env.PUBLIC_BASE_URL || ''
).trim().replace(/\/+$/, '');

/** Per-ping network timeout in ms. */
const KEEPALIVE_TIMEOUT_MS = Number(process.env.KEEPALIVE_TIMEOUT_MS || 15000);

const HEALTH_PATH = '/api/health';
const ONCE = process.argv.includes('--once');

// ------------------------------ ping ------------------------------

function pingOnce(baseUrl, timeoutMs) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(HEALTH_PATH, baseUrl + '/');
    } catch (e) {
      resolve({ ok: false, status: 0, error: 'Invalid KEEPALIVE_URL: ' + e.message });
      return;
    }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'GET',
        timeout: timeoutMs,
        headers: { 'User-Agent': 'otp-keepalive/1.0' },
      },
      (res) => {
        // Drain the tiny body so the socket can be reused/closed cleanly.
        res.resume();
        res.on('end', () => {
          const ok = res.statusCode >= 200 && res.statusCode < 300;
          resolve({ ok, status: res.statusCode, error: ok ? null : 'HTTP ' + res.statusCode });
        });
      }
    );
    req.on('timeout', () => {
      req.destroy(new Error('timeout after ' + timeoutMs + 'ms'));
    });
    req.on('error', (e) => {
      resolve({ ok: false, status: 0, error: e && e.message });
    });
    req.end();
  });
}

function stamp() {
  return new Date().toISOString();
}

async function runOnce() {
  const r = await pingOnce(KEEPALIVE_URL, KEEPALIVE_TIMEOUT_MS);
  if (r.ok) {
    console.log(`[keepalive] ${stamp()} OK ${KEEPALIVE_URL}${HEALTH_PATH} (HTTP ${r.status})`);
    return true;
  }
  console.error(`[keepalive] ${stamp()} FAIL ${KEEPALIVE_URL}${HEALTH_PATH}: ${r.error}`);
  return false;
}

// ------------------------------ main ------------------------------

async function main() {
  if (!KEEPALIVE_URL) {
    console.error(
      '[keepalive] KEEPALIVE_URL is not set. Set it to your Render URL, e.g.\n' +
      '  KEEPALIVE_URL=https://your-app.onrender.com\n' +
      'in `.env` (see .env.example) or as an environment variable, then re-run.'
    );
    process.exit(2);
  }
  if (!Number.isFinite(KEEPALIVE_INTERVAL_MINUTES) || KEEPALIVE_INTERVAL_MINUTES <= 0) {
    console.error(
      `[keepalive] Invalid KEEPALIVE_INTERVAL_MINUTES (${process.env.KEEPALIVE_INTERVAL_MINUTES}). ` +
      'Set a positive number of minutes (e.g. 7).'
    );
    process.exit(2);
  }

  if (ONCE) {
    const ok = await runOnce();
    process.exit(ok ? 0 : 1);
  }

  const intervalMs = KEEPALIVE_INTERVAL_MINUTES * 60 * 1000;
  console.log(
    `[keepalive] pinging ${KEEPALIVE_URL}${HEALTH_PATH} ` +
    `every ${KEEPALIVE_INTERVAL_MINUTES} minute(s). Press Ctrl+C to stop.`
  );
  await runOnce(); // ping immediately so the first wait isn't idle
  const timer = setInterval(() => {
    runOnce().catch((e) => console.error('[keepalive] unexpected error:', e && e.message));
  }, intervalMs);
  // Keep the event loop alive for the interval (no unref — this IS the job).
  void timer;
  const shutdown = () => {
    clearInterval(timer);
    console.log('[keepalive] stopped.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[keepalive] FATAL:', e && e.message);
  process.exit(1);
});
