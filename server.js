require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const { CompanyTypes, createScraper } = require('israeli-bank-scrapers');
const chromium = require('@sparticuz/chromium');

const app = express();
app.use(express.json());
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Supabase client (service role for DB writes)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Provider map - israeli-bank-scrapers CompanyTypes
const PROVIDER_MAP = {
  'hapoalim':     CompanyTypes.hapoalim,
  'leumi':        CompanyTypes.leumi,
  'discount':     CompanyTypes.discount,
  'mizrahi':      CompanyTypes.mizrahi,
  'otsarHahayal': CompanyTypes.otsarHahayal,
  'union':        CompanyTypes.unionBank,
  'beinleumi':    CompanyTypes.beinleumi,
  'massad':       CompanyTypes.massad,
  'isracard':     CompanyTypes.isracard,
  'cal':          CompanyTypes.cal,
  'max':          CompanyTypes.max,
  'visaCal':      CompanyTypes.visaCal,
  'diners':       CompanyTypes.diners,
  'amex':         CompanyTypes.amex,
};

async function scrapeProvider(providerType, credentials) {
  // Use system Chrome, env override, or @sparticuz/chromium as fallback
  const execPath = process.env.PUPPETEER_EXECUTABLE_PATH || await chromium.executablePath();

  const scraper = createScraper({
    companyId: providerType,
    startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    combineInstallments: false,
    showBrowser: false,
    executablePath: execPath,
    args: [
      ...chromium.args,
      '--disable-dev-shm-usage',
    ],
  });

  const result = await scraper.scrape(credentials);

  if (!result.success) {
    throw new Error(result.errorMessage || 'Scraping failed');
  }

  return result.accounts;
}

// Verify Supabase auth token and return user
async function verifyAuthToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.split(' ')[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

async function saveTransactionsToSupabase(userId, accounts, providerName) {
  let totalSaved = 0;
  let totalSkipped = 0;

  for (const account of accounts) {
    const { data: existingAccount } = await supabase
      .from('accounts')
      .select('id')
      .eq('user_id', userId)
      .eq('account_number', account.accountNumber || providerName)
      .single();

    let accountId;

    if (existingAccount) {
      accountId = existingAccount.id;
      await supabase
        .from('accounts')
        .update({
          balance: account.balance || 0,
          last_sync: new Date().toISOString()
        })
        .eq('id', accountId);
    } else {
      const { data: newAccount } = await supabase
        .from('accounts')
        .insert({
          user_id: userId,
          name: `${providerName} - ${account.accountNumber || 'ראשי'}`,
          account_number: account.accountNumber || providerName,
          balance: account.balance || 0,
          currency: 'ILS',
          account_type: 'checking',
          last_sync: new Date().toISOString()
        })
        .select('id')
        .single();

      accountId = newAccount?.id;
    }

    if (!accountId) continue;

    for (const txn of (account.txns || [])) {
      const { data: existing } = await supabase
        .from('transactions')
        .select('id')
        .eq('user_id', userId)
        .eq('account_id', accountId)
        .eq('amount', Math.abs(txn.chargedAmount || txn.originalAmount))
        .eq('date', new Date(txn.date).toISOString().split('T')[0])
        .eq('description', txn.description)
        .single();

      if (existing) {
        totalSkipped++;
        continue;
      }

      const category = autoCategorizeTxn(txn.description);
      const amount = Math.abs(txn.chargedAmount || txn.originalAmount);
      const type = (txn.chargedAmount || txn.originalAmount) < 0 ? 'expense' : 'income';

      await supabase
        .from('transactions')
        .insert({
          user_id: userId,
          account_id: accountId,
          amount: amount,
          type: type,
          description: txn.description || 'עסקה',
          date: new Date(txn.date).toISOString().split('T')[0],
          status: txn.status || 'completed',
          category_id: category,
          source: 'bank_sync',
          original_currency: txn.originalCurrency || 'ILS',
          memo: txn.memo || null,
        });

      totalSaved++;
    }
  }

  return { totalSaved, totalSkipped };
}

function autoCategorizeTxn(description = '') {
  const desc = description.toLowerCase();
  const rules = [
    { keywords: ['סופר', 'מרקט', 'רמי לוי', 'שופרסל', 'יינות ביתן', 'מחסני השוק', 'victory'], category: 1 },
    { keywords: ['דלק', 'פז', 'סונול', 'דור אלון', 'תן', 'גז'], category: 2 },
    { keywords: ['חניה', 'פארקינג', 'parking'], category: 3 },
    { keywords: ['מסעדה', 'קפה', 'cafe', 'pizza', 'פיצה', 'סושי', 'מאפה'], category: 4 },
    { keywords: ['חשמל', 'מים', 'גז', 'ועד בית', 'ארנונה'], category: 5 },
    { keywords: ['בזק', 'hot', 'cellcom', 'partner', 'פרטנר', 'סלקום', 'רכב'], category: 6 },
    { keywords: ['ביטוח', 'insurance', 'מגדל', 'הפניקס', 'כלל', 'מנורה'], category: 7 },
    { keywords: ['רופא', 'קופת חולים', 'מכבי', 'כללית', 'בית חולים', 'תרופ'], category: 8 },
    { keywords: ['סינמה', 'קולנוע', 'אמזון', 'netflix', 'spotify', 'apple'], category: 9 },
    { keywords: ['משכורת', 'שכר', 'salary', 'הכנסה'], category: 10 },
  ];
  for (const rule of rules) {
    if (rule.keywords.some(kw => desc.includes(kw))) return rule.category;
  }
  return null;
}

// ==================
// API ENDPOINTS
// ==================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'FinFamily Bank Scraper Server', timestamp: new Date() });
});

