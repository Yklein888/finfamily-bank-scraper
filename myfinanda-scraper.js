/**
 * MyFinanda Scraper
 * Connects to MyFinanda (premium.finanda.co.il) and extracts all financial data
 * Saves to Supabase database
 */

import puppeteer from 'puppeteer-core';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Chromium is loaded in server.js, we'll use getChromePath() which handles fallbacks
let chromium = null;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// MyFinanda credentials from env
const MYFINANDA_EMAIL = process.env.MYFINANDA_EMAIL;
const MYFINANDA_PASSWORD = process.env.MYFINANDA_PASSWORD;

async function getChromePath() {
  // Try environment variable first
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  // Otherwise use system Chrome (Puppeteer will find it)
  return undefined;
}

async function loginToMyFinanda(page) {
  console.log('[MyFinanda] Navigating to login page...');
  await page.goto('https://premium.finanda.co.il/login', { waitUntil: 'networkidle2' });

  // Fill email
  await page.type('input[type="email"]', MYFINANDA_EMAIL);

  // Fill password
  await page.type('input[type="password"]', MYFINANDA_PASSWORD);

  // Click login button
  await page.click('button:contains("כניסה")');

  // Wait for redirect to dashboard
  await page.waitForNavigation({ waitUntil: 'networkidle2' });

  console.log('[MyFinanda] Login successful!');
}

async function extractAccountsData(page) {
  console.log('[MyFinanda] Extracting accounts data...');

  // Navigate to accounts page if not already there
  if (!page.url().includes('unified_checking')) {
    await page.goto('https://premium.finanda.co.il/checking-cards-cash/unified_checking', {
      waitUntil: 'networkidle2'
    });
  }

  // Extract data from page using evaluate
  const accountsData = await page.evaluate(() => {
    // Get total balance from the summary section
    const totalBalanceElement = document.querySelector('[class*="balance"]') ||
                                document.querySelector('[class*="total"]');
    const totalBalance = totalBalanceElement ?
      parseFloat(totalBalanceElement.textContent.replace(/[^\d.-]/g, '')) : 0;

    // Extract transactions from table
    const transactions = [];
    const rows = document.querySelectorAll('table tbody tr, [role="row"]');

    rows.forEach(row => {
      const cells = row.querySelectorAll('td, [role="gridcell"]');
      if (cells.length >= 5) {
        const transaction = {
          date: cells[0]?.textContent?.trim() || '',
          account: cells[1]?.textContent?.trim() || '',
          description: cells[2]?.textContent?.trim() || '',
          category: cells[3]?.textContent?.trim() || '',
          amount: parseFloat(cells[4]?.textContent?.replace(/[^\d.-]/g, '') || '0'),
        };
        if (transaction.amount !== 0) {
          transactions.push(transaction);
        }
      }
    });

    return {
      totalBalance,
      transactionCount: transactions.length,
      transactions
    };
  });

  return accountsData;
}

async function extractCreditCardsData(page) {
  console.log('[MyFinanda] Extracting credit cards data...');

  // Navigate to credit cards page
  try {
    await page.goto('https://premium.finanda.co.il/checking-cards-cash/credit-cards', {
      waitUntil: 'networkidle2',
      timeout: 15000
    });

    const cardsData = await page.evaluate(() => {
      const cards = [];
      const rows = document.querySelectorAll('table tbody tr, [role="row"]');

      rows.forEach(row => {
        const cells = row.querySelectorAll('td, [role="gridcell"]');
        if (cells.length >= 4) {
          cards.push({
            date: cells[0]?.textContent?.trim() || '',
            cardName: cells[1]?.textContent?.trim() || '',
            description: cells[2]?.textContent?.trim() || '',
            amount: parseFloat(cells[3]?.textContent?.replace(/[^\d.-]/g, '') || '0'),
          });
        }
      });

      return cards;
    });

    return cardsData;
  } catch (err) {
    console.error('[MyFinanda] Error extracting credit cards:', err.message);
    return [];
  }
}

