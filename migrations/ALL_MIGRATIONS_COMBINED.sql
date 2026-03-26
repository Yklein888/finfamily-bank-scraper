-- =====================================================
-- FinFamily Bank Scraper - Complete Database Setup
-- =====================================================
-- Copy and paste this ENTIRE file into Supabase SQL Editor
-- Then click "Run" to execute all migrations at once
-- =====================================================

-- =====================================================
-- Migration 001: bank_connections table
-- Stores encrypted bank credentials for auto-sync
-- =====================================================

CREATE TABLE IF NOT EXISTS bank_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  provider TEXT NOT NULL,
  encrypted_credentials TEXT NOT NULL,
  auto_sync BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(user_id, provider)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_bank_connections_auto_sync ON bank_connections(auto_sync);
CREATE INDEX IF NOT EXISTS idx_bank_connections_user_id ON bank_connections(user_id);

-- Enable Row Level Security
ALTER TABLE bank_connections ENABLE ROW LEVEL SECURITY;

-- Policy: Service role has full access (for Render server)
CREATE POLICY "Service role full access" ON bank_connections
  FOR ALL USING (true)
  WITH CHECK (true);

-- Policy: Users can view their own connections
CREATE POLICY "Users can view own connections" ON bank_connections
  FOR SELECT USING (auth.uid()::text = user_id::text);

COMMENT ON TABLE bank_connections IS 'Stores encrypted bank credentials for automatic daily sync';
COMMENT ON COLUMN bank_connections.auto_sync IS 'If true, this connection will be synced daily at 2 AM Israel time';


-- =====================================================
-- Migration 002: open_banking_connections table
-- Tracks connection status and sync history
-- =====================================================

CREATE TABLE IF NOT EXISTS open_banking_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  provider_name TEXT NOT NULL,
  provider_code TEXT NOT NULL,
  connection_status TEXT DEFAULT 'pending' CHECK (connection_status IN ('pending', 'active', 'failed', 'expired')),
  last_sync TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  UNIQUE(user_id, provider_code)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_obc_user_id ON open_banking_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_obc_provider_code ON open_banking_connections(provider_code);
CREATE INDEX IF NOT EXISTS idx_obc_status ON open_banking_connections(connection_status);

-- Enable Row Level Security
ALTER TABLE open_banking_connections ENABLE ROW LEVEL SECURITY;

-- Policy: Service role has full access (for Render server)
CREATE POLICY "Service role full access" ON open_banking_connections
  FOR ALL USING (true)
  WITH CHECK (true);

-- Policy: Users can view their own connections
CREATE POLICY "Users can view own connections" ON open_banking_connections
  FOR SELECT USING (auth.uid()::text = user_id::text);

COMMENT ON TABLE open_banking_connections IS 'Tracks open banking connection status and last sync time for each user-provider pair';
COMMENT ON COLUMN open_banking_connections.connection_status IS 'pending=initial setup, active=working, failed=auth error, expired=credentials expired';


-- =====================================================
-- Migration 003: sync_history table
-- Logs all sync attempts for monitoring and debugging
-- =====================================================

CREATE TABLE IF NOT EXISTS sync_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'failed', 'partial')),
  error_message TEXT,
  transactions_added INTEGER DEFAULT 0,
  transactions_skipped INTEGER DEFAULT 0,
  duration_ms INTEGER,
  sync_type TEXT DEFAULT 'manual' CHECK (sync_type IN ('manual', 'cron', 'api')),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sync_history_user_id ON sync_history(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_provider ON sync_history(provider);
CREATE INDEX IF NOT EXISTS idx_sync_history_status ON sync_history(status);
CREATE INDEX IF NOT EXISTS idx_sync_history_created_at ON sync_history(created_at);

-- Enable Row Level Security
ALTER TABLE sync_history ENABLE ROW LEVEL SECURITY;

-- Policy: Service role has full access (for Render server)
CREATE POLICY "Service role full access" ON sync_history
  FOR ALL USING (true)
  WITH CHECK (true);

-- Policy: Users can view their own history
CREATE POLICY "Users can view own history" ON sync_history
  FOR SELECT USING (auth.uid()::text = user_id::text);

COMMENT ON TABLE sync_history IS 'Logs all bank sync attempts for monitoring, debugging, and analytics';


-- =====================================================
-- Verification queries (run these after migrations)
-- =====================================================

-- Check that all tables were created
SELECT 
  'bank_connections' as table_name, 
  COUNT(*) as row_count 
FROM bank_connections
UNION ALL
SELECT 'open_banking_connections', COUNT(*) FROM open_banking_connections
UNION ALL
SELECT 'sync_history', COUNT(*) FROM sync_history;

-- Show table sizes
SELECT 
  schemaname,
  tablename,
  pg_size_pretty(pg_total_relation_size(schemaname||'.'||tablename)) AS size
FROM pg_tables
WHERE tablename IN ('bank_connections', 'open_banking_connections', 'sync_history')
ORDER BY tablename;


-- =====================================================
-- Example: Add a test bank connection (OPTIONAL - comment out if not needed)
-- =====================================================
/*
INSERT INTO bank_connections (
  user_id,
  provider,
  encrypted_credentials,
  auto_sync
) VALUES (
  '550e8400-e29b-41d4-a716-446655440000',  -- Replace with your actual user_id
  'hapoalim',  -- Options: hapoalim, pagi, visaCal
  'eyJ1c2VybmFtZSI6IkJMODY4NDciLCJwYXNzd29yZCI6IjA1MzcxSmpKaiJ9',  -- Base64 of {"username":"BL86847","password":"05371JjJj"}
  true  -- Enable auto-sync
)
ON CONFLICT (user_id, provider) DO UPDATE SET
  auto_sync = EXCLUDED.auto_sync,
  updated_at = now();
*/


-- =====================================================
-- Done! All tables created successfully ✅
-- =====================================================
