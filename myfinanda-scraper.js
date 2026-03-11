/**
 * MyFinanda Scraper v2 - Comprehensive
 *
 * Strategy:
 * 1. Login + OTP → full authenticated SPA session
 * 2. API Interception (PRIMARY): capture all XHR/Fetch JSON responses from the SPA
 * 3. Navigate to ALL financial sections to trigger data loading:
 *    - /checking-cards-cash/unified_checking  (current accounts)
 *    - /checking-cards-cash/credit-cards      (credit cards)
 *    - /savings-investments/savings           (savings)
 *    - /loans                                 (loans)
 * 4. Parse API JSON (100% accurate) → HTML table fallback with Hebrew header detection
 * 5. Cookie persistence: save after OTP, load for CRON (no OTP needed next time)
 * 6. Deduplication before saving
 */

import puppeteer from 'puppeteer-core';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

let supabase = null;
function getSupabase() {
  if (!supabase) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars');
    supabase = createClient(url, key);
  }
  return supabase;
}

const MYFINANDA_EMAIL = process.env.MYFINANDA_EMAIL;
const MYFINANDA_PASSWORD = process.env.MYFINANDA_PASSWORD;
const BASE_URL = 'https://premium.finanda.co.il';

// All financial pages to visit for full data capture
const FINANCIAL_PAGES = [
  { path: '/checking-cards-cash/unified_checking', label: 'Checking Accounts' },
  { path: '/checking-cards-cash/credit-cards',     label: 'Credit Cards' },
  { path: '/savings-investments/savings',           label: 'Savings' },
  { path: '/loans',                                label: 'Loans' },
];

// ─── API Interception ────────────────────────────────────────────────────────

function startApiInterception(page) {
  const state = {
    responses: [],       // { url, body, timestamp }
    urlsSeen: new Set(),
    handler: null,
  };

  state.handler = async (response) => {
    const url = response.url();
    // Only intercept finanda API calls
    if (!url.includes('finanda') && !url.includes('api')) return;
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const body = await response.json().catch(() => null);
      if (!body) return;

      const shortUrl = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
      const isNew = !state.urlsSeen.has(shortUrl);
      state.urlsSeen.add(shortUrl);

      state.responses.push({ url: shortUrl, body, timestamp: Date.now() });

      // Log each unique endpoint with structure preview
      if (isNew) {
        const preview = JSON.stringify(body).substring(0, 200);
        console.log('[MyFinanda] API captured:', shortUrl, '→', preview, '...');
      }
    } catch { /* ignore */ }
  };

  page.on('response', state.handler);
  return state;
}

function stopApiInterception(page, state) {
  if (state.handler) page.off('response', state.handler);
  console.log('[MyFinanda] API endpoints captured:', [...state.urlsSeen].join(', '));
  console.log('[MyFinanda] Total API responses:', state.responses.length);
  return state.responses;
}

// ─── Parse transactions from captured API responses ───────────────────────────

