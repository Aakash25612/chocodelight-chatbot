-- Multi-company support: scope mirror data, cache, sync meta, and write queue
-- by company. Existing rows default to 'chocodelight'.

-- bc_mirror: composite PK (company, entity_type)
ALTER TABLE bc_mirror
  ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'chocodelight';

ALTER TABLE bc_mirror DROP CONSTRAINT IF EXISTS bc_mirror_pkey;
ALTER TABLE bc_mirror ADD PRIMARY KEY (company, entity_type);

-- bc_mirror_cache: composite PK (company, cache_key)
ALTER TABLE bc_mirror_cache
  ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'chocodelight';

ALTER TABLE bc_mirror_cache DROP CONSTRAINT IF EXISTS bc_mirror_cache_pkey;
ALTER TABLE bc_mirror_cache ADD PRIMARY KEY (company, cache_key);

-- bc_sync_meta: composite PK (company, key)
ALTER TABLE bc_sync_meta
  ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'chocodelight';

ALTER TABLE bc_sync_meta DROP CONSTRAINT IF EXISTS bc_sync_meta_pkey;
ALTER TABLE bc_sync_meta ADD PRIMARY KEY (company, key);

-- bc_write_queue: tag each queued write with its company (PK stays id)
ALTER TABLE bc_write_queue
  ADD COLUMN IF NOT EXISTS company TEXT NOT NULL DEFAULT 'chocodelight';

CREATE INDEX IF NOT EXISTS idx_bc_write_queue_company_status
  ON bc_write_queue(company, status, created_at);
