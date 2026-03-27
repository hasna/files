/**
 * PostgreSQL migrations for open-files cloud sync.
 *
 * Equivalent to the SQLite schema in database.ts, translated for PostgreSQL.
 * Note: FTS5 virtual table (migration v2 in SQLite) is omitted — use PostgreSQL
 * tsvector / GIN indexes instead when full-text search is needed.
 */

export const PG_MIGRATIONS: string[] = [
  // Migration 1: machines table
  `CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    platform TEXT NOT NULL,
    arch TEXT NOT NULL,
    is_current BOOLEAN NOT NULL DEFAULT FALSE,
    last_seen TEXT NOT NULL DEFAULT NOW()::text,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 2: sources table
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('local', 's3')),
    path TEXT,
    bucket TEXT,
    prefix TEXT,
    region TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    last_indexed_at TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 3: files table
  `CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    ext TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    mime TEXT NOT NULL DEFAULT 'application/octet-stream',
    hash TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'deleted', 'moved')),
    indexed_at TEXT NOT NULL DEFAULT NOW()::text,
    modified_at TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    UNIQUE(source_id, path)
  )`,

  // Migration 4: tags table
  `CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#6366f1',
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 5: file_tags join table
  `CREATE TABLE IF NOT EXISTS file_tags (
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    PRIMARY KEY (file_id, tag_id)
  )`,

  // Migration 6: collections table
  `CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 7: collection_files join table
  `CREATE TABLE IF NOT EXISTS collection_files (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL DEFAULT NOW()::text,
    PRIMARY KEY (collection_id, file_id)
  )`,

  // Migration 8: projects table
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT NOW()::text,
    updated_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 9: project_files join table
  `CREATE TABLE IF NOT EXISTS project_files (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL DEFAULT NOW()::text,
    PRIMARY KEY (project_id, file_id)
  )`,

  // Migration 10: indexes
  `CREATE INDEX IF NOT EXISTS idx_files_source ON files(source_id)`,
  `CREATE INDEX IF NOT EXISTS idx_files_machine ON files(machine_id)`,
  `CREATE INDEX IF NOT EXISTS idx_files_ext ON files(ext)`,
  `CREATE INDEX IF NOT EXISTS idx_files_status ON files(status)`,
  `CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash)`,
  `CREATE INDEX IF NOT EXISTS idx_sources_machine ON sources(machine_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(type)`,

  // Migration 11: peers table
  `CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    last_synced_at TEXT,
    auto_sync BOOLEAN NOT NULL DEFAULT FALSE,
    sync_interval_minutes INTEGER NOT NULL DEFAULT 30,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 12: feedback table
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 13: file normalization columns
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS original_name TEXT`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS canonical_name TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_files_canonical ON files(canonical_name)`,

  // Migration 14: agents table
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    session_id TEXT,
    project_id TEXT,
    last_seen_at TEXT NOT NULL DEFAULT NOW()::text,
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,

  // Migration 15: agent_activity table
  `CREATE TABLE IF NOT EXISTS agent_activity (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
    source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
    session_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT NOW()::text
  )`,
  `CREATE INDEX IF NOT EXISTS idx_activity_agent ON agent_activity(agent_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_file ON agent_activity(file_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_action ON agent_activity(action)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_session ON agent_activity(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_activity_created ON agent_activity(created_at)`,

  // Migration 16: smart collections
  `ALTER TABLE collections ADD COLUMN IF NOT EXISTS parent_id TEXT REFERENCES collections(id)`,
  `ALTER TABLE collections ADD COLUMN IF NOT EXISTS auto_rules TEXT NOT NULL DEFAULT '{}'`,
  `ALTER TABLE collections ADD COLUMN IF NOT EXISTS metadata TEXT NOT NULL DEFAULT '{}'`,

  // Migration 17: project enhancements
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE projects ADD COLUMN IF NOT EXISTS metadata TEXT NOT NULL DEFAULT '{}'`,

  // Migration 18: sync improvements
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS sync_version INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS sync_status TEXT NOT NULL DEFAULT 'local_only'`,
  `ALTER TABLE peers ADD COLUMN IF NOT EXISTS last_sync_version INTEGER NOT NULL DEFAULT 0`,

  // Migration 19: file descriptions
  `ALTER TABLE files ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''`,
];