function parseTransactionsFromApiData(responses) {
  const transactions = [];

  for (const { url, body } of responses) {
    // Try to extract transaction arrays from various response shapes
    const candidates = [
      body,
      body?.data,
      body?.result,
      body?.transactions,
      body?.items,
      body?.rows,
      body?.records,
      body?.movements,
      body?.bankMovements,
      body?.accountMovements,
    ].filter(Boolean);

    for (const candidate of candidates) {
      const arr = Array.isArray(candidate) ? candidate : null;
      if (!arr || arr.length === 0) continue;

      // Check if looks like transaction data (has date + amount fields)
      const sample = arr[0];
      const hasDate = !!(sample?.date || sample?.transactionDate || sample?.valueDate ||
                         sample?.תאריך || sample?.operationDate || sample?.executionDate);
      const hasAmount = !!(sample?.amount || sample?.sum || sample?.credit || sample?.debit ||
                           sample?.סכום || sample?.chargedAmount || sample?.originalAmount);

      if (!hasDate && !hasAmount) continue;

      console.log('[MyFinanda] Parsing', arr.length, 'transactions from', url, '| sample keys:', Object.keys(sample).slice(0, 10).join(','));

      for (const item of arr) {
        const dateRaw = item.date || item.transactionDate || item.valueDate ||
                        item.תאריך || item.operationDate || item.executionDate || '';

        const descRaw = item.description || item.merchantName || item.name ||
                        item.תיאור || item.פירוט || item.businessName || item.details ||
                        item.memo || item.narrative || '';

        // Amount: prefer chargedAmount (what was actually charged), else sum, else debit/credit
        const amountRaw = item.chargedAmount ?? item.amount ?? item.sum ??
                          item.סכום ?? item.originalAmount ??
                          (item.credit ? item.credit : item.debit ? -Math.abs(item.debit) : 0);

        const amount = typeof amountRaw === 'number' ? amountRaw : parseFloat(String(amountRaw).replace(/[^\d.-]/g, '') || '0');

        // Account/type context
        const accountName = item.accountName || item.accountNumber || item.bankName || item.cardName || '';
        const txnType = item.type || item.transactionType || (amount > 0 ? 'income' : 'expense');

        if (!descRaw && amount === 0) continue;

        transactions.push({
          date: parseDateStr(dateRaw),
          description: String(descRaw || accountName || 'MyFinanda').trim(),
          amount,
          type: txnType,
          accountName,
          source: `api:${url}`,
        });
      }
    }
  }

  console.log('[MyFinanda] API parse result:', transactions.length, 'transactions');
  if (transactions.length > 0) {
    console.log('[MyFinanda] API sample (first 3):', JSON.stringify(transactions.slice(0, 3)));
  }
  return transactions;
}

// ─── HTML Table fallback ──────────────────────────────────────────────────────

async function extractTableTransactions(page, label) {
  const result = await page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')];
    if (tables.length === 0) return { transactions: [], debug: 'no tables found' };

    const allTransactions = [];
    const debugInfo = [];

    tables.forEach((tbl, tableIdx) => {
      const headers = [...tbl.querySelectorAll('th, thead td')].map(h => h.textContent?.trim() || '');
      const rows = [...tbl.querySelectorAll('tbody tr')];
      if (rows.length < 1) return;

      // Log structure for debugging
      const firstRows = rows.slice(0, 3).map(r => [...r.querySelectorAll('td')].map(c => c.textContent?.trim()?.substring(0, 25) || ''));
      debugInfo.push({ tableIdx, headers, rowCount: rows.length, firstRows });

      // Detect column indices from Hebrew headers
      let dateIdx = -1, descIdx = -1, amountIdx = -1, creditIdx = -1, debitIdx = -1;
      headers.forEach((h, i) => {
        const lh = h.trim();
        if (/תאריך|date/i.test(lh)) dateIdx = i;
        else if (/תיאור|פירוט|עסקה|תנועה|description|details/i.test(lh)) descIdx = i;
        else if (/סכום|amount|total/i.test(lh)) amountIdx = i;
        else if (/זיכוי|credit/i.test(lh)) creditIdx = i;
        else if (/חיוב|debit/i.test(lh)) debitIdx = i;
      });

      const cellCount = rows[0]?.querySelectorAll('td').length || 0;

      // Fallback: use positional heuristic for Israeli bank tables
      if (dateIdx === -1) dateIdx = 0;
      if (descIdx === -1 && cellCount >= 2) descIdx = 1;
      if (amountIdx === -1 && creditIdx === -1 && debitIdx === -1 && cellCount >= 3) {
        // Look for the column with decimal amounts
        // Try second-to-last column as a common pattern
        amountIdx = Math.max(2, cellCount - 2);
      }

      rows.forEach(row => {
        const cells = [...row.querySelectorAll('td')];
        if (cells.length < 2) return;
        const text = cells.map(c => c.textContent?.trim() || '');

        const dateText = text[dateIdx] || '';
        const descText = text[descIdx] || '';

        // Try to find the amount
        let amount = 0;
        if (amountIdx >= 0 && amountIdx < text.length) {
          const clean = text[amountIdx].replace(/[₪\s,]/g, '').replace(/[^\d.-]/g, '');
          amount = parseFloat(clean) || 0;
        } else if (creditIdx >= 0 || debitIdx >= 0) {
          const credit = creditIdx >= 0 ? parseFloat(text[creditIdx]?.replace(/[^\d.]/g, '') || '0') : 0;
          const debit  = debitIdx  >= 0 ? parseFloat(text[debitIdx]?.replace(/[^\d.]/g, '')  || '0') : 0;
          amount = credit > 0 ? credit : -debit;
        }

        // If amount is 0 or small integer (likely a date fragment), try finding a decimal number in any cell
        if (amount === 0 || (Math.abs(amount) < 50 && !String(amount).includes('.'))) {
          const decimalCell = text.find(t => /\d+\.\d{2}/.test(t));
          if (decimalCell) {
            const clean = decimalCell.replace(/[₪\s,]/g, '').replace(/[^\d.-]/g, '');
            amount = parseFloat(clean) || amount;
          }
        }

        if (!descText || descText.length < 1) return;

        allTransactions.push({
          date: dateText,
          description: descText,
          amount,
          raw: text.slice(0, 8),
          tableIdx,
        });
      });
    });

    return { transactions: allTransactions, debug: debugInfo };
  });

  if (result.debug !== 'no tables found') {
    console.log('[MyFinanda] Table structure (' + label + '):', JSON.stringify(result.debug));
  }
  if (result.transactions.length > 0) {
    console.log('[MyFinanda] Table sample (' + label + '):', JSON.stringify(result.transactions.slice(0, 3)));
  }
  return result.transactions;
}

