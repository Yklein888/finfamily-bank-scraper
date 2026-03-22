# Setup bank_connections Table

The auto-sync feature requires a `bank_connections` table in Supabase to store encrypted bank credentials.

## Quick Setup (3 steps)

### 1️⃣ Create the Table in Supabase

Go to **[Supabase SQL Editor](https://supabase.com/dashboard/project/tzhhilhiheekhcpdexdc/sql/new)** and run this SQL:

```sql
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
```

### 2️⃣ Restart Render Server

Your Render server will detect the table and log: `✓ bank_connections table ready`

### 3️⃣ Test It

Call the endpoint to save bank credentials:

```bash
curl -X POST https://finfamily-bank-scraper.onrender.com/add-bank-connection \
  -H "Content-Type: application/json" \
  -d '{
    "adminKey": "dev-admin-key-change-in-production",
    "provider": "hapoalim",
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "credentials": {
      "username": "BL86847",
      "password": "05371JjJj"
    },
    "auto_sync": true
  }'
```

Response should be:
```json
{
  "success": true,
  "message": "Bank connection saved for auto-sync",
  "provider": "hapoalim",
  "auto_sync": true,
  "user_id": "550e8400-e29b-41d4-a716-446655440000"
}
```

## How It Works

1. **Frontend** calls `/add-bank-connection` with `user_id` and bank credentials
2. **Render server** encrypts the credentials and saves to `bank_connections` table
3. **Cron job** runs daily (2 AM UTC) and syncs all connections with `auto_sync=true`
4. **Transactions** are saved to the `transactions` table

## Troubleshooting

- **"Failed to fetch"** from frontend? → Frontend is calling `localhost:3001` instead of Render URL
- **0 connections found?** → Table not created yet, follow step 1
- **Permission denied?** → RLS policy issue, run the full SQL above including the policy
