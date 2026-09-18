'use strict';
try { require('dotenv').config(); } catch { /* dotenv optional */ }
// Optional MongoDB hookup (non-blocking, JSON-store fallback preserved).
try { require('./mongo').connectBestEffort(); } catch (e) {
  console.warn('[mongo] hookup skipped:', e && e.message);
}
const app = require('./app');

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
  console.log('[backend] health: GET /api/health');
});