// ─── SPA Navigation ───────────────────────────────────────────────────────────

async function navigateToPage(page, targetPath, description) {
  console.log('[MyFinanda] Navigating to:', description, '(' + targetPath + ')');

  // Strategy 1: SPA link click (preserves React in-memory auth)
  const clickResult = await page.evaluate((path) => {
    const link = [...document.querySelectorAll('a[href]')].find(a => {
      const href = a.getAttribute('href') || '';
      const lastSegment = path.split('/').filter(Boolean).pop() || '';
      return href.includes(lastSegment) || a.href.includes(path);
    });
    if (link) { link.click(); return 'click: ' + link.href; }
    return null;
  }, targetPath);

  if (clickResult) {
    console.log('[MyFinanda] SPA nav (link):', clickResult);
    await new Promise(r => setTimeout(r, 5000));
    if (!page.url().includes('/login')) return true;
    console.log('[MyFinanda] Link click → login, trying pushState...');
  }

  // Strategy 2: pushState (React Router client-side nav)
  await page.evaluate((path) => {
    window.history.pushState({}, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }, targetPath);
  console.log('[MyFinanda] SPA nav (pushState):', targetPath);
  await new Promise(r => setTimeout(r, 5000));

  if (!page.url().includes('/login')) return true;
  console.log('[MyFinanda] pushState → login, trying page.goto...');

  // Strategy 3: Full navigation (last resort)
  try {
    await page.goto(BASE_URL + targetPath, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    console.log('[MyFinanda] goto timeout (continuing):', e.message?.substring(0, 60));
  }

  if (page.url().includes('/login')) {
    throw new Error('Session lost after navigation to ' + targetPath + ' — cookies may have expired');
  }
  return true;
}

// ─── Visit all financial pages ────────────────────────────────────────────────

async function scrapeAllPages(page, apiState) {
  const tableTransactions = [];

  for (const { path, label } of FINANCIAL_PAGES) {
    try {
      await navigateToPage(page, path, label);
      await new Promise(r => setTimeout(r, 6000)); // Let SPA load data

      const currentUrl = page.url();
      console.log('[MyFinanda]', label, 'URL:', currentUrl);

      if (currentUrl.includes('/login')) {
        console.warn('[MyFinanda] Redirected to login at', label, '- skipping');
        continue;
      }

      // Collect table data (API data is captured automatically via interception)
      const tblTxns = await extractTableTransactions(page, label);
      tableTransactions.push(...tblTxns.map(t => ({ ...t, pageLabel: label })));

    } catch (err) {
      console.error('[MyFinanda] Error on page', label, ':', err.message);
    }
  }

  return tableTransactions;
}

// ─── Cookie Persistence ───────────────────────────────────────────────────────

async function saveSessionCookies(userId, page) {
  try {
    const cookies = await page.cookies();
    const storage = await page.evaluate(() => {
      const ss = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k); }
      const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); }
      return { sessionStorage: ss, localStorage: ls };
    });

    await getSupabase().from('open_banking_connections').upsert({
      user_id: userId,
      provider_name: 'MyFinanda',
      provider_code: 'myfinanda',
      connection_status: 'active',
      last_sync: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      session_data: { cookies, storage, savedAt: new Date().toISOString() },
    }, { onConflict: 'user_id,provider_code' });

    console.log('[MyFinanda] Saved', cookies.length, 'cookies to Supabase for future auto-sync');
  } catch (err) {
    console.error('[MyFinanda] Failed to save cookies:', err.message);
  }
}

