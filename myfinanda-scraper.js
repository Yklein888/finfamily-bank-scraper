/**
 * MyFinanda Scraper
 * Connects to MyFinanda (premium.finanda.co.il) and extracts all financial data
 * Saves to Supabase database
 */

import puppeteer from 'puppeteer-core';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Chromium path is passed from server.js which loads @sparticuz/chromium

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

// MyFinanda credentials from env
const MYFINANDA_EMAIL = process.env.MYFINANDA_EMAIL;
const MYFINANDA_PASSWORD = process.env.MYFINANDA_PASSWORD;

async function loginToMyFinanda(page) {
  console.log('[MyFinanda] Navigating to login page...');
  await page.goto('https://premium.finanda.co.il/login', { waitUntil: 'networkidle2' });

  // Fill email
  await page.type('input[type="email"]', MYFINANDA_EMAIL);

  // Fill password
  await page.type('input[type="password"]', MYFINANDA_PASSWORD);

  // Click login button (find by text since :contains() is not valid CSS)
  await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, input[type="submit"]')];
    const loginBtn = buttons.find(b => b.textContent.includes('כניסה') || b.textContent.includes('Login'));
    if (loginBtn) loginBtn.click();
    else if (buttons.length > 0) buttons[buttons.length - 1].click();
  });

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

  // Wait extra time for React/Angular to render data
  await new Promise(r => setTimeout(r, 3000));

  console.log('[MyFinanda] Current URL:', page.url());

  // Debug: log DOM structure to understand what selectors to use
  const domDebug = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    const allRows = document.querySelectorAll('table tbody tr');
    const roleRows = document.querySelectorAll('[role="row"]');
    const gridcells = document.querySelectorAll('[role="gridcell"]');
    const agGrid = document.querySelector('.ag-root, .ag-root-wrapper, ag-grid-angular');
    const agRows = document.querySelectorAll('.ag-row, .ag-row-even, .ag-row-odd');
    const agCells = document.querySelectorAll('.ag-cell');

    // Sample first few cells text
    const sampleCells = [...agCells].slice(0, 20).map(c => c.textContent?.trim()).filter(Boolean);
    const sampleRows = [...agRows].slice(0, 3).map(r => r.className);

    return {
      tablesCount: tables.length,
      tableRowsCount: allRows.length,
      roleRowsCount: roleRows.length,
      gridcellsCount: gridcells.length,
      hasAgGrid: !!agGrid,
      agRowsCount: agRows.length,
      agCellsCount: agCells.length,
      sampleAgCells: sampleCells,
      sampleAgRowClasses: sampleRows,
      bodyClasses: document.body.className.substring(0, 100),
      pageTitle: document.title,
    };
  });

  console.log('[MyFinanda] DOM Debug:', JSON.stringify(domDebug));

  // Extract data from page using evaluate
  const accountsData = await page.evaluate(() => {
    // Try ag-Grid first (common in Israeli fintech apps)
    const agRows = document.querySelectorAll('.ag-row');
    if (agRows.length > 0) {
      const transactions = [];
      agRows.forEach(row => {
        const cells = row.querySelectorAll('.ag-cell');
        if (cells.length >= 4) {
          const texts = [...cells].map(c => c.textContent?.trim() || '');
          const amount = parseFloat(texts[texts.length - 1]?.replace(/[^\d.-]/g, '') || '0');
          if (amount !== 0) {
            transactions.push({
              date: texts[0] || '',
              account: texts[1] || '',
              description: texts[2] || '',
              category: texts[3] || '',
              amount,
            });
          }
        }
      });
      return { totalBalance: 0, transactionCount: transactions.length, transactions, source: 'ag-grid' };
    }

    // Try standard table
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

    return { totalBalance: 0, transactionCount: transactions.length, transactions, source: 'table' };
  });

  console.log('[MyFinanda] Accounts source:', accountsData.source, '| Found:', accountsData.transactionCount, 'transactions');
  return accountsData;
}

async function extractCreditCardsData(page) {
  console.log('[MyFinanda] Extracting credit cards data...');

  try {
    await page.goto('https://premium.finanda.co.il/checking-cards-cash/credit-cards', {
      waitUntil: 'networkidle2',
      timeout: 20000
    });

    await new Promise(r => setTimeout(r, 3000));

    const domDebug = await page.evaluate(() => {
      const agRows = document.querySelectorAll('.ag-row');
      const agCells = document.querySelectorAll('.ag-cell');
      const sampleCells = [...agCells].slice(0, 15).map(c => c.textContent?.trim()).filter(Boolean);
      return {
        agRowsCount: agRows.length,
        agCellsCount: agCells.length,
        sampleCells,
        pageTitle: document.title,
      };
    });
    console.log('[MyFinanda] Credit cards DOM:', JSON.stringify(domDebug));

    const cardsData = await page.evaluate(() => {
      // Try ag-Grid first
      const agRows = document.querySelectorAll('.ag-row');
      if (agRows.length > 0) {
        const cards = [];
        agRows.forEach(row => {
          const cells = row.querySelectorAll('.ag-cell');
          if (cells.length >= 3) {
            const texts = [...cells].map(c => c.textContent?.trim() || '');
            const amount = parseFloat(texts[texts.length - 1]?.replace(/[^\d.-]/g, '') || '0');
            if (amount !== 0) {
              cards.push({
                date: texts[0] || '',
                cardName: texts[1] || '',
                description: texts[2] || '',
                amount,
              });
            }
          }
        });
        return cards;
      }

      // Fallback: standard table
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

    console.log('[MyFinanda] Credit cards found:', cardsData.length);
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

      const { error: txnError, data: savedTxns } = await getSupabase()
        .from('transactions')
        .insert(transactionsToSave)
        .select();

      if (txnError) {
        console.error('[MyFinanda] Error saving transactions:', txnError.message);
      } else {
        console.log('[MyFinanda] Saved ' + (savedTxns?.length || 0) + ' transactions');
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

      const { error: ccError, data: savedCC } = await getSupabase()
        .from('transactions')
        .insert(creditTxnsToSave)
        .select();

      if (ccError) {
        console.error('[MyFinanda] Error saving credit card transactions:', ccError.message);
      } else {
        console.log('[MyFinanda] Saved ' + (savedCC?.length || 0) + ' credit card transactions');
      }
    }

    // Mark MyFinanda as connected
    await getSupabase().from('open_banking_connections').upsert({
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

async function scrapeMyFinanda(userId, chromePath) {
  const execPath = chromePath || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

  const defaultArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-gpu',
    '--single-process',
    '--no-zygote'
  ];

  let browser;
  try {
    console.log('[MyFinanda] Starting browser with execPath: ' + (execPath || 'auto-detect'));
    browser = await puppeteer.launch({
      args: [...defaultArgs, '--disable-dev-shm-usage'],
      executablePath: execPath || undefined,
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
