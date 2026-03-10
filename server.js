require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { CompanyTypes, createScraper } = require('israeli-bank-scrapers');

const app = express();
app.use(express.json());
app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const PROVIDER_MAP = {
  'hapoalim':     CompanyTypes.hapoalim,
  'leumi':        CompanyTypes.leumi,
  'discount':     CompanyTypes.discount,
  'mizrahi':      CompanyTypes.mizrahi,
  'otsarHahayal': CompanyTypes.otsarHahayal,
  'union':        CompanyTypes.unionBank,
  'beinleumi':    CompanyTypes.beinleumi,
    'fibi':         CompanyTypes.fibi,
    'yahav':        CompanyTypes.yahav,
  'massad':       CompanyTypes.massad,
  'isracard':     CompanyTypes.isracard,
  'cal':          CompanyTypes.cal,
  'max':          CompanyTypes.max,
  'visaCal':      CompanyTypes.visaCal,
  'diners':       CompanyTypes.diners,
  'amex':         CompanyTypes.amex,
};

// Chrome binary - try @sparticuz/chromium first
let chromium = null;
try { chromium = require('@sparticuz/chromium'); } catch (e) {}

async function getChromePath() {
  if (chromium) return await chromium.executablePath();
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  return undefined;
}

async function scrapeProvider(providerType, credentials) {
  const execPath = await getChromePath();
  if (!execPath) {
    throw new Error('No Chrome binary available. Server needs @sparticuz/chromium or PUPPETEER_EXECUTABLE_PATH.');
  }
  const defaultArgs = chromium ? chromium.args : [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
    '--single-process', '--no-zygote'
  ];

  const scraper = createScraper({
    companyId: providerType,
    startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    combineInstallments: false,
    showBrowser: false,
    executablePath: execPath,
    args: [...defaultArgs, '--disable-dev-shm-usage'],
  });

  const result = await scraper.scrape(credentials);
  if (!result.success) throw new Error(result.errorMessage || 'Scraping failed');
  return result.accounts;
}

async function verifyAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

async function saveTransactionsToSupabase(userId, accounts, providerName) {
  let totalSaved = 0;
  let totalSkipped = 0;

  for (const account of accounts) {
    const accountNumber = account.accountNumber || providerName;
    const { data: existingAccount } = await supabase
      .from('accounts').select('id')
      .eq('user_id', userId)
      .eq('account_number', accountNumber)
      .single();

    let accountId;
    if (existingAccount) {
      accountId = existingAccount.id;
      await supabase.from('accounts').update({
        balance: account.balance || 0,
        last_sync: new Date().toISOString(),
        is_synced: true,
      }).eq('id', accountId);
    } else {
      const { data: newAccount, error: insertErr } = await supabase.from('accounts').insert({
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
      const { data: existing } = await supabase
        .from('transactions').select('id')
        .eq('user_id', userId).eq('account_id', accountId)
        .eq('amount', amount)
        .eq('transaction_date', txnDate)
        .eq('description', txn.description || '')
        .single();
      if (existing) { totalSkipped++; continue; }

      const { error: txnErr } = await supabase.from('transactions').insert({
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

app.post('/scrape', async (req, res) => {
  const user = await verifyAuthToken(req);
  if (!user) return res.status(401).json({ error: 'Authentication failed' });
  const { provider, credentials } = req.body;
  if (!provider || !credentials) return res.status(400).json({ error: 'Missing provider or credentials' });
  const providerType = PROVIDER_MAP[provider];
  if (!providerType) return res.status(400).json({ error: 'Unsupported provider: ' + provider });

  try {
    console.log('[' + new Date().toISOString() + '] Scraping ' + provider + ' for user ' + user.id);
    const accounts = await scrapeProvider(providerType, credentials);
    const { totalSaved, totalSkipped } = await saveTransactionsToSupabase(user.id, accounts, provider);

    // Upsert open_banking_connections so UI shows the bank as active
    await supabase.from('open_banking_connections').upsert({
      user_id: user.id,
      provider_name: provider,
      provider_code: provider,
      connection_status: 'active',
      last_sync: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider_code' });

    console.log('[' + new Date().toISOString() + '] Done! Saved: ' + totalSaved + ', Skipped: ' + totalSkipped);
    res.json({ success: true, message: 'Sync complete', transactionsAdded: totalSaved, totalSkipped, accountsCount: accounts.length });
  } catch (error) {
    console.error('[' + new Date().toISOString() + '] Error:', error.message);
    res.status(500).json({ success: false, error: error.message || 'Scraping error' });
  }
});

app.post('/sync-all', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { data: connections } = await supabase.from('bank_connections').select('*').eq('auto_sync', true);
    const results = [];
    for (const conn of (connections || [])) {
      try {
        const creds = JSON.parse(Buffer.from(conn.encrypted_credentials, 'base64').toString());
        const pt = PROVIDER_MAP[conn.provider];
        if (!pt) continue;
        const accounts = await scrapeProvider(pt, creds);
        const stats = await saveTransactionsToSupabase(conn.user_id, accounts, conn.provider);
        results.push({ provider: conn.provider, userId: conn.user_id, ...stats, success: true });
      } catch (err) {
        results.push({ provider: conn.provider, userId: conn.user_id, success: false, error: err.message });
      }
    }
    res.json({ success: true, results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

cron.schedule('0 2 * * *', async () => {
  console.log('[CRON] Nightly sync...');
  try {
    const { data: connections } = await supabase.from('bank_connections').select('*').eq('auto_sync', true);
    for (const conn of (connections || [])) {
      try {
        const creds = JSON.parse(Buffer.from(conn.encrypted_credentials, 'base64').toString());
        const pt = PROVIDER_MAP[conn.provider];
        if (!pt) continue;
        const accounts = await scrapeProvider(pt, creds);
        await saveTransactionsToSupabase(conn.user_id, accounts, conn.provider);
        console.log('[CRON] Synced ' + conn.provider);
      } catch (err) {
        console.error('[CRON] Error ' + conn.provider + ':', err.message);
      }
    }
  } catch (error) {
    console.error('[CRON] Fatal:', error);
  }
}, { timezone: 'Asia/Jerusalem' });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log('FinFamily Bank Scraper running on port ' + PORT);
  console.log('Chrome: ' + (chromium ? '@sparticuz/chromium' : (process.env.PUPPETEER_EXECUTABLE_PATH || 'none')));
});
