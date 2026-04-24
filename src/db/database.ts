import { Database } from "bun:sqlite";
import { join } from "path";
import { mkdirSync, existsSync, cpSync } from "fs";
import { homedir } from "os";

function resolveDataDir(): string {
  const explicit = process.env.HASNA_FILES_DATA_DIR ?? process.env.FILES_DATA_DIR;
  if (explicit) return explicit;

  const newDir = join(homedir(), ".hasna", "files");
  const oldDir = join(homedir(), ".files");

  // Auto-migrate: copy old data to new location if needed
  if (!existsSync(newDir) && existsSync(oldDir)) {
    mkdirSync(join(homedir(), ".hasna"), { recursive: true });
    cpSync(oldDir, newDir, { recursive: true });
  }

  return newDir;
}

const DATA_DIR = resolveDataDir();
mkdirSync(DATA_DIR, { recursive: true });

export const DB_PATH = process.env.HASNA_FILES_DB_PATH ?? process.env.FILES_DB_PATH ?? join(DATA_DIR, "files.db");

let _db: Database | null = null;

export function getDb(): Database {
  if (_db) return _db;
  _db = new Database(DB_PATH, { create: true });
  _db.exec("PRAGMA journal_mode=WAL");
  _db.exec("PRAGMA foreign_keys=ON");
  _db.exec("PRAGMA synchronous=NORMAL");
  migrate(_db);
  _db.exec(`CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    message TEXT NOT NULL,
    email TEXT,
    category TEXT DEFAULT 'general',
    version TEXT,
    machine_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  return _db;
}

function migrate(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db.query<{ version: number }, []>("SELECT version FROM schema_migrations").all().map((r) => r.version)
  );

  const migrations: Array<{ version: number; sql: string }> = [
    { version: 1, sql: migration_v1 },
    { version: 2, sql: migration_v2 },
    { version: 3, sql: migration_v3 },
    { version: 4, sql: migration_v4 },
    { version: 5, sql: migration_v5 },
    { version: 6, sql: migration_v6 },
    { version: 7, sql: migration_v7 },
    { version: 8, sql: migration_v8 },
    { version: 9, sql: migration_v9 },
    { version: 10, sql: migration_v10 },
  ];

  for (const m of migrations) {
    if (applied.has(m.version)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.run("INSERT INTO schema_migrations (version) VALUES (?)", [m.version]);
    })();
  }
}

// v1: core tables
const migration_v1 = `
  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT NOT NULL,
    platform TEXT NOT NULL,
    arch TEXT NOT NULL,
    is_current INTEGER NOT NULL DEFAULT 0,
    last_seen TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('local', 's3')),
    path TEXT,
    bucket TEXT,
    prefix TEXT,
    region TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_indexed_at TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS files (
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
    indexed_at TEXT NOT NULL DEFAULT (datetime('now')),
    modified_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source_id, path)
  );

  CREATE TABLE IF NOT EXISTS tags (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#6366f1',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS file_tags (
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (file_id, tag_id)
  );

  CREATE TABLE IF NOT EXISTS collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS collection_files (
    collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (collection_id, file_id)
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS project_files (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, file_id)
  );

  CREATE INDEX IF NOT EXISTS idx_files_source ON files(source_id);
  CREATE INDEX IF NOT EXISTS idx_files_machine ON files(machine_id);
  CREATE INDEX IF NOT EXISTS idx_files_ext ON files(ext);
  CREATE INDEX IF NOT EXISTS idx_files_status ON files(status);
  CREATE INDEX IF NOT EXISTS idx_files_hash ON files(hash);
  CREATE INDEX IF NOT EXISTS idx_sources_machine ON sources(machine_id);
  CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(type);
`;

// v2: FTS5 for search
const migration_v2 = `
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    id UNINDEXED,
    name,
    path,
    ext,
    mime,
    tags,
    content='',
    tokenize='unicode61'
  );
