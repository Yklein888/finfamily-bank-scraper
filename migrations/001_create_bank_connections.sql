-- Create bank_connections table for auto-sync credentials
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

-- Create indexes for queries
CREATE INDEX IF NOT EXISTS idx_bank_connections_auto_sync ON bank_connections(auto_sync);
CREATE INDEX IF NOT EXISTS idx_bank_connections_user_id ON bank_connections(user_id);

-- Enable RLS
ALTER TABLE bank_connections ENABLE ROW LEVEL SECURITY;

-- Allow service role (for Render server) to read/write
CREATE POLICY "Service role full access" ON bank_connections
  FOR ALL USING (true)
  WITH CHECK (true);