async function loadSessionCookies(userId) {
  try {
    const { data } = await getSupabase()
      .from('open_banking_connections')
      .select('session_data, last_sync')
      .eq('user_id', userId)
      .eq('provider_code', 'myfinanda')
      .single();

    if (!data?.session_data?.cookies?.length) {
      console.log('[MyFinanda] No saved cookies found for user', userId);
      return null;
    }

    const savedAt = new Date(data.session_data.savedAt || data.last_sync);
    const ageHours = (Date.now() - savedAt.getTime()) / (1000 * 60 * 60);
    if (ageHours > 48) {
      console.log('[MyFinanda] Saved cookies are', Math.round(ageHours), 'h old — likely expired');
      return null;
    }

    console.log('[MyFinanda] Loaded', data.session_data.cookies.length, 'cookies (age:', Math.round(ageHours), 'h)');
    return data.session_data;
  } catch (err) {
    console.error('[MyFinanda] Failed to load cookies:', err.message);
    return null;
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

async function loginToMyFinanda(page) {
  console.log('[MyFinanda] Navigating to login...');
  await page.goto(BASE_URL + '/login', { waitUntil: 'networkidle2' });

  await page.waitForSelector('input[type="email"]', { timeout: 10000 });
  await page.type('input[type="email"]', MYFINANDA_EMAIL);
  await page.type('input[type="password"]', MYFINANDA_PASSWORD);

  const clickResult = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(
      b => b.textContent?.includes('כניסה') || b.textContent?.includes('Login') || b.type === 'submit'
    );
    if (btn) { btn.click(); return 'clicked: ' + btn.textContent?.trim(); }
    return 'no button';
  });
  console.log('[MyFinanda] Login click:', clickResult);

  try {
    await page.waitForFunction(() => !window.location.pathname.endsWith('/login'), { timeout: 30000 });
  } catch (e) {
    const state = await page.evaluate(() => ({ url: window.location.href, body: document.body.innerText?.substring(0, 200) }));
    throw new Error('Login timeout. URL: ' + state.url + ' | Body: ' + state.body);
  }

  console.log('[MyFinanda] Login complete, URL:', page.url());
  await new Promise(r => setTimeout(r, 3000)); // Let SPA initialize
}

async function waitForProfileLoading(page) {
  if (!page.url().includes('profile-is-loading')) return;
  console.log('[MyFinanda] Waiting for profile-is-loading...');
  try {
    await page.waitForFunction(
      () => !window.location.href.includes('profile-is-loading'),
      { timeout: 45000 }
    );
    console.log('[MyFinanda] Profile loaded, URL:', page.url());
  } catch {
    console.log('[MyFinanda] profile-is-loading timeout after 45s, proceeding. URL:', page.url());
  }
}

// ─── Data Processing ──────────────────────────────────────────────────────────

function parseDateStr(raw) {
  if (!raw) return new Date().toISOString().split('T')[0];
  const s = String(raw).trim();

  // ISO format
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);

  // DD/MM/YYYY or DD.MM.YYYY
  const dmy = s.match(/(\d{1,2})[/.\\-](\d{1,2})[/.\\-](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;

  // Timestamp (ms or s)
  const ts = Number(s);
  if (!isNaN(ts) && ts > 1000000000) {
    const d = new Date(ts > 9999999999 ? ts : ts * 1000);
    return d.toISOString().split('T')[0];
  }

  // JS Date string
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];

  return new Date().toISOString().split('T')[0];
}