`;

// v3: peers table
const migration_v3 = `
  CREATE TABLE IF NOT EXISTS peers (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    last_synced_at TEXT,
    auto_sync INTEGER NOT NULL DEFAULT 0,
    sync_interval_minutes INTEGER NOT NULL DEFAULT 30,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

// v4: file normalization + agents + activity
const migration_v4 = `
  ALTER TABLE files ADD COLUMN original_name TEXT;
  ALTER TABLE files ADD COLUMN canonical_name TEXT;

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    session_id TEXT,
    project_id TEXT,
    last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS agent_activity (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    action TEXT NOT NULL,
    file_id TEXT REFERENCES files(id) ON DELETE SET NULL,
    source_id TEXT REFERENCES sources(id) ON DELETE SET NULL,
    session_id TEXT,
    metadata TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_activity_agent ON agent_activity(agent_id);
  CREATE INDEX IF NOT EXISTS idx_activity_file ON agent_activity(file_id);
  CREATE INDEX IF NOT EXISTS idx_activity_action ON agent_activity(action);
  CREATE INDEX IF NOT EXISTS idx_activity_session ON agent_activity(session_id);
  CREATE INDEX IF NOT EXISTS idx_activity_created ON agent_activity(created_at);
  CREATE INDEX IF NOT EXISTS idx_files_canonical ON files(canonical_name);
`;

// v5: smart collections + project enhancements
const migration_v5 = `
  ALTER TABLE collections ADD COLUMN parent_id TEXT REFERENCES collections(id);
  ALTER TABLE collections ADD COLUMN auto_rules TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE collections ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';

  ALTER TABLE projects ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE projects ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}';
`;

// v6: sync improvements
const migration_v6 = `
  ALTER TABLE files ADD COLUMN sync_version INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE files ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'local_only';
  ALTER TABLE peers ADD COLUMN last_sync_version INTEGER NOT NULL DEFAULT 0;
`;

// v7: file descriptions for search enrichment
const migration_v7 = `
  ALTER TABLE files ADD COLUMN description TEXT NOT NULL DEFAULT '';
`;

// v8: rebuild FTS5 with description + canonical_name (content-bearing so id is retrievable)
const migration_v8 = `
  DROP TABLE IF EXISTS files_fts;
  CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
    id UNINDEXED,
    name,
    path,
    ext,
    mime,
    tags,
    canonical_name,
    description,
    tokenize='unicode61'
  );
`;

// v9: google drive sources + import state
const migration_v9 = `
  PRAGMA foreign_keys=OFF;
  PRAGMA legacy_alter_table=ON;

  ALTER TABLE sources RENAME TO sources_old;

  CREATE TABLE sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('local', 's3', 'google_drive')),
    path TEXT,
    bucket TEXT,
    prefix TEXT,
    region TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_indexed_at TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT INTO sources (
    id, name, type, path, bucket, prefix, region, config, machine_id,
    enabled, last_indexed_at, file_count, created_at, updated_at
  )
  SELECT
    id, name, type, path, bucket, prefix, region, config, machine_id,
    enabled, last_indexed_at, file_count, created_at, updated_at
  FROM sources_old;

  DROP TABLE sources_old;

  CREATE INDEX IF NOT EXISTS idx_sources_machine ON sources(machine_id);
  CREATE INDEX IF NOT EXISTS idx_sources_type ON sources(type);

  CREATE TABLE IF NOT EXISTS google_drive_sync_state (
    source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
    last_synced_at TEXT,
    last_full_scan_at TEXT,
    last_error TEXT
  );

  CREATE TABLE IF NOT EXISTS google_drive_imported_objects (
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    drive_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    parent_id TEXT,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    modified_at TEXT,
    version TEXT,
    hash TEXT,
    s3_key TEXT NOT NULL,
    file_record_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    deleted INTEGER NOT NULL DEFAULT 0,
    last_imported_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (source_id, drive_id, file_id)
  );

  CREATE INDEX IF NOT EXISTS idx_google_drive_imported_objects_s3_key
    ON google_drive_imported_objects(source_id, s3_key);
  CREATE INDEX IF NOT EXISTS idx_google_drive_imported_objects_file_record
    ON google_drive_imported_objects(file_record_id);

  PRAGMA legacy_alter_table=OFF;
  PRAGMA foreign_keys=ON;
`;

// v10: destination-aware google drive imports (S3 default, local override)
const migration_v10 = `
  CREATE TABLE IF NOT EXISTS sources_old (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('local', 's3', 'google_drive')),
    path TEXT,
    bucket TEXT,
    prefix TEXT,
    region TEXT,
    config TEXT NOT NULL DEFAULT '{}',
    machine_id TEXT NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_indexed_at TEXT,
    file_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  INSERT OR REPLACE INTO sources_old (
    id, name, type, path, bucket, prefix, region, config, machine_id,
    enabled, last_indexed_at, file_count, created_at, updated_at
  )
  SELECT
    id, name, type, path, bucket, prefix, region, config, machine_id,
    enabled, last_indexed_at, file_count, created_at, updated_at
  FROM sources;

  CREATE TRIGGER IF NOT EXISTS trg_sources_old_insert
  AFTER INSERT ON sources
  BEGIN
    INSERT OR REPLACE INTO sources_old (
      id, name, type, path, bucket, prefix, region, config, machine_id,
      enabled, last_indexed_at, file_count, created_at, updated_at
    )
    VALUES (
      NEW.id, NEW.name, NEW.type, NEW.path, NEW.bucket, NEW.prefix, NEW.region, NEW.config, NEW.machine_id,
      NEW.enabled, NEW.last_indexed_at, NEW.file_count, NEW.created_at, NEW.updated_at
    );
  END;

  CREATE TRIGGER IF NOT EXISTS trg_sources_old_update
  AFTER UPDATE ON sources
  BEGIN
    UPDATE sources_old
    SET name = NEW.name,
        type = NEW.type,
        path = NEW.path,
        bucket = NEW.bucket,
        prefix = NEW.prefix,
        region = NEW.region,
        config = NEW.config,
        machine_id = NEW.machine_id,
        enabled = NEW.enabled,
        last_indexed_at = NEW.last_indexed_at,
        file_count = NEW.file_count,
        created_at = NEW.created_at,
        updated_at = NEW.updated_at
    WHERE id = NEW.id;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_sources_old_delete
  AFTER DELETE ON sources
  BEGIN
    DELETE FROM sources_old WHERE id = OLD.id;
  END;

  ALTER TABLE google_drive_imported_objects ADD COLUMN profile TEXT;
  ALTER TABLE google_drive_imported_objects ADD COLUMN storage_type TEXT NOT NULL DEFAULT 's3';
  ALTER TABLE google_drive_imported_objects ADD COLUMN storage_key TEXT;
  ALTER TABLE google_drive_imported_objects ADD COLUMN destination_source_id TEXT REFERENCES sources(id) ON DELETE SET NULL;

  UPDATE google_drive_imported_objects
  SET storage_key = s3_key
  WHERE storage_key IS NULL;

  CREATE INDEX IF NOT EXISTS idx_google_drive_imported_objects_storage
    ON google_drive_imported_objects(source_id, storage_type, storage_key);
  CREATE INDEX IF NOT EXISTS idx_google_drive_imported_objects_destination
    ON google_drive_imported_objects(destination_source_id);
`;

export function closeDb(): void {
  _db?.close();
  _db = null;
}
