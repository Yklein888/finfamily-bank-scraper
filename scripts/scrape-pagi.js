import { createScraper, CompanyTypes } from "israeli-bank-scrapers";
import axios from "axios";

const SUPABASE_PUSH_URL = "https://tzhhilhiheekhcpdexdc.supabase.co/functions/v1/bank-push";
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
const USER_ID = "16274024-a305-4416-ba62-9b321669d7d6";

async function scrapeAndPush() {
  const username = process.env.PAGI_USERNAME;
  const password = process.env.PAGI_PASSWORD;
  console.log("[Pagi] ENV:", { username: username ? "ok" : "MISSING", password: password ? "ok" : "MISSING", key: SCRAPER_API_KEY ? "ok" : "MISSING", platform: process.platform });
  if (!username || !password) throw new Error("Missing credentials");
  if (!SCRAPER_API_KEY) throw new Error("Missing SCRAPER_API_KEY");
  console.log("[Pagi] Starting at", new Date().toISOString());
  const scraperOptions = {
    companyId: CompanyTypes.pagi,
    startDate: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
    combineInstallments: false,
    showBrowser: false,
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    timeout: 90000,
  };
  console.log("[Pagi] Logging in...");
  const scraper = createScraper(scraperOptions);
  const result = await scraper.scrape({ username, password });
  console.log("[Pagi] Result success:", result.success, "| error:", result.errorMessage || "none");
  if (!result.success) throw new Error("Scraper failed: " + (result.errorMessage || "unknown"));
  const accounts = result.accounts;
  console.log("[Pagi] Accounts:", accounts ? accounts.length : 0);
  if (!accounts || accounts.length === 0) throw new Error("No accounts returned");
  for (const account of accounts) {
    const txCount = account.txns ? account.txns.length : 0;
    console.log("[Pagi] Account", account.accountNumber, "| txns:", txCount);
    const payload = { source: "pagi", user_id: USER_ID, account_id: account.accountNumber || "auto", balance: account.balance, transactions: account.txns || [], fetched_at: new Date().toISOString() };
    console.log("[Pagi] Pushing to Supabase...");
    const res = await axios.post(SUPABASE_PUSH_URL, payload, {
      headers: { "x-scraper-api-key": SCRAPER_API_KEY, "Content-Type": "application/json" },
      timeout: 180000,
    });
    console.log("[Pagi] Push result:", JSON.stringify(res.data));
  }
  console.log("[Pagi] Done");
}

scrapeAndPush().catch(err => { console.error("[Pagi] Fatal:", err.message); process.exit(1); });