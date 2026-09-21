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
 * DEPLOYED MODE (recommended): this repo ships `render.yaml`, a Render
 * Blueprint containing a Cron Job that runs `node src/keepalive.js --once`
 * every 7 minutes. Apply it once via Render dashboard -> New -> Blueprint.
 * Each run pings with retries (cold-start tolerant) and exits, so it costs
 * only seconds of runtime per day instead of a 24/7 worker.
 *
 * TO CHANGE THE INTERVAL: edit the `schedule:` line in `render.yaml`
 * (cron format — star-slash-7 means every 7 min, star-slash-10 every 10).
 * For loop mode below, set KEEPALIVE_INTERVAL_MINUTES instead.
 *
 * LOOP MODE (any always-on machine): npm run keepalive
 * ONCE MODE (external schedulers):  npm run keepalive:once
 *
 * Env knobs (see .env.example):
 *   KEEPALIVE_URL            Render web-service URL (required)
 *   KEEPALIVE_INTERVAL_MINUTES  loop-mode interval (default 7)
 *   KEEPALIVE_RETRIES           attempts per run (default 4, rides out cold starts)
 *   KEEPALIVE_RETRY_WAIT_MS     wait between attempts (default 20000)
 */
try { require('dotenv').config(); } catch { /* dotenv optional */ }

const http = require('http');
const https = require('https');

// ------------------------------ config ------------------------------

/** Ping interval in minutes. Change 7 -> 10 for every 10 minutes. */
const KEEPALIVE_INTERVAL_MINUTES = Number(process.env.KEEPALIVE_INTERVAL_MINUTES || 7);

/** Deployed backend base URL (no trailing slash). Central default in config.js. */
const KEEPALIVE_URL = String(
  process.env.KEEPALIVE_URL || process.env.PUBLIC_BASE_URL || require('./config').DEFAULT_API_BASE_URL
).trim().replace(/\/+$/, '');

/** Per-ping network timeout in ms. */
const KEEPALIVE_TIMEOUT_MS = Number(process.env.KEEPALIVE_TIMEOUT_MS || 15000);

/**
 * Total ping attempts per run. Matters because a sleeping Render service
 * needs 30-60s to cold-start: the FIRST ping wakes it but usually times
 * out, and only a retry lands on the warm server. With the defaults
 * (4 attempts x 20s wait) one `--once` run rides out a full cold start.
 */
const KEEPALIVE_RETRIES = Number(process.env.KEEPALIVE_RETRIES || 4);

/** Wait between attempts in ms. */
const KEEPALIVE_RETRY_WAIT_MS = Number(process.env.KEEPALIVE_RETRY_WAIT_MS || 20000);

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ping until success or attempts run out. The first attempt against a
 * sleeping Render service wakes it (and typically fails); the retries land
 * once it is warm. Returns true on the first success.
 */
async function runWithRetries(tag) {
  const attempts = Math.max(1, Math.floor(KEEPALIVE_RETRIES) || 1);
  for (let i = 1; i <= attempts; i++) {
    const ok = await runOnce();
    if (ok) return true;
    if (i < attempts) {
      console.log(`[keepalive] ${stamp()} attempt ${i}/${attempts} failed (${tag}); retrying in ${Math.round(KEEPALIVE_RETRY_WAIT_MS / 1000)}s…`);
      await sleep(Math.max(1000, KEEPALIVE_RETRY_WAIT_MS));
    }
  }
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
    // Single scheduled run (Render Cron Job): retry through a cold start,
    // then exit — exit code tells the scheduler if it worked.
    const ok = await runWithRetries('--once');
    process.exit(ok ? 0 : 1);
  }

  const intervalMs = KEEPALIVE_INTERVAL_MINUTES * 60 * 1000;
  console.log(
    `[keepalive] pinging ${KEEPALIVE_URL}${HEALTH_PATH} ` +
    `every ${KEEPALIVE_INTERVAL_MINUTES} minute(s). Press Ctrl+C to stop.`
  );
  await runWithRetries('loop-start'); // ping immediately so the first wait isn't idle
  const timer = setInterval(() => {
    runWithRetries('loop').catch((e) => console.error('[keepalive] unexpected error:', e && e.message));
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
