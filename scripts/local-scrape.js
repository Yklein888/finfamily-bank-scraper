#!/usr/bin/env node
/**
 * Local Pagi Bank Scraper
 * Run via Windows Task Scheduler or manually
 * Syncs to Supabase without needing a server
 */

import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';
import { scrapePagi } from '../scrapers/pagi-custom.js';

dotenv.config();

async function main() {
  const startTime = Date.now();
  console.log(`[${new Date().toISOString()}] Starting Pagi scrape...`);

  try {
    // Validate env vars
    const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAGI_USERNAME, PAGI_PASSWORD } = process.env;
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !PAGI_USERNAME || !PAGI_PASSWORD) {
      throw new Error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PAGI_USERNAME, PAGI_PASSWORD');
    }

    // Initialize Supabase
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Scrape Pagi
    const credentials = { username: PAGI_USERNAME, password: PAGI_PASSWORD };
    const accounts = await scrapePagi(credentials, undefined, ['--no-sandbox']);

    console.log(`[Scraper] ✅ Found ${accounts.length} accounts`);

    // Save to Supabase - reuse the saveTransactionsToSupabase logic from server.js
    console.log('[Supabase] Saving accounts and transactions...');
    let totalSaved = 0;
    let totalSkipped = 0;

    for (const account of accounts) {
      const accountNumber = account.accountNumber || 'pagi';

      // Check if account exists
      const { data: existingAccount } = await supabase
        .from('accounts')
        .select('id')
        .eq('account_number', accountNumber)
        .single()
        .catch(() => ({ data: null }));

      let accountId;
      if (existingAccount) {
        accountId = existingAccount.id;
        await supabase
          .from('accounts')
          .update({
            balance: account.balance || 0,
            last_sync: new Date().toISOString(),
            is_synced: true,
          })
          .eq('id', accountId);
      } else {
        const { data: newAccount } = await supabase
          .from('accounts')
          .insert({
            name: 'Pagi - ' + accountNumber,
            bank_name: 'Pagi',
            account_number: accountNumber,
            balance: account.balance || 0,
            currency: 'ILS',
            account_type: 'checking',
            last_sync: new Date().toISOString(),
            is_synced: true,
          })
          .select('id')
          .single();
        accountId = newAccount?.id;
      }

      if (!accountId) {
        console.log(`[⚠️  WARNING] Could not save account ${accountNumber}`);
        continue;
      }

      // Save transactions
      for (const txn of (account.txns || [])) {
        const txnDate = new Date(txn.date).toISOString().split('T')[0];
        const amount = Math.abs(txn.chargedAmount || txn.originalAmount || 0);
        const type = (txn.chargedAmount || txn.originalAmount || 0) < 0 ? 'expense' : 'income';

        // Check if transaction already exists
        const { data: existing } = await supabase
          .from('transactions')
          .select('id')
          .eq('account_id', accountId)
          .eq('amount', amount)
          .eq('transaction_date', txnDate)
          .eq('description', txn.description || '')
          .single()
          .catch(() => ({ data: null }));

        if (existing) {
          totalSkipped++;
          continue;
        }

        const { error } = await supabase
          .from('transactions')
          .insert({
            account_id: accountId,
            amount,
            type,
            description: txn.description || 'transaction',
            transaction_date: txnDate,
            notes: txn.memo || null,
          });

        if (error) {
          console.error(`[⚠️  ERROR] Failed to save transaction:`, error.message);
        } else {
          totalSaved++;
        }
      }

      console.log(`[✅] Account ${accountNumber}: ${account.txns?.length || 0} transactions processed`);
    }

    console.log(`[📊] Results: ${totalSaved} saved, ${totalSkipped} skipped`);

    const duration = Date.now() - startTime;
    console.log(`[✅ SUCCESS] Scrape completed in ${duration}ms`);
    process.exit(0);
  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`[❌ ERROR] Scrape failed after ${duration}ms:`, error.message);
    process.exit(1);
  }
}

main();
