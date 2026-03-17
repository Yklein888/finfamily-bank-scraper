/**
 * GitHub Actions scraper for Cal (Visa Cal) bank
 * Runs every 6 hours, pushes to Supabase via bank-push Edge Function
 */

import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import axios from 'axios';

const SUPABASE_PUSH_URL = 'https://tzhhilhiheekhcpdexdc.supabase.co/functions/v1/bank-push';
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const USER_ID = '16274024-a305-4416-ba62-9b321669d7d6'; // yklein89@gmail.com

async function scrapeAndPush() {
  const username = process.env.CAL_USERNAME;
  const password = process.env.CAL_PASSWORD;

  if (!username || !password) {
    console.log('[Cal] ⏭️ Skipping - no credentials in secrets');
    return;
  }

  if (!SCRAPER_API_KEY) {
    throw new Error('Missing SCRAPER_API_KEY in GitHub secrets');
  }

  console.log('[Cal] Starting scrape at', new Date().toISOString());

  try {
    const scraper = createScraper({
      companyId: CompanyTypes.visaCal,
      startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      combineInstallments: false,
      showBrowser: false,
      headless: true,
      timeout: 60000,
    });

    console.log('[Cal] Logging in...');
    const accounts = await scraper.scrape({ username, password });

    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts returned from scraper');
    }

    console.log(`[Cal] ✅ Scraped ${accounts.length} account(s)`);

    // Push to Supabase via bank-push Edge Function
    for (const account of accounts) {
      const payload = {
        source: 'cal',
        user_id: USER_ID,
        account_id: null, // Will be auto-detected by Edge Function
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

      console.log(`[Cal] Push response:`, res.data);
    }

    console.log('[Cal] ✅ Sync complete');
  } catch (error) {
    console.error('[Cal] ❌ Error:', error.message);
    throw error;
  }
}

scrapeAndPush().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
