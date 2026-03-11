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

  // Debug: check login page state before filling
  const loginPageDebug = await page.evaluate(() => ({
    hasEmailInput: !!document.querySelector('input[type="email"]'),
    hasPasswordInput: !!document.querySelector('input[type="password"]'),
    buttonTexts: [...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(Boolean),
    url: window.location.href,
  }));
  console.log('[MyFinanda] Login page state:', JSON.stringify(loginPageDebug));

  // Wait for email input to appear
  await page.waitForSelector('input[type="email"]', { timeout: 10000 });

  // Fill email and password
  await page.type('input[type="email"]', MYFINANDA_EMAIL);
  await page.type('input[type="password"]', MYFINANDA_PASSWORD);

  console.log('[MyFinanda] Credentials filled, clicking login...');

  // Click login button - try multiple strategies
  const clickResult = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, input[type="submit"]')];
    const loginBtn = buttons.find(b =>
      b.textContent.includes('כניסה') ||
      b.textContent.includes('Login') ||
      b.type === 'submit'
    );
    if (loginBtn) {
      loginBtn.click();
      return 'clicked: ' + (loginBtn.textContent?.trim() || loginBtn.type);
    }
    if (buttons.length > 0) {
      buttons[buttons.length - 1].click();
      return 'clicked last button: ' + buttons[buttons.length - 1].textContent?.trim();
    }
    return 'no button found';
  });
  console.log('[MyFinanda] Click result:', clickResult);

  // Wait for URL to move away from the exact /login page.
  // Uses pathname.endsWith so that /login/enter-otp resolves correctly
  // (includes('/login') would NOT work - /login/enter-otp still contains /login)
  try {
    await page.waitForFunction(
      () => !window.location.pathname.endsWith('/login'),
      { timeout: 30000 }
    );
  } catch (e) {
    const timeoutDebug = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      bodyText: document.body.innerText?.substring(0, 300),
      errorElements: [...document.querySelectorAll('.error, .alert, [class*="error"], [class*="Error"]')]
        .map(el => el.textContent?.trim()).filter(Boolean),
    }));
    console.error('[MyFinanda] Login timeout. Page state:', JSON.stringify(timeoutDebug));
    throw e;
  }

  const postLoginUrl = page.url();
  console.log('[MyFinanda] Login URL changed to:', postLoginUrl);

  // Wait for auth state to fully initialize in the SPA (localStorage, sessionStorage, in-memory state)
  await new Promise(r => setTimeout(r, 6000));

  // Debug: check localStorage for auth tokens after login
  const authDebug = await page.evaluate(() => {
    const items = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      items[key] = (localStorage.getItem(key) || '').substring(0, 80);
    }
    return {
      localStorageCount: localStorage.length,
      items,
      currentUrl: window.location.href,
    };
  });
  console.log('[MyFinanda] Auth state after login:', JSON.stringify(authDebug));

  console.log('[MyFinanda] Login complete, current URL:', page.url());
}

async function navigateToPage(page, targetPath, description) {
  const targetUrl = 'https://premium.finanda.co.il' + targetPath;
  console.log('[MyFinanda] Navigating to', description, '...');

  // Strategy 1: Try clicking a nav link (SPA navigation - preserves in-memory auth)
  const clickResult = await page.evaluate((path) => {
    const allLinks = [...document.querySelectorAll('a[href]')];
    const link = allLinks.find(a => {
      const href = a.getAttribute('href') || '';
      return href.includes(path.split('/').filter(Boolean).pop()) || a.href.includes(path);
    });
    if (link) {
      link.click();
      return 'link-click: ' + link.href;
    }
    return null;
  }, targetPath);

  if (clickResult) {
    console.log('[MyFinanda] SPA link click:', clickResult);
    await new Promise(r => setTimeout(r, 5000));
    if (!page.url().includes('/login')) return true;
    console.log('[MyFinanda] Link click led to login, falling back to pushState...');
  }

  // Strategy 2: pushState + popstate (React Router client-side nav)
  const pushResult = await page.evaluate((path) => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    return 'pushState: ' + path;
  }, targetPath);
  console.log('[MyFinanda] pushState nav:', pushResult);
  await new Promise(r => setTimeout(r, 5000));

  if (!page.url().includes('/login')) return true;
  console.log('[MyFinanda] pushState led to login, falling back to goto...');

  // Strategy 3: Full page navigation (last resort - may lose memory-only auth)
  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log('[MyFinanda] goto timeout/error (continuing):', e.message?.substring(0, 80));
  }

  if (page.url().includes('/login')) {
    const debug = await page.evaluate(() => ({ url: window.location.href }));
    console.error('[MyFinanda] All navigation strategies failed - session lost. URL:', debug.url);
    throw new Error('Session lost - auth is memory-only and not persisted. Need cookie-based auth.');
  }
  return true;
}

