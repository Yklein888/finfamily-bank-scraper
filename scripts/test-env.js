#!/usr/bin/env node
console.log('=== Environment Test ===');
console.log('Node version:', process.version);
console.log('');
console.log('Environment variables:');
const vars = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SCRAPER_API_KEY', 'PAGI_USERNAME', 'PAGI_PASSWORD', 'CAL_USERNAME', 'CAL_PASSWORD', 'HAPOALIM_USERCODE', 'HAPOALIM_PASSWORD', 'PUPPETEER_EXECUTABLE_PATH'];
for (const v of vars) {
  const val = process.env[v];
  console.log(`  ${v}: ${val ? '✓ SET' : '✗ MISSING'}`);
}
