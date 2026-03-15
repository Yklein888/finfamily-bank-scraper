import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { createClient } from '@supabase/supabase-js';
import { CompanyTypes, createScraper } from 'israeli-bank-scrapers';

dotenv.config();

const app = express();
app.use(express.json());
app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Lazy initialize Supabase to avoid startup errors if env vars are missing
let supabase = null;
function getSupabase() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    }
    supabase = createClient(url, key);
  }
  return supabase;
}

const PROVIDER_MAP = {
  'hapoalim': CompanyTypes.hapoalim,
  'cal':      CompanyTypes.cal,
  'visaCal':  CompanyTypes.visaCal,  // Frontend sends 'visaCal', backend uses 'cal'
  'fibi':     CompanyTypes.fibi,     // Pagi (פועלי אגודת ישראל)
};

// Chrome binary - try @sparticuz/chromium first
let chromium = null;
(async () => {
  try {
    chromium = (await import('@sparticuz/chromium')).default;
  } catch (e) {
    console.log('[Init] @sparticuz/chromium not available, will use PUPPETEER_EXECUTABLE_PATH or system Chrome');
  }
})();

async function getChromePath() {
  if (chromium) return await chromium.executablePath();
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  return undefined;
}

async function scrapeProvider(providerType, credentials, attempt = 1) {
  const maxAttempts = 3;
  const execPath = await getChromePath();
  if (!execPath) {
    throw new Error('No Chrome binary available. Server needs @sparticuz/chromium or PUPPETEER_EXECUTABLE_PATH.');
  }
  const defaultArgs = chromium ? chromium.args : [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
    '--single-process', '--no-zygote'
  ];

  // Comprehensive anti-detection arguments for Israeli banks (especially Hapoalim)
  const stealthArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-web-resources',
    '--disable-default-apps',
    '--disable-preconnect',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-plugins-power-saver',
    '--disable-breakpad',
    '--disable-extensions',
    '--disable-features=VizDisplayCompositor',
    '--disable-component-extensions-with-background-pages',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-notifications',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-reading-from-canvas',
    '--no-first-run',
    '--no-default-browser-check',
    '--metrics-recording-only',
    '--disable-plugins',
    '--disable-images',  // Don't load images - faster
    'user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  ];

  // Use a persistent user data directory for cookies
  const userDataDir = `/tmp/puppeteer-${providerType}-${Date.now() % 1000}`;
  const userDataArgs = [`--user-data-dir=${userDataDir}`];

  try {
    console.log('[Scraper] Starting with settings: headless=false, showBrowser=true, timeout=180s');

    // Try with headless: false (showBrowser: true) to avoid detection
    // Some banks (like Hapoalim) detect Puppeteer in headless mode
    const scraper = createScraper({
      companyId: providerType,
      startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      combineInstallments: false,
      showBrowser: true,  // CHANGED: Try with browser visible
      executablePath: execPath,
      args: [
        ...defaultArgs,
        '--disable-dev-shm-usage',
        ...stealthArgs,
        ...userDataArgs,  // Persistent user data dir
        '--start-maximized',  // Maximize window
      ],
      timeout: 180000, // Increased to 3 minutes
      headless: false,  // Explicitly disable headless mode
    });

    // Add hard timeout with Promise.race to prevent hanging
    const TIMEOUT_MS = 180000; // 3 minutes
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Scraper timeout after ' + TIMEOUT_MS + 'ms')), TIMEOUT_MS);
    });

    const result = await Promise.race([scraper.scrape(credentials), timeoutPromise]);
    if (!result.success) {
      console.error('[Scraper] Error:', result.errorMessage);
      throw new Error(result.errorMessage || 'Scraping failed');
    }
    console.log('[Scraper] Success! Found ' + result.accounts.length + ' accounts');
    return result.accounts;
  } catch (error) {
    // Retry with exponential backoff
    if (attempt < maxAttempts) {
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // 1s, 2s, 4s...
      console.log(`[Retry] Attempt ${attempt}/${maxAttempts} failed. Retrying in ${delayMs}ms for provider ${providerType}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return scrapeProvider(providerType, credentials, attempt + 1);
    }
    throw error;
  }
}

async function verifyAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.error('[Auth] No valid Authorization header');
    return null;
  }
  const token = authHeader.split(' ')[1];
  try {
    const { data, error } = await getSupabase().auth.getUser(token);
    if (error) {
      console.error('[Auth] Supabase auth error:', error.message, error.status);
      return null;
    }
    if (!data?.user) {
      console.error('[Auth] No user in response data');
      return null;
    }
    console.log('[Auth] User verified:', data.user.id);
    return data.user;
  } catch (err) {
    console.error('[Auth] Token verification exception:', err.message);
    return null;
  }
}

async function saveTransactionsToSupabase(userId, accounts, providerName) {
  let totalSaved = 0;
  let totalSkipped = 0;

  for (const account of accounts) {
    const accountNumber = account.accountNumber || providerName;
    const { data: existingAccount } = await getSupabase()
      .from('accounts').select('id')
      .eq('user_id', userId)
      .eq('account_number', accountNumber)
      .single();

    let accountId;
    if (existingAccount) {
      accountId = existingAccount.id;
      await getSupabase().from('accounts').update({
        balance: account.balance || 0,
        last_sync: new Date().toISOString(),
        is_synced: true,
      }).eq('id', accountId);
    } else {
      const { data: newAccount, error: insertErr } = await getSupabase().from('accounts').insert({
        user_id: userId,
        name: providerName + ' - ' + accountNumber,
        bank_name: providerName,
        account_number: accountNumber,
        balance: account.balance || 0,
        currency: 'ILS',
        account_type: 'checking',
        last_sync: new Date().toISOString(),
        is_synced: true,
      }).select('id').single();
      if (insertErr) { console.error('Account insert error:', insertErr.message); continue; }
      accountId = newAccount ? newAccount.id : null;
    }
    if (!accountId) continue;

    for (const txn of (account.txns || [])) {
      const txnDate = new Date(txn.date).toISOString().split('T')[0];
      const amount = Math.abs(txn.chargedAmount || txn.originalAmount || 0);
      const type = (txn.chargedAmount || txn.originalAmount || 0) < 0 ? 'expense' : 'income';

      // Dedup check using correct column name
      const { data: existing } = await getSupabase()
        .from('transactions').select('id')
        .eq('user_id', userId).eq('account_id', accountId)
        .eq('amount', amount)
        .eq('transaction_date', txnDate)
        .eq('description', txn.description || '')
        .single();
      if (existing) { totalSkipped++; continue; }

      const { error: txnErr } = await getSupabase().from('transactions').insert({
        user_id: userId,
        account_id: accountId,
        amount,
        type,
        description: txn.description || 'transaction',
        transaction_date: txnDate,
        notes: txn.memo || null,
      });
      if (txnErr) {
        console.error('Transaction insert error:', txnErr.message);
      } else {
        totalSaved++;
      }
    }
  }
  return { totalSaved, totalSkipped };
}

function autoCategorizeTxn(description) {
  if (!description) return null;
  const desc = description.toLowerCase();
  const rules = [
    { keywords: ['super', 'market', 'rami levi', 'shufersal', 'victory'], category: 1 },
    { keywords: ['fuel', 'paz', 'sonol', 'delek'], category: 2 },
    { keywords: ['parking'], category: 3 },
    { keywords: ['restaurant', 'cafe', 'pizza', 'sushi'], category: 4 },
    { keywords: ['electric', 'water', 'gas', 'arnona'], category: 5 },
    { keywords: ['bezeq', 'hot', 'cellcom', 'partner'], category: 6 },
    { keywords: ['insurance', 'bituach'], category: 7 },
    { keywords: ['doctor', 'maccabi', 'clalit', 'hospital'], category: 8 },
    { keywords: ['cinema', 'amazon', 'netflix', 'spotify', 'apple'], category: 9 },
    { keywords: ['salary', 'income'], category: 10 },
  ];
  for (const rule of rules) {
    if (rule.keywords.some(kw => desc.includes(kw))) return rule.category;
  }
  return null;
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'FinFamily Bank Scraper', timestamp: new Date(), chromium: !!chromium });
});

app.get('/providers', (req, res) => {
  res.json({
    banks: [
      { id: 'hapoalim', name: 'Bank Hapoalim', type: 'bank' },
      { id: 'leumi', name: 'Bank Leumi', type: 'bank' },
      { id: 'discount', name: 'Bank Discount', type: 'bank' },
      { id: 'mizrahi', name: 'Mizrahi Tefahot', type: 'bank' },
      { id: 'beinleumi', name: 'Beinleumi', type: 'bank' },
    ],
    creditCards: [
      { id: 'isracard', name: 'Isracard', type: 'credit' },
      { id: 'cal', name: 'Cal', type: 'credit' },
      { id: 'max', name: 'Max', type: 'credit' },
      { id: 'visaCal', name: 'Visa Cal', type: 'credit' },
      { id: 'amex', name: 'Amex', type: 'credit' },
    ]
  });
});

async function logSyncAttempt(userId, provider, status, errorMessage = null, transactionsAdded = 0) {
  try {
    // Find the connection to link the sync history
    const { data: connection } = await getSupabase()
      .from('open_banking_connections')
      .select('id')
      .eq('user_id', userId)
      .eq('provider_code', provider)
      .single();

    await getSupabase().from('sync_history').insert({
      user_id: userId,
      connection_id: connection?.id || null,
      sync_type: 'manual', // or 'automatic' for cron jobs
      sync_status: status === 'success' ? 'success' : 'failed',
      transactions_added: transactionsAdded || 0,
      error_message: errorMessage,
      sync_start: new Date().toISOString(),
      sync_end: new Date().toISOString(),
    });
  } catch (err) {
    // Silently fail - don't break the sync if logging fails
    console.error('[Log] Failed to record sync history:', err.message);
  }
}

app.post('/scrape', async (req, res) => {
  const user = await verifyAuthToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication failed' });
  const { provider, credentials } = req.body;
  if (!provider || !credentials) return res.status(400).json({ error: 'Missing provider or credentials' });
  const providerType = PROVIDER_MAP[provider];
  if (!providerType) return res.status(400).json({ error: 'Unsupported provider: ' + provider });

  const startTime = Date.now();
  try {
    console.log('[' + new Date().toISOString() + '] Scraping ' + provider + ' for user ' + user.id);
    const accounts = await scrapeProvider(providerType, credentials);
    const { totalSaved, totalSkipped } = await saveTransactionsToSupabase(user.id, accounts, provider);

    // Upsert open_banking_connections so UI shows the bank as active
    await getSupabase().from('open_banking_connections').upsert({
      user_id: user.id,
      provider_name: provider,
      provider_code: provider,
      connection_status: 'active',
      last_sync: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider_code' });

    const duration = Date.now() - startTime;
    await logSyncAttempt(user.id, provider, 'success', null, totalSaved);
    console.log('[' + new Date().toISOString() + '] Done! Saved: ' + totalSaved + ', Skipped: ' + totalSkipped + ', Duration: ' + duration + 'ms');
    res.json({ success: true, message: 'Sync complete', transactionsAdded: totalSaved, totalSkipped, accountsCount: accounts.length, duration });
  } catch (error) {
    const duration = Date.now() - startTime;
    await logSyncAttempt(user.id, provider, 'failed', error.message, 0);
    console.error('[' + new Date().toISOString() + '] Error after ' + duration + 'ms:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Scraping error', duration });
  }
});

// Bank-specific scrape endpoints (Cal + Hapoalim)
app.post('/scrape/hapoalim', async (req, res) => {
  const user = await verifyAuthToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication failed' });

  const { credentials } = req.body;
  if (!credentials || !credentials.username || !credentials.password) {
    return res.status(400).json({ error: 'Missing credentials (username, password)' });
  }

  const startTime = Date.now();
  try {
    console.log('[Hapoalim] Scraping for user ' + user.id);
    const accounts = await scrapeProvider(CompanyTypes.hapoalim, credentials);
    const { totalSaved, totalSkipped } = await saveTransactionsToSupabase(user.id, accounts, 'hapoalim');

    await getSupabase().from('open_banking_connections').upsert({
      user_id: user.id,
      provider_name: 'Bank Hapoalim',
      provider_code: 'hapoalim',
      connection_status: 'active',
      last_sync: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider_code' });

    const duration = Date.now() - startTime;
    await logSyncAttempt(user.id, 'hapoalim', 'success', null, totalSaved);
    console.log('[Hapoalim] Done! Saved: ' + totalSaved + ', Skipped: ' + totalSkipped + ', Duration: ' + duration + 'ms');
    res.json({ success: true, message: 'Hapoalim sync complete', transactionsAdded: totalSaved, totalSkipped, accountsCount: accounts.length, duration });
  } catch (error) {
    const duration = Date.now() - startTime;
    await logSyncAttempt(user.id, 'hapoalim', 'failed', error.message, 0);
    console.error('[Hapoalim] Error after ' + duration + 'ms:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Scraping error', duration });
  }
});

app.post('/scrape/cal', async (req, res) => {
  const user = await verifyAuthToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication failed' });

  const { credentials } = req.body;
  if (!credentials || !credentials.username || !credentials.password) {
    return res.status(400).json({ error: 'Missing credentials (username, password)' });
  }

  const startTime = Date.now();
  try {
    console.log('[Cal] Scraping for user ' + user.id);
    const accounts = await scrapeProvider(CompanyTypes.cal, credentials);
    const { totalSaved, totalSkipped } = await saveTransactionsToSupabase(user.id, accounts, 'cal');

    await getSupabase().from('open_banking_connections').upsert({
      user_id: user.id,
      provider_name: 'Visa Cal',
      provider_code: 'cal',
      connection_status: 'active',
      last_sync: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider_code' });

    const duration = Date.now() - startTime;
    await logSyncAttempt(user.id, 'cal', 'success', null, totalSaved);
    console.log('[Cal] Done! Saved: ' + totalSaved + ', Skipped: ' + totalSkipped + ', Duration: ' + duration + 'ms');
    res.json({ success: true, message: 'Cal sync complete', transactionsAdded: totalSaved, totalSkipped, accountsCount: accounts.length, duration });
  } catch (error) {
    const duration = Date.now() - startTime;
    await logSyncAttempt(user.id, 'cal', 'failed', error.message, 0);
    console.error('[Cal] Error after ' + duration + 'ms:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Scraping error', duration });
  }
});

// Pagi (פועלי אגודת ישראל) scraper endpoint
app.post('/scrape/pagi', async (req, res) => {
  const user = await verifyAuthToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication failed' });

  const { credentials } = req.body;
  if (!credentials || !credentials.username || !credentials.password) {
    return res.status(400).json({ error: 'Missing credentials (username, password)' });
  }

  const startTime = Date.now();
  try {
    console.log('[Pagi] Scraping for user ' + user.id);
    const accounts = await scrapeProvider(CompanyTypes.fibi, credentials);
    const { totalSaved, totalSkipped } = await saveTransactionsToSupabase(user.id, accounts, 'pagi');

    await getSupabase().from('open_banking_connections').upsert({
      user_id: user.id,
      provider_name: 'בנק פאגי',
      provider_code: 'pagi',
      connection_status: 'active',
      last_sync: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider_code' });

    const duration = Date.now() - startTime;
    await logSyncAttempt(user.id, 'pagi', 'success', null, totalSaved);
    console.log('[Pagi] Done! Saved: ' + totalSaved + ', Skipped: ' + totalSkipped + ', Duration: ' + duration + 'ms');
    res.json({ success: true, message: 'Pagi sync complete', transactionsAdded: totalSaved, totalSkipped, accountsCount: accounts.length, duration });
  } catch (error) {
    const duration = Date.now() - startTime;
    await logSyncAttempt(user.id, 'pagi', 'failed', error.message, 0);
    console.error('[Pagi] Error after ' + duration + 'ms:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Scraping error', duration });
  }
});


app.post('/sync-all', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });

  const startTime = Date.now();
  try {
    const { data: connections } = await getSupabase().from('bank_connections').select('*').eq('auto_sync', true);
    const results = [];

    console.log('[SYNC-ALL] Starting sync for ' + (connections?.length || 0) + ' connections');

    for (const conn of (connections || [])) {
      const connStartTime = Date.now();
      try {
        const creds = JSON.parse(Buffer.from(conn.encrypted_credentials, 'base64').toString());
        const pt = PROVIDER_MAP[conn.provider];
        if (!pt) {
          results.push({ provider: conn.provider, userId: conn.user_id, success: false, error: 'Unsupported provider' });
          continue;
        }

        const accounts = await scrapeProvider(pt, creds);
        const stats = await saveTransactionsToSupabase(conn.user_id, accounts, conn.provider);

        // Update connection status
        await getSupabase().from('open_banking_connections').upsert({
          user_id: conn.user_id,
          provider_name: conn.provider,
          provider_code: conn.provider,
          connection_status: 'active',
          last_sync: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,provider_code' });

        const duration = Date.now() - connStartTime;
        await logSyncAttempt(conn.user_id, conn.provider, 'success', null, stats.totalSaved);
        results.push({ provider: conn.provider, userId: conn.user_id, ...stats, success: true, duration });
        console.log('[SYNC-ALL] ✓ ' + conn.provider + ' synced (' + duration + 'ms)');
      } catch (err) {
        const duration = Date.now() - connStartTime;
        await logSyncAttempt(conn.user_id, conn.provider, 'failed', err.message, 0);
        results.push({ provider: conn.provider, userId: conn.user_id, success: false, error: err.message, duration });
        console.error('[SYNC-ALL] ✗ ' + conn.provider + ' failed (' + duration + 'ms):', err.message);
      }
    }

    const totalDuration = Date.now() - startTime;
    console.log('[SYNC-ALL] Complete! Total duration: ' + totalDuration + 'ms');
    res.json({ success: true, results, totalDuration });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

cron.schedule('0 2 * * *', async () => {
  console.log('[CRON] Nightly sync starting...');
  const startTime = Date.now();
  let totalSucceeded = 0;
  let totalFailed = 0;

  try {
    const { data: connections } = await getSupabase().from('bank_connections').select('*').eq('auto_sync', true);
    console.log('[CRON] Found ' + (connections?.length || 0) + ' connections to sync');

    for (const conn of (connections || [])) {
      const connStartTime = Date.now();
      try {
        const creds = JSON.parse(Buffer.from(conn.encrypted_credentials, 'base64').toString());
        const pt = PROVIDER_MAP[conn.provider];
        if (!pt) {
          console.log('[CRON] Unsupported provider: ' + conn.provider);
          continue;
        }

        const accounts = await scrapeProvider(pt, creds);
        const { totalSaved } = await saveTransactionsToSupabase(conn.user_id, accounts, conn.provider);

        // Update connection status to active
        await getSupabase().from('open_banking_connections').upsert({
          user_id: conn.user_id,
          provider_name: conn.provider,
          provider_code: conn.provider,
          connection_status: 'active',
          last_sync: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,provider_code' });

        const duration = Date.now() - connStartTime;
        await logSyncAttempt(conn.user_id, conn.provider, 'success', null, totalSaved);
        console.log('[CRON] ✓ ' + conn.provider + ' synced (' + totalSaved + ' transactions, ' + duration + 'ms)');
        totalSucceeded++;
      } catch (err) {
        const duration = Date.now() - connStartTime;
        await logSyncAttempt(conn.user_id, conn.provider, 'failed', err.message, 0);
        console.error('[CRON] ✗ ' + conn.provider + ' failed (' + duration + 'ms):', err.message);
        totalFailed++;
      }
    }

    const totalDuration = Date.now() - startTime;
    console.log('[CRON] Done! Succeeded: ' + totalSucceeded + ', Failed: ' + totalFailed + ', Total: ' + totalDuration + 'ms');
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    console.error('[CRON] Fatal error after ' + totalDuration + 'ms:', error.message);
  }
}, { timezone: 'Asia/Jerusalem' });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('FinFamily Bank Scraper running on port ' + PORT);
  console.log('Chrome: ' + (chromium ? '@sparticuz/chromium' : (process.env.PUPPETEER_EXECUTABLE_PATH || 'none')));
});