async function extractAccountsData(page) {
  console.log('[MyFinanda] Extracting accounts data...');

  await navigateToPage(page, '/checking-cards-cash/unified_checking', 'unified_checking');

  // Wait for SPA content to fully render
  await new Promise(r => setTimeout(r, 5000));

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
    await navigateToPage(page, '/checking-cards-cash/credit-cards', 'credit-cards');

    if (page.url().includes('/login')) {
      console.warn('[MyFinanda] Credit cards: redirected to login, skipping');
      return [];
    }

    await new Promise(r => setTimeout(r, 4000));

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

function createBrowser(chromePath) {
  const execPath = chromePath || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  const defaultArgs = [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu',
    '--single-process', '--no-zygote', '--disable-dev-shm-usage',
  ];
  console.log('[MyFinanda] Starting browser with execPath: ' + (execPath || 'auto-detect'));
  return puppeteer.launch({
    args: defaultArgs,
    executablePath: execPath || undefined,
    headless: true,
  });
}

// Phase 1: Start login, detect if OTP is needed
// Returns { browser, page, needsOtp, sessionReady }
async function startMyFinandaSession(chromePath) {
  const browser = await createBrowser(chromePath);
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  await page.setViewport({ width: 1280, height: 800 });

  // Navigate and fill credentials
  await loginToMyFinanda(page);

  // After loginToMyFinanda returns, check current state
  const state = await page.evaluate(() => {
    const inputs = [...document.querySelectorAll('input')];
    const otpInput = inputs.find(i =>
      i.type === 'tel' || i.type === 'number' ||
      (i.name || '').toLowerCase().match(/otp|code|token/) ||
      (i.placeholder || '').match(/קוד|code/i) ||
      (i.id || '').toLowerCase().match(/otp|code|token/)
    );
    const bodyText = document.body.innerText?.substring(0, 600) || '';
    return {
      url: window.location.href,
      hasOtpInput: !!otpInput,
      otpInputInfo: otpInput ? { type: otpInput.type, name: otpInput.name, id: otpInput.id, placeholder: otpInput.placeholder } : null,
      bodyText,
    };
  });

  console.log('[MyFinanda] Post-login state:', JSON.stringify({ url: state.url, hasOtpInput: state.hasOtpInput, otpInput: state.otpInputInfo }));

  // OTP screen: URL is /login/enter-otp or contains enter-otp
  if (state.url.includes('enter-otp') || state.url.includes('/login/')) {
    console.log('[MyFinanda] OTP screen detected via URL:', state.url);
    return { browser, page, needsOtp: true };
  }

  // Fully logged in (URL moved completely away from /login)
  if (!state.url.includes('/login')) {
    console.log('[MyFinanda] Logged in without OTP');
    return { browser, page, needsOtp: false };
  }

  // Fallback: check DOM for OTP elements
  const needsOtp = state.hasOtpInput ||
    state.bodyText.includes('קוד') ||
    state.bodyText.includes('אימות') ||
    state.bodyText.includes('SMS');

  console.log('[MyFinanda] OTP needed (DOM check):', needsOtp, '| bodyText:', state.bodyText.substring(0, 150));
  return { browser, page, needsOtp };
}

// Phase 2: Enter OTP, wait for login to complete, then extract + save
async function completeOtpAndScrape(browser, page, otp, userId) {
  console.log('[MyFinanda] Entering OTP...');

  // Set up API response interception BEFORE submitting OTP
  // MyFinanda SPA loads financial data on initial authenticated render
  const capturedApiData = { transactions: [], rawUrls: [] };
  const responseHandler = async (response) => {
    const url = response.url();
    if (!url.includes('finanda') && !url.includes('myfinanda')) return;
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const body = await response.json().catch(() => null);
      if (!body) return;
      capturedApiData.rawUrls.push(url.replace(/^https?:\/\/[^/]+/, '').substring(0, 80));
      const items = Array.isArray(body) ? body : (body.items || body.data || body.transactions || []);
      if (Array.isArray(items) && items.length > 0) {
        capturedApiData.transactions.push(...items);
      }
    } catch { /* ignore */ }
  };
  page.on('response', responseHandler);

  // Fill OTP into the input
  const fillResult = await page.evaluate((otpCode) => {
    const inputs = [...document.querySelectorAll('input')];
    const otpInput = inputs.find(i =>
      i.type === 'tel' || i.type === 'number' ||
      (i.name || '').toLowerCase().match(/otp|code|token/) ||
      (i.placeholder || '').match(/קוד|code/i) ||
      (i.id || '').toLowerCase().match(/otp|code|token/)
    );
    const fallback = inputs.find(i =>
      !['email', 'password', 'hidden'].includes(i.type) && i.offsetParent !== null
    );
    const target = otpInput || fallback;
    if (!target) return 'no input found';
    target.focus();
    target.value = otpCode;
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    return 'filled: ' + JSON.stringify({ type: target.type, name: target.name, id: target.id });
  }, otp);
  console.log('[MyFinanda] OTP fill result:', fillResult);

  // Click the verify/submit button - MyFinanda uses "המשך" (Continue)
  const submitResult = await page.evaluate(() => {
    const buttons = [...document.querySelectorAll('button, input[type="submit"]')];
    const btn = buttons.find(b =>
      b.textContent?.match(/המשך|אישור|אמת|כניסה|שלח|Verify|Submit|Continue/) ||
      b.type === 'submit'
    ) || buttons[buttons.length - 1];
    if (btn) { btn.click(); return 'clicked: ' + (btn.textContent?.trim() || btn.type); }
    return 'no button';
  });
  console.log('[MyFinanda] OTP submit result:', submitResult);

  // Wait for URL to move completely away from /login/* paths
  await page.waitForFunction(
    () => !window.location.pathname.startsWith('/login'),
    { timeout: 30000 }
  );
  console.log('[MyFinanda] OTP login complete, URL:', page.url());

  // Wait for profile-is-loading to redirect itself (the SPA sets up auth here)
  if (page.url().includes('profile-is-loading')) {
    console.log('[MyFinanda] Waiting for profile-is-loading to complete...');
    try {
      await page.waitForFunction(
        () => !window.location.href.includes('profile-is-loading'),
        { timeout: 45000 }
      );
      console.log('[MyFinanda] Profile loaded, URL:', page.url());
    } catch {
      console.log('[MyFinanda] Profile-is-loading still active after 45s, proceeding. URL:', page.url());
    }
  }

  // Debug: check all storage + cookies NOW (before any navigation)
  const authState = await page.evaluate(() => {
    const ss = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = (sessionStorage.getItem(k) || '').substring(0, 80); }
    const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = (localStorage.getItem(k) || '').substring(0, 80); }
    return { ssCount: sessionStorage.length, ss, lsCount: localStorage.length, ls, url: window.location.href };
  });
  const cookies = await page.cookies();
  console.log('[MyFinanda] Pre-navigation auth:', JSON.stringify({
    url: authState.url,
    sessionStorageCount: authState.ssCount,
    sessionStorage: authState.ss,
    localStorageCount: authState.lsCount,
    localStorage: authState.ls,
    cookieCount: cookies.length,
    cookies: cookies.map(c => ({ name: c.name, httpOnly: c.httpOnly, expires: c.expires > 0 ? new Date(c.expires * 1000).toISOString() : 'session' })),
  }));

  // Extra settle time for SPA auth state
  await new Promise(r => setTimeout(r, 3000));

  // Extract and save data (uses SPA navigation to avoid losing session)
  const accountsData = await extractAccountsData(page);
  const creditCardsData = await extractCreditCardsData(page);
  await saveDataToSupabase(userId, accountsData, creditCardsData);

  page.off('response', responseHandler);
  console.log('[MyFinanda] API URLs captured during session:', capturedApiData.rawUrls);

  const totalExtracted = (accountsData.transactions?.length || 0) + (creditCardsData?.length || 0);
  console.log('[MyFinanda] Scraping complete after OTP. Transactions:', totalExtracted);

  return {
    success: true,
    accountsExtracted: 1,
    transactionsExtracted: totalExtracted,
  };
}

async function scrapeMyFinanda(userId, chromePath) {
  let browser;
  try {
    const session = await startMyFinandaSession(chromePath);
    browser = session.browser;

    if (session.needsOtp) {
      throw new Error('OTP_REQUIRED');
    }

    // No OTP needed - extract directly
    const accountsData = await extractAccountsData(session.page);
    const creditCardsData = await extractCreditCardsData(session.page);
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
    if (browser) await browser.close();
  }
}

async function extractAndSaveData(page, userId) {
  const accountsData = await extractAccountsData(page);
  const creditCardsData = await extractCreditCardsData(page);
  await saveDataToSupabase(userId, accountsData, creditCardsData);
  return {
    transactionsExtracted: (accountsData.transactions?.length || 0) + (creditCardsData?.length || 0),
  };
}

export { scrapeMyFinanda, startMyFinandaSession, completeOtpAndScrape, extractAndSaveData };
