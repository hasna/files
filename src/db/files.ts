import { getDb } from "./database.js";
import { nanoid } from "nanoid";
import { generateCanonicalName } from "../lib/normalize.js";
import type { FileRecord, FileWithTags, ListFilesOptions, FileStatus } from "../types/index.js";

interface FileRow {
  id: string;
  source_id: string;
  machine_id: string;
  path: string;
  name: string;
  original_name: string | null;
  canonical_name: string | null;
  ext: string;
  size: number;
  mime: string;
  description: string;
  hash: string | null;
  status: string;
  indexed_at: string;
  modified_at: string | null;
  created_at: string;
}

function toFile(row: FileRow): FileRecord {
  return {
    ...row,
    status: row.status as FileStatus,
    description: row.description || undefined,
    hash: row.hash ?? undefined,
    modified_at: row.modified_at ?? undefined,
    original_name: row.original_name ?? undefined,
    canonical_name: row.canonical_name ?? undefined,
  };
}

export function upsertFile(input: Omit<FileRecord, "id" | "indexed_at" | "created_at"> & { id?: string }): FileRecord {
  const db = getDb();
  const existingById = input.id
    ? db.query<FileRow, [string]>("SELECT * FROM files WHERE id = ?").get(input.id)
    : null;
  const existing = existingById ?? db.query<FileRow, [string, string]>(
    "SELECT * FROM files WHERE source_id = ? AND path = ?"
  ).get(input.source_id, input.path);

  if (existing) {
    db.run(
      `UPDATE files SET source_id=?, machine_id=?, path=?, name=?, ext=?, size=?, mime=?, hash=?, status=?, modified_at=?, indexed_at=datetime('now'), sync_version=sync_version+1
       WHERE id=?`,
      [input.source_id, input.machine_id, input.path, input.name, input.ext, input.size, input.mime, input.hash ?? null, input.status, input.modified_at ?? null, existing.id]
    );
    // Backfill canonical_name if missing
    if (!existing.canonical_name) {
      const canonical = generateCanonicalName(input.name);
      db.run("UPDATE files SET original_name=?, canonical_name=? WHERE id=?", [input.name, canonical, existing.id]);
    }
    syncFts(existing.id);
    return toFile(db.query<FileRow, [string]>("SELECT * FROM files WHERE id=?").get(existing.id)!);
  }

  const id = input.id ?? `f_${nanoid(10)}`;
  const canonical = generateCanonicalName(input.name);
  db.run(
    `INSERT INTO files (id, source_id, machine_id, path, name, original_name, canonical_name, ext, size, mime, hash, status, modified_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.source_id, input.machine_id, input.path, input.name, input.name, canonical, input.ext, input.size, input.mime, input.hash ?? null, input.status, input.modified_at ?? null]
  );
  syncFts(id);
  return toFile(db.query<FileRow, [string]>("SELECT * FROM files WHERE id=?").get(id)!);
}

function syncFts(file_id: string): void {
  const db = getDb();
  const file = db.query<FileRow, [string]>("SELECT * FROM files WHERE id=?").get(file_id);
  if (!file) return;
  const tags = db.query<{ name: string }, [string]>(
    "SELECT t.name FROM tags t JOIN file_tags ft ON ft.tag_id=t.id WHERE ft.file_id=?"
  ).all(file_id).map((r) => r.name).join(" ");
  db.run("DELETE FROM files_fts WHERE id=?", [file_id]);
  db.run(
    "INSERT INTO files_fts (id, name, path, ext, mime, tags, canonical_name, description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [file_id, file.name, file.path, file.ext, file.mime, tags, file.canonical_name ?? "", file.description ?? ""]
  );
}

export function getFile(id: string): FileWithTags | null {
  const db = getDb();
  const row = db.query<FileRow, [string]>("SELECT * FROM files WHERE id=?").get(id);
  if (!row) return null;
  const tags = db.query<{ name: string }, [string]>(
    "SELECT t.name FROM tags t JOIN file_tags ft ON ft.tag_id=t.id WHERE ft.file_id=?"
  ).all(id).map((r) => r.name);
  return { ...toFile(row), tags };
}

export function listFiles(opts: ListFilesOptions = {}): FileWithTags[] {
  const db = getDb();
  const conditions: string[] = ["f.status = 'active'"];
  const params: unknown[] = [];

  if (opts.source_id) { conditions.push("f.source_id = ?"); params.push(opts.source_id); }
  if (opts.machine_id) { conditions.push("f.machine_id = ?"); params.push(opts.machine_id); }
  if (opts.sync_status) { conditions.push("f.sync_status = ?"); params.push(opts.sync_status); }
  if (opts.ext) { conditions.push("f.ext = ?"); params.push(opts.ext.startsWith(".") ? opts.ext : `.${opts.ext}`); }
  if (opts.status) { conditions[0] = `f.status = ?`; params.unshift(opts.status); }
  if (opts.after) { conditions.push("COALESCE(f.modified_at, f.indexed_at) >= ?"); params.push(opts.after); }
  if (opts.before) { conditions.push("COALESCE(f.modified_at, f.indexed_at) <= ?"); params.push(opts.before); }
  if (opts.min_size !== undefined) { conditions.push("f.size >= ?"); params.push(opts.min_size); }
  if (opts.max_size !== undefined) { conditions.push("f.size <= ?"); params.push(opts.max_size); }

  let join = "";
  if (opts.tag) {
    join += " JOIN file_tags ft_filter ON ft_filter.file_id = f.id JOIN tags t_filter ON t_filter.id = ft_filter.tag_id AND t_filter.name = ?";
    params.push(opts.tag);
  }
  if (opts.collection_id) {
    join += " JOIN collection_files cf ON cf.file_id = f.id AND cf.collection_id = ?";
    params.push(opts.collection_id);
  }
  if (opts.project_id) {
    join += " JOIN project_files pf ON pf.file_id = f.id AND pf.project_id = ?";
    params.push(opts.project_id);
  }

  const sortCol = opts.sort === "name" ? "f.name" : opts.sort === "size" ? "f.size" : "f.indexed_at";
  const sortDir = opts.sort_dir === "asc" ? "ASC" : "DESC";
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (db.query(
    `SELECT DISTINCT f.* FROM files f ${join} ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`
  ) as any).all([...params, limit, offset]) as FileRow[];

  return rows.map((row) => {
    const tags = db.query<{ name: string }, [string]>(
      "SELECT t.name FROM tags t JOIN file_tags ft ON ft.tag_id=t.id WHERE ft.file_id=?"
    ).all(row.id).map((r) => r.name);
    return { ...toFile(row), tags };
  });
}

export function searchFiles(query: string, opts: Omit<ListFilesOptions, "query"> = {}): FileWithTags[] {
  const db = getDb();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  const ftsRows = db.query<{ id: string; rank: number }, [string, number, number]>(
    "SELECT id, rank FROM files_fts WHERE files_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?"
  ).all(query, limit, offset);

  return ftsRows
    .map((r) => getFile(r.id))
    .filter((f): f is FileWithTags => f !== null && f.status === "active");
}

export function markFileDeleted(source_id: string, path: string): boolean {
  const result = getDb().run(
    "UPDATE files SET status='deleted', indexed_at=datetime('now') WHERE source_id=? AND path=? AND status='active'",
    [source_id, path]
  );
  return result.changes > 0;
}

export function markFileDeletedById(id: string): boolean {
  const result = getDb().run(
    "UPDATE files SET status='deleted', indexed_at=datetime('now') WHERE id=? AND status='active'",
    [id]
  );
  return result.changes > 0;
}

export function deleteFile(id: string): boolean {
  const result = getDb().run("DELETE FROM files WHERE id=?", [id]);
  return result.changes > 0;
}

export function getFileByPath(source_id: string, path: string): FileRecord | null {
  const row = getDb().query<FileRow, [string, string]>(
    "SELECT * FROM files WHERE source_id=? AND path=?"
  ).get(source_id, path);
  return row ? toFile(row) : null;
}

export function annotateFile(id: string, description: string): FileRecord | null {
  const db = getDb();
  const result = db.run("UPDATE files SET description = ?, sync_version = sync_version + 1 WHERE id = ?", [description, id]);
  if (result.changes === 0) return null;
  syncFts(id);
  return toFile(db.query<FileRow, [string]>("SELECT * FROM files WHERE id=?").get(id)!);
}

export function getMaxSyncVersion(): number {
  const row = getDb().query<{ max_v: number }, []>("SELECT COALESCE(MAX(sync_version), 0) as max_v FROM files").get();
  return row?.max_v ?? 0;
}

export function getFilesSince(since_version: number, limit = 200, offset = 0): FileRecord[] {
  return getDb()
    .query<FileRow, [number, number, number]>(
      "SELECT * FROM files WHERE sync_version > ? ORDER BY sync_version ASC LIMIT ? OFFSET ?"
    )
    .all(since_version, limit, offset)
    .map(toFile);
}

export function refreshAllFts(): void {
  const db = getDb();
  db.run("DELETE FROM files_fts");
  const files = db.query<FileRow, []>("SELECT * FROM files").all();
  for (const f of files) syncFts(f.id);
}
