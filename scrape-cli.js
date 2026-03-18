/**
 * Standalone Bank Scraper CLI for GitHub Actions
 * Runs without a server, directly scrapes and saves to Supabase
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { CompanyTypes } from 'israeli-bank-scrapers';
import { scrapePagi } from './scrapers/pagi-custom.js';
import puppeteer from 'puppeteer-core';

dotenv.config();

// Supabase initialization
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
  'visaCal': CompanyTypes.visaCal,
  'fibi': CompanyTypes.pagi,
};

// Chrome binary detection
let chromium = null;
(async () => {
  try {
    chromium = (await import('@sparticuz/chromium')).default;
  } catch (e) {
    console.log('[Init] @sparticuz/chromium not available, will use system Chrome');
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

  const stealthArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-breakpad',
    '--disable-extensions',
    '--disable-hang-monitor',
    '--disable-notifications',
    '--disable-popup-blocking',
    '--no-first-run',
    '--no-default-browser-check',
    '--metrics-recording-only',
    '--disable-plugins',
    '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  ];

  const userDataDir = `/tmp/puppeteer-${providerType}-${Date.now() % 1000}`;
  const userDataArgs = [`--user-data-dir=${userDataDir}`];

  try {
    console.log('[Scraper] Starting with settings: headless=true, showBrowser=false, timeout=180s');

    // Use custom Pagi scraper
    if (providerType === CompanyTypes.pagi) {
      console.log('[Scraper] Using custom Pagi scraper');
      const args = [
        ...defaultArgs,
        '--disable-dev-shm-usage',
        ...stealthArgs,
        ...userDataArgs,
      ];
      const accounts = await scrapePagi(credentials, execPath, args);
      console.log('[Scraper] Custom Pagi scraper succeeded! Found ' + accounts.length + ' accounts');
      return accounts;
    }

    throw new Error('CLI mode only supports Pagi scraping');
  } catch (error) {
    if (attempt < maxAttempts) {
      const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
      console.log(`[Retry] Attempt ${attempt}/${maxAttempts} failed. Retrying in ${delayMs}ms`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return scrapeProvider(providerType, credentials, attempt + 1);
    }
    throw error;
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
        balance: account.balance?.amount || account.balance || 0,
        last_sync: new Date().toISOString(),
        is_synced: true,
      }).eq('id', accountId);
    } else {
      const { data: newAccount, error: insertErr } = await getSupabase().from('accounts').insert({
        user_id: userId,
        name: providerName + ' - ' + accountNumber,
        bank_name: providerName,
        account_number: accountNumber,
        balance: account.balance?.amount || account.balance || 0,
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
      const amount = Math.abs(txn.chargedAmount || txn.originalAmount || txn.amount || 0);
      const type = (txn.chargedAmount || txn.originalAmount || txn.amount || 0) < 0 ? 'expense' : 'income';

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

async function logSyncAttempt(userId, provider, status, errorMessage = null, transactionsAdded = 0) {
  try {
    const { data: connection } = await getSupabase()
      .from('open_banking_connections')
      .select('id')
      .eq('user_id', userId)
      .eq('provider_code', provider)
      .single();

    await getSupabase().from('sync_history').insert({
      user_id: userId,
      connection_id: connection?.id || null,
      sync_type: 'automatic',
      sync_status: status === 'success' ? 'success' : 'failed',
      transactions_added: transactionsAdded || 0,
      error_message: errorMessage,
      sync_start: new Date().toISOString(),
      sync_end: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Log] Failed to record sync history:', err.message);
  }
}

/**
 * Main scraper function for GitHub Actions
 * Scrapes all auto-sync banks for all users
 */
