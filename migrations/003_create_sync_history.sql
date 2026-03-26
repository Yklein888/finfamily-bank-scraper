-- Migration 003: Create sync_history table for tracking sync attempts
-- This table logs all sync attempts for monitoring and debugging

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

-- Create indexes for queries
CREATE INDEX IF NOT EXISTS idx_sync_history_user_id ON sync_history(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_history_provider ON sync_history(provider);
CREATE INDEX IF NOT EXISTS idx_sync_history_status ON sync_history(status);
CREATE INDEX IF NOT EXISTS idx_sync_history_created_at ON sync_history(created_at);

-- Enable RLS
ALTER TABLE sync_history ENABLE ROW LEVEL SECURITY;

-- Allow service role (for Render server) to read/write
CREATE POLICY "Service role full access" ON sync_history
  FOR ALL USING (true)
  WITH CHECK (true);

-- Allow authenticated users to read their own history
CREATE POLICY "Users can view own history" ON sync_history
  FOR SELECT USING (auth.uid()::text = user_id::text);

COMMENT ON TABLE sync_history IS 'Logs all bank sync attempts for monitoring, debugging, and analytics';
