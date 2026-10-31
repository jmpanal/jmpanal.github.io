PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','blocked','canceled')),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE,
 ip_hash TEXT NOT NULL, user_agent TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id, expires_at);
CREATE TABLE IF NOT EXISTS login_attempts (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, window_start TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit_logs (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_id TEXT, detail TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rulings (
 id TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('dgt','cendoj')), reference TEXT NOT NULL,
 date TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, summary TEXT,
 summary_status TEXT NOT NULL DEFAULT 'pending', source_url TEXT NOT NULL, tax TEXT NOT NULL DEFAULT '',
 topics TEXT NOT NULL DEFAULT '[]', binding INTEGER NOT NULL DEFAULT 0,
 content_hash TEXT NOT NULL DEFAULT '', indexed_at TEXT NOT NULL, embedding_status TEXT NOT NULL DEFAULT 'pending',
 UNIQUE(source,reference)
);
CREATE INDEX IF NOT EXISTS rulings_date ON rulings(date);
CREATE INDEX IF NOT EXISTS rulings_source_tax_date ON rulings(source,tax,date);
CREATE VIRTUAL TABLE IF NOT EXISTS rulings_fts USING fts5(title, text, reference, summary, content='rulings', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS rulings_ai AFTER INSERT ON rulings BEGIN INSERT INTO rulings_fts(rowid,title,text,reference,summary) VALUES (new.rowid,new.title,new.text,new.reference,new.summary); END;
CREATE TRIGGER IF NOT EXISTS rulings_ad AFTER DELETE ON rulings BEGIN INSERT INTO rulings_fts(rulings_fts,rowid,title,text,reference,summary) VALUES ('delete',old.rowid,old.title,old.text,old.reference,old.summary); END;
CREATE TRIGGER IF NOT EXISTS rulings_au AFTER UPDATE ON rulings BEGIN INSERT INTO rulings_fts(rulings_fts,rowid,title,text,reference,summary) VALUES ('delete',old.rowid,old.title,old.text,old.reference,old.summary); INSERT INTO rulings_fts(rowid,title,text,reference,summary) VALUES (new.rowid,new.title,new.text,new.reference,new.summary); END;
CREATE TABLE IF NOT EXISTS bookmarks (user_id TEXT NOT NULL REFERENCES users(id), ruling_id TEXT NOT NULL REFERENCES rulings(id), created_at TEXT NOT NULL, PRIMARY KEY(user_id,ruling_id));
CREATE TABLE IF NOT EXISTS jobs (
 id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', from_date TEXT NOT NULL,
 to_date TEXT NOT NULL, cursor TEXT NOT NULL DEFAULT '{}', processed INTEGER NOT NULL DEFAULT 0,
 total INTEGER, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,created_at);
CREATE TABLE IF NOT EXISTS ingestion_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
