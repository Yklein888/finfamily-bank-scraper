/**
 * GitHub Actions scraper for Bank Hapoalim
 * Runs every 6 hours, pushes to Supabase via bank-push Edge Function
 */

import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import axios from 'axios';

const SUPABASE_PUSH_URL = 'https://tzhhilhiheekhcpdexdc.supabase.co/functions/v1/bank-push';
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const USER_ID = '16274024-a305-4416-ba62-9b321669d7d6'; // yklein89@gmail.com

async function scrapeAndPush() {
  const userCode = process.env.HAPOALIM_USERCODE;
  const password = process.env.HAPOALIM_PASSWORD;

  console.log('[Hapoalim] ENV check:', {
    userCode: userCode ? '✓' : '✗ MISSING',
    password: password ? '✓' : '✗ MISSING',
    scraperKey: SCRAPER_API_KEY ? '✓' : '✗ MISSING',
    supabaseUrl: process.env.SUPABASE_URL ? '✓' : '✗ MISSING',
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓' : '✗ MISSING'
  });

  if (!userCode || !password) {
    console.log('[Hapoalim] ⏭️ Skipping - no credentials in secrets');
    return;
  }

  if (!SCRAPER_API_KEY) {
    throw new Error('Missing SCRAPER_API_KEY in GitHub secrets');
  }

  console.log('[Hapoalim] Starting scrape at', new Date().toISOString());
  console.log('[Hapoalim] Chrome path:', process.env.PUPPETEER_EXECUTABLE_PATH || 'not set (will auto-detect)');

  try {
    const scraperOptions = {
      companyId: CompanyTypes.hapoalim,
      startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      combineInstallments: false,
      showBrowser: false,
      headless: true,
      timeout: 60000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    };

    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      scraperOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    }

    const scraper = createScraper(scraperOptions);

    console.log('[Hapoalim] Logging in with userCode...');
    const result = await scraper.scrape({ userCode, password });

    if (!result.success) {
      throw new Error('Scraper failed: ' + (result.errorMessage || 'unknown error'));
    }

    const accounts = result.accounts;

    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts returned from scraper');
    }

    console.log(`[Hapoalim] ✅ Scraped ${accounts.length} account(s)`);

    // Push to Supabase via bank-push Edge Function
    for (const account of accounts) {
      const payload = {
        source: 'hapoalim',
        user_id: USER_ID,
        account_id: account.accountNumber || 'auto', // Edge Function requires non-null value
        balance: account.balance,
        transactions: account.txns || [],
        fetched_at: new Date().toISOString(),
      };

      const res = await axios.post(SUPABASE_PUSH_URL, payload, {
        headers: {
          'x-scraper-api-key': SCRAPER_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });

      console.log(`[Hapoalim] Push response:`, res.data);
    }

    console.log('[Hapoalim] ✅ Sync complete');
  } catch (error) {
    console.error('[Hapoalim] ❌ Error:', error.message);
    throw error;
  }
}

scrapeAndPush().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
