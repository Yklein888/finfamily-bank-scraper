-- Migration 002: Create open_banking_connections table
-- This table tracks bank connection status and sync history
-- Fixes the mismatch where code writes to open_banking_connections but reads from bank_connections

-- Create open_banking_connections table for tracking connection status
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

-- Create indexes for queries
CREATE INDEX IF NOT EXISTS idx_obc_user_id ON open_banking_connections(user_id);
CREATE INDEX IF NOT EXISTS idx_obc_provider_code ON open_banking_connections(provider_code);
CREATE INDEX IF NOT EXISTS idx_obc_status ON open_banking_connections(connection_status);

-- Enable RLS
ALTER TABLE open_banking_connections ENABLE ROW LEVEL SECURITY;

-- Allow service role (for Render server) to read/write
CREATE POLICY "Service role full access" ON open_banking_connections
  FOR ALL USING (true)
  WITH CHECK (true);

-- Allow authenticated users to read their own connections
CREATE POLICY "Users can view own connections" ON open_banking_connections
  FOR SELECT USING (auth.uid()::text = user_id::text);

COMMENT ON TABLE open_banking_connections IS 'Tracks open banking connection status and sync history for each user-provider pair';
COMMENT ON COLUMN open_banking_connections.connection_status IS 'pending=initial setup, active=working, failed=auth error, expired=credentials expired';