function deduplicateTransactions(transactions) {
  const seen = new Set();
  return transactions.filter(t => {
    const key = `${t.date}|${t.amount}|${t.description?.substring(0, 30)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function saveDataToSupabase(userId, transactions, source) {
  if (!transactions.length) {
    console.log('[MyFinanda] No transactions to save');
    return 0;
  }

  const deduped = deduplicateTransactions(transactions);
  console.log('[MyFinanda] Saving', deduped.length, 'transactions (from', transactions.length, 'raw, source:', source + ')');

  // Check for existing transactions this month to avoid re-inserting
  const monthStart = new Date();
  monthStart.setDate(1);
  const { data: existing } = await getSupabase()
    .from('transactions')
    .select('transaction_date, amount, description')
    .eq('user_id', userId)
    .ilike('notes', '%[MyFinanda]%')
    .gte('transaction_date', monthStart.toISOString().split('T')[0]);

  const existingKeys = new Set((existing || []).map(e => `${e.transaction_date}|${e.amount}|${e.description?.substring(0, 30)}`));

  const toInsert = deduped
    .filter(t => {
      const key = `${t.date}|${t.amount}|${t.description?.substring(0, 30)}`;
      return !existingKeys.has(key);
    })
    .map(t => ({
      user_id: userId,
      account_id: null,
      amount: t.amount,
      type: t.amount >= 0 ? 'income' : 'expense',
      description: t.description?.substring(0, 200) || 'MyFinanda',
      transaction_date: t.date,
      notes: `[MyFinanda] ${t.accountName || ''} via ${source}`.trim(),
    }))
    .filter(t => t.description.length > 0);

  if (!toInsert.length) {
    console.log('[MyFinanda] All transactions already exist in DB — nothing new to insert');
    return 0;
  }

  const { error, data: saved } = await getSupabase().from('transactions').insert(toInsert).select();
  if (error) throw new Error('Supabase insert error: ' + error.message);

  const count = saved?.length || 0;
  console.log('[MyFinanda] Inserted', count, 'new transactions');
  return count;
}

// ─── Browser ──────────────────────────────────────────────────────────────────

function createBrowser(chromePath) {
  const execPath = chromePath || process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
  console.log('[MyFinanda] Starting browser, execPath:', execPath ? execPath.substring(0, 60) : 'auto');
  return puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--single-process', '--no-zygote', '--disable-dev-shm-usage'],
    executablePath: execPath || undefined,
    headless: true,
  });
}

async function setupPage(browser) {
  const page = await browser.newPage();
  page.setDefaultTimeout(30000);
  page.setDefaultNavigationTimeout(30000);
  await page.setViewport({ width: 1280, height: 800 });
  return page;
}

// ─── Phase 1: Start login, detect OTP ────────────────────────────────────────

async function startMyFinandaSession(chromePath) {
  const browser = await createBrowser(chromePath);
  const page = await setupPage(browser);

  await loginToMyFinanda(page);

  const state = await page.evaluate(() => {
    const otpInput = [...document.querySelectorAll('input')].find(i =>
      /tel|number/.test(i.type) ||
      /otp|code|token/.test((i.name + i.id).toLowerCase()) ||
      /קוד|code/i.test(i.placeholder)
    );
    return {
      url: window.location.href,
      hasOtpInput: !!otpInput,
      otpInfo: otpInput ? { type: otpInput.type, name: otpInput.name, id: otpInput.id } : null,
      bodyText: document.body.innerText?.substring(0, 400) || '',
    };
  });

  console.log('[MyFinanda] Post-login state:', state.url, '| OTP:', state.hasOtpInput);

  const needsOtp = state.url.includes('enter-otp') || state.url.includes('/login/') ||
    state.hasOtpInput || state.bodyText.includes('קוד') || state.bodyText.includes('SMS');

  return { browser, page, needsOtp };
}

// ─── Phase 2: Complete OTP, scrape everything ─────────────────────────────────

async function completeOtpAndScrape(browser, page, otp, userId) {
  console.log('[MyFinanda] Entering OTP:', otp);

  // Start API interception BEFORE submitting OTP (so we capture the initial data load)
  const apiState = startApiInterception(page);

  // Fill OTP
  const fillResult = await page.evaluate((otpCode) => {
    const input = [...document.querySelectorAll('input')].find(i =>
      /tel|number/.test(i.type) ||
      /otp|code|token/.test((i.name + i.id).toLowerCase()) ||
      /קוד|code/i.test(i.placeholder) ||
      (!['email', 'password', 'hidden'].includes(i.type) && i.offsetParent !== null)
    );
    if (!input) return 'no input found';
    input.focus();
    input.value = otpCode;
    ['input', 'change'].forEach(e => input.dispatchEvent(new Event(e, { bubbles: true })));
    return 'filled: ' + JSON.stringify({ type: input.type, name: input.name, id: input.id });
  }, otp);
  console.log('[MyFinanda] OTP fill:', fillResult);

  // Submit
  const submitResult = await page.evaluate(() => {
    const btn = [...document.querySelectorAll('button, input[type="submit"]')].find(
      b => /המשך|אישור|אמת|כניסה|שלח|Verify|Submit|Continue/i.test(b.textContent || '') || b.type === 'submit'
    );
    if (btn) { btn.click(); return 'clicked: ' + btn.textContent?.trim(); }
    return 'no button';
  });
  console.log('[MyFinanda] OTP submit:', submitResult);

  // Wait for URL to leave /login/*
  await page.waitForFunction(() => !window.location.pathname.startsWith('/login'), { timeout: 30000 });
  console.log('[MyFinanda] OTP accepted, URL:', page.url());

  // Wait for profile-is-loading
  await waitForProfileLoading(page);

  // Extra settle time for SPA auth + initial data load (API interceptor captures this)
  await new Promise(r => setTimeout(r, 5000));

  // Log auth state
  const authDebug = await page.evaluate(() => {
    const ls = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = (localStorage.getItem(k) || '').substring(0, 60); }
    const ss = {}; for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = (sessionStorage.getItem(k) || '').substring(0, 60); }
    return { url: window.location.href, lsCount: localStorage.length, ssCount: sessionStorage.length, ls, ss };
  });
  const cookies = await page.cookies();
  console.log('[MyFinanda] Auth state:', JSON.stringify({ url: authDebug.url, cookies: cookies.length, ls: authDebug.lsCount, ss: authDebug.ssCount }));
  console.log('[MyFinanda] localStorage keys:', JSON.stringify(authDebug.ls));

  // Scrape all financial pages
  const tableTransactions = await scrapeAllPages(page, apiState);

  // Stop interception and get all captured API data
  const apiResponses = stopApiInterception(page, apiState);

  // Parse API data (primary) and table data (fallback)
  const apiTransactions = parseTransactionsFromApiData(apiResponses);

  let finalTransactions;
  let source;
  if (apiTransactions.length > 0) {
    finalTransactions = apiTransactions;
    source = 'api';
    console.log('[MyFinanda] Using API data:', apiTransactions.length, 'transactions');
  } else {
    finalTransactions = tableTransactions;
    source = 'table';
    console.log('[MyFinanda] Using table fallback:', tableTransactions.length, 'transactions');
  }

  // Save cookies for future auto-sync
  await saveSessionCookies(userId, page);

  // Save transactions
  const saved = await saveDataToSupabase(userId, finalTransactions, source);

  // Update connection status
  await getSupabase().from('open_banking_connections').upsert({
    user_id: userId,
    provider_name: 'MyFinanda',
    provider_code: 'myfinanda',
    connection_status: 'active',
    last_sync: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id,provider_code' });

  console.log('[MyFinanda] ✓ Sync complete. Saved:', saved, '| Source:', source);
  return { success: true, transactionsExtracted: finalTransactions.length, transactionsSaved: saved, source };
}

// ─── Auto-sync with saved cookies (for CRON, no OTP) ─────────────────────────

async function autoScrapeWithCookies(userId, chromePath) {
  console.log('[MyFinanda] Auto-sync: loading saved cookies for user', userId);

  const sessionData = await loadSessionCookies(userId);
  if (!sessionData) {
    console.log('[MyFinanda] No valid cookies — auto-sync skipped (manual OTP sync required)');
    return { skipped: true, reason: 'no_cookies' };
  }

  const browser = await createBrowser(chromePath);
  const page = await setupPage(browser);

  try {
    // Navigate to base URL first to set domain
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

    // Restore cookies
    await page.setCookie(...sessionData.cookies);

    // Restore localStorage
    if (sessionData.storage?.localStorage) {
      await page.evaluate((ls) => {
        for (const [k, v] of Object.entries(ls)) { try { localStorage.setItem(k, v); } catch { } }
      }, sessionData.storage.localStorage);
    }

    console.log('[MyFinanda] Cookies restored. Navigating to app...');
    await page.goto(BASE_URL + '/checking-cards-cash/unified_checking', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 5000));

    if (page.url().includes('/login')) {
      console.log('[MyFinanda] Cookies expired — redirected to login. Auto-sync skipped.');
      await browser.close();
      return { skipped: true, reason: 'cookies_expired' };
    }

    console.log('[MyFinanda] Auto-login success! URL:', page.url());

    const apiState = startApiInterception(page);
    const tableTransactions = await scrapeAllPages(page, apiState);
    const apiResponses = stopApiInterception(page, apiState);
    const apiTransactions = parseTransactionsFromApiData(apiResponses);

    const finalTransactions = apiTransactions.length > 0 ? apiTransactions : tableTransactions;
    const source = apiTransactions.length > 0 ? 'api-auto' : 'table-auto';

    // Refresh cookies
    await saveSessionCookies(userId, page);

    const saved = await saveDataToSupabase(userId, finalTransactions, source);

    await getSupabase().from('open_banking_connections').upsert({
      user_id: userId,
      provider_name: 'MyFinanda',
      provider_code: 'myfinanda',
      connection_status: 'active',
      last_sync: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,provider_code' });

    console.log('[MyFinanda] Auto-sync done. Saved:', saved);
    return { success: true, transactionsSaved: saved, source };

  } catch (err) {
    console.error('[MyFinanda] Auto-sync error:', err.message);
    return { skipped: true, reason: err.message };
  } finally {
    await browser.close();
  }
}

// ─── Backward compat: direct scrape (no OTP flow) ────────────────────────────

async function scrapeMyFinanda(userId, chromePath) {
  let browser;
  try {
    const session = await startMyFinandaSession(chromePath);
    browser = session.browser;

    if (session.needsOtp) throw new Error('OTP_REQUIRED');

    const apiState = startApiInterception(session.page);
    const tableTransactions = await scrapeAllPages(session.page, apiState);
    const apiResponses = stopApiInterception(session.page, apiState);
    const apiTransactions = parseTransactionsFromApiData(apiResponses);

    const finalTransactions = apiTransactions.length > 0 ? apiTransactions : tableTransactions;
    const saved = await saveDataToSupabase(userId, finalTransactions, apiTransactions.length > 0 ? 'api' : 'table');

    return { success: true, transactionsExtracted: finalTransactions.length, transactionsSaved: saved };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

async function extractAndSaveData(page, userId) {
  const apiState = startApiInterception(page);
  const tableTransactions = await scrapeAllPages(page, apiState);
  const apiResponses = stopApiInterception(page, apiState);
  const apiTransactions = parseTransactionsFromApiData(apiResponses);
  const finalTransactions = apiTransactions.length > 0 ? apiTransactions : tableTransactions;
  const saved = await saveDataToSupabase(userId, finalTransactions, apiTransactions.length > 0 ? 'api' : 'table');
  return { transactionsExtracted: finalTransactions.length, transactionsSaved: saved };
}

export {
  scrapeMyFinanda,
  startMyFinandaSession,
  completeOtpAndScrape,
  extractAndSaveData,
  autoScrapeWithCookies,
};