async function runAutoSync() {
  console.log(`[GitHub Actions] Starting automated bank sync at ${new Date().toISOString()}`);
  const startTime = Date.now();
  let totalSucceeded = 0;
  let totalFailed = 0;

  try {
    // Get all users with active bank connections
    const { data: connections, error: fetchError } = await getSupabase()
      .from('open_banking_connections')
      .select('user_id, provider_code, provider_name')
      .eq('connection_status', 'active');

    if (fetchError) {
      throw new Error('Failed to fetch connections: ' + fetchError.message);
    }

    if (!connections || connections.length === 0) {
      console.log('[GitHub Actions] No active connections to sync');
      return { success: true, totalSynced: 0, totalFailed: 0 };
    }

    console.log(`[GitHub Actions] Found ${connections.length} active connection(s) to sync`);

    // Group connections by user and provider
    const connectionMap = new Map();
    for (const conn of connections) {
      const key = `${conn.user_id}:${conn.provider_code}`;
      if (!connectionMap.has(key)) {
        connectionMap.set(key, conn);
      }
    }

    // Process each unique user-provider combination
    for (const [, connection] of connectionMap) {
      const connStartTime = Date.now();
      const userId = connection.user_id;
      const provider = connection.provider_code;

      try {
        console.log(`[Sync] Starting ${provider} sync for user ${userId.substring(0, 8)}...`);

        let credentials;
        let companyType;

        // Get credentials based on provider
        if (provider === 'pagi') {
          const username = process.env.PAGI_USERNAME;
          const password = process.env.PAGI_PASSWORD;
          if (!username || !password) {
            throw new Error('Missing PAGI_USERNAME or PAGI_PASSWORD environment variables');
          }
          credentials = { username, password };
          companyType = CompanyTypes.pagi;
        } else if (provider === 'cal') {
          const username = process.env.CAL_USERNAME;
          const password = process.env.CAL_PASSWORD;
          if (!username || !password) {
            throw new Error('Missing CAL_USERNAME or CAL_PASSWORD environment variables');
          }
          credentials = { username, password };
          companyType = CompanyTypes.visaCal;
        } else if (provider === 'hapoalim') {
          const username = process.env.HAPOALIM_USERNAME;
          const password = process.env.HAPOALIM_PASSWORD;
          if (!username || !password) {
            throw new Error('Missing HAPOALIM_USERNAME or HAPOALIM_PASSWORD environment variables');
          }
          credentials = { username, password };
          companyType = CompanyTypes.hapoalim;
        } else {
          throw new Error(`Unknown provider: ${provider}`);
        }

        const accounts = await scrapeProvider(companyType, credentials);
        const stats = await saveTransactionsToSupabase(userId, accounts, provider);

        // Update connection status
        await getSupabase().from('open_banking_connections').update({
          connection_status: 'active',
          last_sync: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }).eq('user_id', userId).eq('provider_code', provider);

        const duration = Date.now() - connStartTime;
        await logSyncAttempt(userId, provider, 'success', null, stats.totalSaved);
        console.log(`[Sync] ✓ ${provider} synced (${stats.totalSaved} transactions, ${duration}ms)`);
        totalSucceeded++;
      } catch (err) {
        const duration = Date.now() - connStartTime;
        console.error(`[Sync] ✗ ${provider} failed (${duration}ms):`, err.message);
        await logSyncAttempt(userId, provider, 'failed', err.message, 0);
        totalFailed++;
      }
    }

    const totalDuration = Date.now() - startTime;
    console.log(`[GitHub Actions] Complete! Succeeded: ${totalSucceeded}, Failed: ${totalFailed}, Total: ${totalDuration}ms`);
    return { success: true, totalSynced: totalSucceeded, totalFailed };
  } catch (error) {
    const totalDuration = Date.now() - startTime;
    console.error(`[GitHub Actions] Fatal error after ${totalDuration}ms:`, error.message);
    process.exit(1);
  }
}

// Run the sync
runAutoSync().then(result => {
  console.log('[GitHub Actions] Final result:', result);
  process.exit(result.success && result.totalFailed === 0 ? 0 : 1);
}).catch(err => {
  console.error('[GitHub Actions] Uncaught error:', err);
  process.exit(1);
});
