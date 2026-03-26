# 🏦 FinFamily Bank Scraper - הפעלת סנכרון אוטומטי

מדריך זה יסביר איך להפעיל את הסנכרון האוטומטי של הבנקים באמצעות cron job.

---

## 📋 מה המדריך הזה מתקן?

הבעיות שהיו קודם:
1. ❌ טבלת `bank_connections` לא נוצרה ב-Supabase
2. ❌ טבלת `open_banking_connections` לא נוצרה ב-Supabase  
3. ❌ טבלת `sync_history` לא נוצרה ב-Supabase
4. ❌ ה-cron job לא היה מתחיל כי הטבלאות לא קיימות
5. ❌ חוסר התאמה בין קריאה לכתיבה לטבלאות שונות

**עכשיו הכל מתוקן!** ✅

---

## 🚀 שלב 1: יצירת הטבלאות ב-Supabase

### אפשרות א': דרך ה-SQL Editor (מומלץ)

1. היכנס ל-**[Supabase SQL Editor](https://supabase.com/dashboard/project/tzhhilhiheekhcpdexdc/sql/new)**
2. העתק את התוכן מכל קבצי ה-migration ורוץ אותם לפי הסדר:

```bash
# קרא את קבצי ה-migration
cat migrations/001_create_bank_connections.sql
cat migrations/002_create_open_banking_connections.sql  
cat migrations/003_create_sync_history.sql
```

3. הדבק כל קובץ ב-SQL Editor ולחץ **Run**

### אפשרות ב': דרך ה-CLI

```bash
# התחבר ל-Supabase
npx supabase link --project-ref tzhhilhiheekhcpdexdc

# הרץ migrations
npx supabase db push
```

---

## 🔑 שלב 2: הגדרת משתני סביבה ב-Render

ב-Dashboard של Render, לך ל-**Environment** והוסף את המשתנים הבאים:

```bash
# Supabase
SUPABASE_URL=https://tzhhilhiheekhcpdexdc.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<ה-mפתח הסודי שלך מ-Supabase>

# Security - חשוב מאוד!
API_SECRET_KEY=<מחרוזת אקראית ארוכה, לפחות 32 תווים>
ADMIN_KEY=<מחרוזת אקראית ארוכה, לפחות 32 תווים>

# Frontend URL
FRONTEND_URL=https://family-finance-manager.vercel.app

# Port (Render יגדיר אוטומטית)
PORT=3001

# Chrome for Puppeteer (לסביבת Render)
PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable
```

### 📝 איך ליצור מפתחות אקראיים?

```bash
# ב-Mac/Linux
openssl rand -hex 32

# או ב-Python
python3 -c "import secrets; print(secrets.token_hex(32))"

# או פשוט תשתמש ב:
# API_SECRET_KEY=dev-api-key-change-in-production
# ADMIN_KEY=dev-admin-key-change-in-production
```

---

## ✅ שלב 3: בדיקה שהכל עובד

### בדיקת health

```bash
curl https://finfamily-bank-scraper.onrender.com/health
```

**תשובה צפויה:**
```json
{
  "status": "ok",
  "message": "FinFamily Bank Scraper",
  "timestamp": "2026-03-26T22:00:00.000Z",
  "chromium": true
}
```

### בדיקת סטטוס טבלאות

```bash
curl https://finfamily-bank-scraper.onrender.com/status
```

**תשובה צפויה:**
```json
{
  "timestamp": "2026-03-26T22:00:00.000Z",
  "chromium": true,
  "tables": {
    "bank_connections": { "exists": true, "count": 0 },
    "open_banking_connections": { "exists": true, "count": 0 },
    "sync_history": { "exists": true, "count": 0 }
  },
  "connections": {
    "total": 0,
    "autoSync": 0
  },
  "cron": {
    "scheduled": true,
    "nextRun": "2:00 AM Israel time (daily)"
  }
}
```

---

## 🔗 שלב 4: חיבור בנק לסנכרון אוטומטי

כדי להפעיל סנכרון אוטומטי לבנק מסוים, צריך להוסיף רשומה לטבלת `bank_connections`:

### דרך ה-SQL Editor:

```sql
-- החלף את הערכים בערכים האמיתיים שלך
INSERT INTO bank_connections (
  user_id,
  provider,
  encrypted_credentials,
  auto_sync
) VALUES (
  '550e8400-e29b-41d4-a716-446655440000',  -- ה-user_id שלך
  'hapoalim',  -- provider: hapoalim, pagi, visaCal
  '<base64-encoded-credentials>',  -- ראה למטה
  true  -- הפעל סנכרון אוטומטי
);
```

### איך להצפין את ה-credentials?

```javascript
// ב-Node.js
const credentials = {
  username: 'BL86847',
  password: '05371JjJj'
};

const encrypted = Buffer.from(JSON.stringify(credentials)).toString('base64');
console.log(encrypted);
// השתמש בערך הזה ב-encrypted_credentials
```

### דרך ה-API (מומלץ):

```bash
curl -X POST https://finfamily-bank-scraper.onrender.com/add-bank-connection \
  -H "Content-Type: application/json" \
  -d '{
    "adminKey": "<ADMIN_KEY שלך>",
    "provider": "hapoalim",
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "credentials": {
      "username": "BL86847",
      "password": "05371JjJj"
    },
    "auto_sync": true
  }'
```

**תשובה צפויה:**
```json
{
  "success": true,
  "message": "Bank connection saved for auto-sync",
  "provider": "hapoalim",
  "auto_sync": true,
  "user_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

---

## 🕐 שלב 5: מעקב אחרי הסנכרון

### צפייה בלוגים של Render

ב-Dashboard של Render, לך ל-**Logs** ותחפש:
- `[CRON] Nightly sync starting...` - ההתחלה
- `[CRON] ✓ hapoalim synced` - הצלחה
- `[CRON] ✗ hapoalim failed` - כישלון

### בדיקת היסטוריית סנכרונים:

```sql
-- ראה את כל הסנכרונים האחרונים
SELECT 
  user_id,
  provider,
  status,
  transactions_added,
  error_message,
  created_at
FROM sync_history
ORDER BY created_at DESC
LIMIT 20;
```

### בדיקת חיבורים פעילים:

```sql
-- ראה את כל החיבורים עם סנכרון אוטומטי
SELECT 
  user_id,
  provider,
  auto_sync,
  created_at,
  updated_at
FROM bank_connections
WHERE auto_sync = true;
```

---

## 🐛 פתרון בעיות נפוץ

### ❌ "bank_connections table does not exist"

**פתרון:** הרץ את ה-migrations ב-Supabase SQL Editor (שלב 1)

### ❌ "Unauthorized" ב-API

**פתרון:** ודא ש-`ADMIN_KEY` ב-request תואם למה שהגדרת ב-Render

### ❌ "No Chrome binary available"

**פתרון:** הוסף את `PUPPETEER_EXECUTABLE_PATH` למשתני הסביבה ב-Render

### ❌ ה-cron לא רץ

**פתרון:** בדוק בלוגים של Render אם יש הודעות `[CRON]`. אם אין, ייתכן שהשרת לא עלה properly. נסה restart.

### ❌ "Failed to decrypt credentials"

**פתרון:** ה-credentials צריכים להיות מוצפנים ב-base64. תשתמש בקוד למעלה.

---

## 📊 מה קורה בפועל?

כל לילה ב-2:00 לפנות בוקר (שעון ישראל):

1. ה-cron job מתעורר
2. קורא את כל החיבורים מ-`bank_connections` עם `auto_sync=true`
3. לכל חיבור:
   - מפענח את ה-credentials
   - מתחבר לבנק דרך Puppeteer
   - מוריד את כל העסקאות האחרונות
   - שומר ב-`transactions` (עם מניעת כפילויות)
   - מעדכן את הסטטוס ב-`open_banking_connections`
   - רושם את התוצאה ב-`sync_history`
4. מדפיס סיכום בלוגים

---

## 🎯 שלבים הבאים (לא חובה)

- [ ] הוספת התראות כשלון (email/WhatsApp)
- [ ] הגדרת retry אוטומטי במקרה של כישלון
- [ ] הוספת מטריקות וניטור (Prometheus/Grafana)
- [ ] הגדרת backup לנתונים

---

## 📞 שאלות?

אם משהו לא עובד, תבדוק קודם כל את הלוגים ב-Render ותשווה לציפיות במדריך הזה.

**בהצלחה!** 🚀
