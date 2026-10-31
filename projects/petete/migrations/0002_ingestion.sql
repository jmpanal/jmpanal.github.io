ALTER TABLE rulings ADD COLUMN summary_model TEXT;
ALTER TABLE rulings ADD COLUMN summary_at TEXT;
ALTER TABLE rulings ADD COLUMN summary_content_hash TEXT;
ALTER TABLE rulings ADD COLUMN provenance TEXT NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS ruling_chunks (
 id TEXT PRIMARY KEY, ruling_id TEXT NOT NULL REFERENCES rulings(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL, text TEXT NOT NULL, summary TEXT, summary_model TEXT, summary_at TEXT,
 embedding_status TEXT NOT NULL DEFAULT 'pending', error TEXT, UNIQUE(ruling_id,ordinal)
);
CREATE INDEX IF NOT EXISTS ruling_chunks_ruling ON ruling_chunks(ruling_id,ordinal);
CREATE INDEX IF NOT EXISTS ruling_chunks_pending ON ruling_chunks(embedding_status);
ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN retry_at TEXT;
ALTER TABLE jobs ADD COLUMN lease_until TEXT;
CREATE TABLE IF NOT EXISTS ruling_synthesis (
 id TEXT PRIMARY KEY, ruling_id TEXT NOT NULL REFERENCES rulings(id) ON DELETE CASCADE,
 content_hash TEXT NOT NULL, level INTEGER NOT NULL, ordinal INTEGER NOT NULL, summary TEXT NOT NULL,
 model TEXT NOT NULL, created_at TEXT NOT NULL,
 UNIQUE(ruling_id,content_hash,level,ordinal)
);
ALTER TABLE ruling_chunks ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ruling_chunks ADD COLUMN retry_at TEXT;
ALTER TABLE rulings ADD COLUMN summary_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE rulings ADD COLUMN summary_retry_at TEXT;
ALTER TABLE rulings ADD COLUMN summary_error TEXT;
CREATE TABLE IF NOT EXISTS ingestion_job_documents (
 job_id TEXT NOT NULL REFERENCES jobs(id), reference TEXT NOT NULL,
 PRIMARY KEY(job_id,reference)
);
CREATE TABLE IF NOT EXISTS vector_cleanup (
 id TEXT PRIMARY KEY, created_at TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, retry_at TEXT, error TEXT
);
