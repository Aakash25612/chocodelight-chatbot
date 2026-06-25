-- BC mirror tables for cloud multi-user access
-- Applied via Supabase Management API

CREATE TABLE IF NOT EXISTS bc_mirror (
  entity_type TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  synced_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bc_mirror_cache (
  cache_key TEXT PRIMARY KEY,
  payload JSONB NOT NULL,
  synced_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bc_sync_meta (
  key TEXT PRIMARY KEY,
  last_synced_at TIMESTAMPTZ,
  record_count INTEGER,
  status TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS bc_write_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT DEFAULT 'pending',
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bc_write_queue_status ON bc_write_queue(status, created_at);