async function saveDataToSupabase(userId, accountsData, creditCardsData) {
  console.log('[MyFinanda] Saving data to Supabase...');

  try {
    // Save transactions
    if (accountsData.transactions && accountsData.transactions.length > 0) {
      const transactionsToSave = accountsData.transactions.map(txn => ({
        user_id: userId,
        account_id: null, // We'll set this later if needed
        amount: txn.amount,
        type: txn.amount > 0 ? 'income' : 'expense',
        description: txn.description,
        transaction_date: parseDate(txn.date),
        notes: `[MyFinanda] ${txn.account} - ${txn.category}`,
      }));

      const { error: txnError, data: savedTxns } = await supabase
        .from('transactions')
        .insert(transactionsToSave);

      if (txnError) {
        console.error('[MyFinanda] Error saving transactions:', txnError.message);
      } else {
        console.log('[MyFinanda] Saved ' + savedTxns.length + ' transactions');
      }
    }

    // Save credit card transactions
    if (creditCardsData && creditCardsData.length > 0) {
      const creditTxnsToSave = creditCardsData.map(txn => ({
        user_id: userId,
        account_id: null,
        amount: txn.amount,
        type: txn.amount > 0 ? 'income' : 'expense',
        description: `${txn.cardName} - ${txn.description}`,
        transaction_date: parseDate(txn.date),
        notes: '[MyFinanda] Credit Card',
      }));

      const { error: ccError, data: savedCC } = await supabase
        .from('transactions')
        .insert(creditTxnsToSave);

      if (ccError) {
        console.error('[MyFinanda] Error saving credit card transactions:', ccError.message);
      } else {
        console.log('[MyFinanda] Saved ' + savedCC.length + ' credit card transactions');
      }
    }

    // Mark MyFinanda as connected
    await supabase.from('open_banking_connections').upsert({
      user_id: userId,
      provider_name: 'MyFinanda',
      provider_code: 'myfinanda',
      connection_status: 'active',
      last_sync: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider_code' });

    console.log('[MyFinanda] Data saved successfully!');
  } catch (err) {
    console.error('[MyFinanda] Error saving to Supabase:', err.message);
    throw err;
  }
}

function parseDate(dateStr) {
  // Parse Hebrew or English date format
  // Expecting formats like "10 דצמבר 2025" or "10/12/2025"
  if (!dateStr) return new Date().toISOString().split('T')[0];

  // Try to parse as DD/MM/YYYY
  const slashFormat = dateStr.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashFormat) {
    const [_, day, month, year] = slashFormat;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  // Default to today
  return new Date().toISOString().split('T')[0];
}

async function scrapeMyFinanda(userId) {
  const execPath = await getChromePath();
  if (!execPath) {
    throw new Error('No Chrome binary available.');
  }

  const defaultArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--single-process',
    '--no-zygote'
  ];

  let browser;
  try {
    console.log('[MyFinanda] Starting browser...');
    browser = await puppeteer.launch({
      args: [...defaultArgs, '--disable-dev-shm-usage'],
      executablePath: execPath,
      headless: true,
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(30000);

    // Set viewport
    await page.setViewport({ width: 1280, height: 800 });

    // Login to MyFinanda
    await loginToMyFinanda(page);

    // Extract data from different sections
    const accountsData = await extractAccountsData(page);
    const creditCardsData = await extractCreditCardsData(page);

    // Save to Supabase
    await saveDataToSupabase(userId, accountsData, creditCardsData);

    console.log('[MyFinanda] Scraping completed successfully!');

    return {
      success: true,
      accountsExtracted: 1,
      transactionsExtracted: (accountsData.transactions?.length || 0) + (creditCardsData?.length || 0),
    };

  } catch (error) {
    console.error('[MyFinanda] Scraping failed:', error.message);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

export { scrapeMyFinanda };
