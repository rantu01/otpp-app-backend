'use strict';
try { require('dotenv').config(); } catch { /* dotenv optional */ }
const app = require('./app');

const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, () => {
  console.log(`[backend] listening on http://localhost:${PORT}`);
  console.log('[backend] health: GET /api/health');
});
