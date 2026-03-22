import { existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createScraper, CompanyTypes } from 'israeli-bank-scrapers';
import axios from 'axios';

const SUPABASE_PUSH_URL = 'https://tzhhilhiheekhcpdexdc.supabase.co/functions/v1/bank-push';
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const USER_ID = '16274024-a305-4416-ba62-9b321669d7d6';

async function getChromePath() {
  if (process.platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ];
    for (const p of candidates) {
      if (existsSync(p)) { console.log('[Pagi] Using system Chrome:', p); return p; }
    }
    return undefined;
  } else {
    const { default: chromium } = await import('@sparticuz/chromium');
    const path = await chromium.executablePath();
    console.log('[Pagi] Using sparticuz chromium:', path);
    return path;
  }
}

async function scrapeAndPush() {
  const username = process.env.PAGI_USERNAME;
  const password = process.env.PAGI_PASSWORD;
  console.log('[Pagi] ENV check:', { username: username ? 'ok' : 'MISSING', password: password ? 'ok' : 'MISSING', scraperKey: SCRAPER_API_KEY ? 'ok' : 'MISSING', platform: process.platform });
  if (!username || !password) throw new Error('Missing credentials');
  if (!SCRAPER_API_KEY) throw new Error('Missing SCRAPER_API_KEY');
  console.log('[Pagi] Starting scrape at', new Date().toISOString());
  const executablePath = await getChromePath();
  const userDataDir = join(tmpdir(), 'pagi-scraper-profile');
  mkdirSync(userDataDir, { recursive: true });
  console.log('[Pagi] userDataDir:', userDataDir);
  const scraperOptions = {
    companyId: CompanyTypes.pagi,
    startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    combineInstallments: false,
    showBrowser: false,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--user-data-dir=' + userDataDir],
    timeout: 90000,
  };
  if (executablePath) scraperOptions.executablePath = executablePath;
  console.log('[Pagi] Logging in...');
  const scraper = createScraper(scraperOptions);
  const result = await scraper.scrape({ username, password });
  console.log('[Pagi] Scrape result success:', result.success, '| error:', result.errorMessage || 'none');
  if (!result.success) throw new Error('Scraper failed: ' + (result.errorMessage || 'unknown'));
  const accounts = result.accounts;
  console.log('[Pagi] Accounts returned:', accounts ? accounts.length : 0);
  if (!accounts || accounts.length === 0) throw new Error('No accounts returned');
  for (const account of accounts) {
    console.log('[Pagi] Account:', account.accountNumber, '| txns:', account.txns ? account.txns.length : 0);
    const payload = {
      source: 'pagi',
      user_id: USER_ID,
      account_id: account.accountNumber || 'auto',
      balance: account.balance,
      transactions: account.txns || [],
      fetched_at: new Date().toISOString(),
    };
    const res = await axios.post(SUPABASE_PUSH_URL, payload, {
      headers: { 'x-scraper-api-key': SCRAPER_API_KEY, 'Content-Type': 'application/json' },
      timeout: 30000,
    });
    console.log('[Pagi] Push response:', JSON.stringify(res.data));
  }
  console.log('[Pagi] Sync complete');
}

scrapeAndPush().catch(err => { console.error('[Pagi] Fatal:', err.message); process.exit(1); });