/**
 * GitHub Actions scraper for Pagi bank
 * Uses @sparticuz/chromium for serverless-compatible Chrome
 */

import chromium from '@sparticuz/chromium';
import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import axios from 'axios';

const SUPABASE_PUSH_URL = 'https://tzhhilhiheekhcpdexdc.supabase.co/functions/v1/bank-push';
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const USER_ID = '16274024-a305-4416-ba62-9b321669d7d6';

async function scrapeAndPush() {
  const username = process.env.PAGI_USERNAME;
  const password = process.env.PAGI_PASSWORD;

  console.log('[Pagi] ENV check:', {
    username: username ? '✓' : '✗ MISSING',
    password: password ? '✓' : '✗ MISSING',
    scraperKey: SCRAPER_API_KEY ? '✓' : '✗ MISSING',
    supabaseUrl: process.env.SUPABASE_URL ? '✓' : '✗ MISSING',
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY ? '✓' : '✗ MISSING'
  });

  if (!username || !password) throw new Error('Missing PAGI_USERNAME or PAGI_PASSWORD');
  if (!SCRAPER_API_KEY) throw new Error('Missing SCRAPER_API_KEY');

  console.log('[Pagi] Starting scrape at', new Date().toISOString());

  // Use @sparticuz/chromium for serverless-compatible binary
  const executablePath = await chromium.executablePath();
  console.log('[Pagi] Chrome path:', executablePath);

  try {
    const scraperOptions = {
      companyId: CompanyTypes.pagi,
      startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      combineInstallments: false,
      showBrowser: false,
      headless: chromium.headless,
      executablePath,
      args: chromium.args,
      timeout: 60000,
    };

    const scraper = createScraper(scraperOptions);

    console.log('[Pagi] Logging in...');
    const result = await scraper.scrape({ username, password });

    if (!result.success) {
      throw new Error('Scraper failed: ' + (result.errorMessage || 'unknown error'));
    }

    const accounts = result.accounts;
    if (!accounts || accounts.length === 0) throw new Error('No accounts returned');

    console.log(`[Pagi] ✅ Scraped ${accounts.length} account(s)`);

    for (const account of accounts) {
      const payload = {
        source: 'pagi',
        user_id: USER_ID,
        account_id: account.accountNumber || 'auto',
        balance: account.balance,
        transactions: account.txns || [],
        fetched_at: new Date().toISOString(),
      };

      console.log(`[Pagi] Pushing ${payload.transactions.length} transactions...`);

      const res = await axios.post(SUPABASE_PUSH_URL, payload, {
        headers: {
          'x-scraper-api-key': SCRAPER_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });

      console.log('[Pagi] Push response:', res.data);
    }

    console.log('[Pagi] ✅ Sync complete');
  } catch (error) {
    console.error('[Pagi] ❌ Error:', error.message);
    throw error;
  }
}

scrapeAndPush().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
