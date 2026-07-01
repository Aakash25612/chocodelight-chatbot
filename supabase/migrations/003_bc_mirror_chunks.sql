-- Chunk storage for large BC entities that exceed PostgREST request/statement limits.

CREATE TABLE IF NOT EXISTS bc_mirror_chunks (
  company TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload JSONB NOT NULL,
  synced_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (company, entity_type, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_bc_mirror_chunks_entity
  ON bc_mirror_chunks(company, entity_type, chunk_index);