app.get('/providers', (req, res) => {
  res.json({
    banks: [
      { id: 'hapoalim', name: 'בנק הפועלים', logo: '🏦', type: 'bank' },
      { id: 'leumi', name: 'בנק לאומי', logo: '🏦', type: 'bank' },
      { id: 'discount', name: 'בנק דיסקונט', logo: '🏦', type: 'bank' },
      { id: 'mizrahi', name: 'מזרחי טפחות', logo: '🏦', type: 'bank' },
      { id: 'beinleumi', name: 'הבינלאומי', logo: '🏦', type: 'bank' },
    ],
    creditCards: [
      { id: 'isracard', name: 'ישראכרט', logo: '💳', type: 'credit' },
      { id: 'cal', name: 'כאל', logo: '💳', type: 'credit' },
      { id: 'max', name: 'מקס (לאומי קארד)', logo: '💳', type: 'credit' },
      { id: 'visaCal', name: 'ויזה כאל', logo: '💳', type: 'credit' },
      { id: 'amex', name: 'אמריקן אקספרס', logo: '💳', type: 'credit' },
    ]
  });
});

// Manual scrape - authenticated via Supabase token
app.post('/scrape', async (req, res) => {
  const user = await verifyAuthToken(req);
  if (!user) {
    return res.status(401).json({ error: 'אימות נכשל - נא להתחבר מחדש' });
  }

  const { provider, credentials } = req.body;
  const userId = user.id;

  if (!provider || !credentials) {
    return res.status(400).json({ error: 'חסרים פרטים: provider, credentials' });
  }

  const providerType = PROVIDER_MAP[provider];
  if (!providerType) {
    return res.status(400).json({ error: `ספק לא נתמך: ${provider}` });
  }

  try {
    console.log(`[${new Date().toISOString()}] Scraping ${provider} for user ${userId}...`);
    const accounts = await scrapeProvider(providerType, credentials);
    const { totalSaved, totalSkipped } = await saveTransactionsToSupabase(userId, accounts, provider);

    console.log(`[${new Date().toISOString()}] Done! Saved: ${totalSaved}, Skipped: ${totalSkipped}`);

    res.json({
      success: true,
      message: 'סנכרון הושלם בהצלחה',
      transactionsAdded: totalSaved,
      totalSkipped,
      accountsCount: accounts.length
    });
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error scraping ${provider}:`, error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'שגיאה בסנכרון'
    });
  }
});

// Admin sync-all (protected by admin key)
app.post('/sync-all', async (req, res) => {
  const { adminKey } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { data: connections } = await supabase
      .from('bank_connections')
      .select('*')
      .eq('auto_sync', true);

    const results = [];
    for (const conn of (connections || [])) {
      try {
        const credentials = JSON.parse(
          Buffer.from(conn.encrypted_credentials, 'base64').toString()
        );
        const providerType = PROVIDER_MAP[conn.provider];
        if (!providerType) continue;

        const accounts = await scrapeProvider(providerType, credentials);
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

// Nightly auto-sync at 02:00 Jerusalem time
cron.schedule('0 2 * * *', async () => {
  console.log('[CRON] Starting nightly auto-sync...');
  try {
    const { data: connections } = await supabase
      .from('bank_connections')
      .select('*')
      .eq('auto_sync', true);

    for (const conn of (connections || [])) {
      try {
        const credentials = JSON.parse(
          Buffer.from(conn.encrypted_credentials, 'base64').toString()
        );
        const providerType = PROVIDER_MAP[conn.provider];
        if (!providerType) continue;

        const accounts = await scrapeProvider(providerType, credentials);
        await saveTransactionsToSupabase(conn.user_id, accounts, conn.provider);
        console.log(`[CRON] Synced ${conn.provider} for user ${conn.user_id}`);
      } catch (err) {
        console.error(`[CRON] Error for ${conn.provider}:`, err.message);
      }
    }
    console.log('[CRON] Nightly sync complete');
  } catch (error) {
    console.error('[CRON] Fatal error:', error);
  }
}, { timezone: 'Asia/Jerusalem' });

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`FinFamily Bank Scraper running on port ${PORT}`);
  console.log(`Auto-sync scheduled: every night at 02:00 Jerusalem time`);
});
