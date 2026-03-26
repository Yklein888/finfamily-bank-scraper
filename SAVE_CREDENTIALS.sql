-- ============================================
-- הוספת חיבורי בנק ל-Supabase (מוצפן)
-- ============================================
-- הערה: ה-credentials מוצפנים ב-base64
-- אל תריץ את זה אם אתה לא רוצה לשמור את הסיסמאות!
-- ============================================

-- פג"י (בנק לאומי)
INSERT INTO bank_connections (user_id, provider, encrypted_credentials, auto_sync)
VALUES (
  '550e8400-e29b-41d4-a716-446655440000',  -- החלף ב-user_id האמיתי שלך
  'pagi',
  'eyJ1c2VybmFtZSI6Ikk3NjZBTEsiLCJwYXNzd29yZCI6IjUzODAyNjZKakAifQ==',  -- I766ALK / 5380266Jj@
  true
)
ON CONFLICT (user_id, provider) DO UPDATE SET
  encrypted_credentials = EXCLUDED.encrypted_credentials,
  auto_sync = EXCLUDED.auto_sync,
  updated_at = now();

-- בנק הפועלים
INSERT INTO bank_connections (user_id, provider, encrypted_credentials, auto_sync)
VALUES (
  '550e8400-e29b-41d4-a716-446655440000',
  'hapoalim',
  'eyJ1c2VybmFtZSI6IkJMODY4NDciLCJwYXNzd29yZCI6IjA1MzcxSmpKaiJ9',  -- BL86847 / 05371JjJj
  true
)
ON CONFLICT (user_id, provider) DO UPDATE SET
  encrypted_credentials = EXCLUDED.encrypted_credentials,
  auto_sync = EXCLUDED.auto_sync,
  updated_at = now();

-- CAL (ויזה כאל)
INSERT INTO bank_connections (user_id, provider, encrypted_credentials, auto_sync)
VALUES (
  '550e8400-e29b-41d4-a716-446655440000',
  'visaCal',
  'eyJ1c2VybmFtZSI6IjAyNTM4MDI2IiwicGFzc3dvcmQiOiI1MzgwMjY2SmpKakpqIn0=',  -- 02538026 / 5380266JjJjJj
  true
)
ON CONFLICT (user_id, provider) DO UPDATE SET
  encrypted_credentials = EXCLUDED.encrypted_credentials,
  auto_sync = EXCLUDED.auto_sync,
  updated_at = now();

-- ============================================
-- בדיקה שהכל נשמר
-- ============================================
SELECT provider, auto_sync, created_at FROM bank_connections;
