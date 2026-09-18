'use strict';
try { require('dotenv').config(); } catch { /* dotenv optional */ }
const { ensureMongo } = require('./mongo');
const app = require('./app');

const PORT = Number(process.env.PORT || 4000);

// Connect to the single shared MongoDB database BEFORE accepting traffic,
// so the very first request already reads/writes MongoDB (no local store).
// Models + indexes + one-time repairs are warmed here so hot paths never
// pay cold-start costs.
async function boot() {
  await ensureMongo();
  await require('./models').getModels();
}
boot()
  .catch((e) => {
    console.error('[backend] FATAL: cannot connect to MongoDB:', e && e.message);
    console.error('[backend] Set MONGODB_URI in `.env` (see .env.example). Refusing to start without the database.');
    process.exit(1);
  })
  .then(() => {
    app.listen(PORT, () => {
      console.log(`[backend] listening on http://localhost:${PORT}`);
      console.log('[backend] health: GET /api/health');
      console.log('[backend] storage: MongoDB only (no local files).');
    });
  });
