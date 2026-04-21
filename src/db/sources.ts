import { getDb } from "./database.js";
import { nanoid } from "nanoid";
import type { Source, SourceType, SourceConfig } from "../types/index.js";

interface SourceRow {
  id: string;
  name: string;
  type: string;
  path: string | null;
  bucket: string | null;
  prefix: string | null;
  region: string | null;
  config: string;
  machine_id: string;
  enabled: number;
  last_indexed_at: string | null;
  file_count: number;
  created_at: string;
  updated_at: string;
}

function toSource(row: SourceRow): Source {
  return {
    ...row,
    type: row.type as SourceType,
    path: row.path ?? undefined,
    bucket: row.bucket ?? undefined,
    prefix: row.prefix ?? undefined,
    region: row.region ?? undefined,
    config: JSON.parse(row.config) as SourceConfig,
    enabled: row.enabled === 1,
    last_indexed_at: row.last_indexed_at ?? undefined,
  };
}

export function createSource(input: {
  name: string;
  type: SourceType;
  path?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  config?: SourceConfig;
  machine_id: string;
}): Source {
  const db = getDb();
  const id = `src_${nanoid(10)}`;
  db.run(
    `INSERT INTO sources (id, name, type, path, bucket, prefix, region, config, machine_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name,
      input.type,
      input.path ?? null,
      input.bucket ?? null,
      input.prefix ?? null,
      input.region ?? null,
      JSON.stringify(input.config ?? {}),
      input.machine_id,
    ]
  );
  return getSource(id)!;
}

export function getSource(id: string): Source | null {
  const row = getDb().query<SourceRow, [string]>("SELECT * FROM sources WHERE id = ?").get(id);
  return row ? toSource(row) : null;
}

export function listSources(machine_id?: string): Source[] {
  const db = getDb();
  if (machine_id) {
    return db.query<SourceRow, [string]>("SELECT * FROM sources WHERE machine_id = ? ORDER BY created_at DESC").all(machine_id).map(toSource);
  }
  return db.query<SourceRow, []>("SELECT * FROM sources ORDER BY created_at DESC").all().map(toSource);
}

export function updateSource(id: string, updates: Partial<Pick<Source, "name" | "enabled" | "config" | "prefix" | "region">>): Source | null {
  const db = getDb();
  const fields: string[] = ["updated_at = datetime('now')"];
  const values: unknown[] = [];
  if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
  if (updates.enabled !== undefined) { fields.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }
  if (updates.config !== undefined) { fields.push("config = ?"); values.push(JSON.stringify(updates.config)); }
  if (updates.prefix !== undefined) { fields.push("prefix = ?"); values.push(updates.prefix); }
  if (updates.region !== undefined) { fields.push("region = ?"); values.push(updates.region); }
  if (fields.length === 1) return getSource(id);
  db.run(`UPDATE sources SET ${fields.join(", ")} WHERE id = ?`, [...values as import("bun:sqlite").SQLQueryBindings[], id]);
  return getSource(id);
}

export function deleteSource(id: string): boolean {
  const result = getDb().run("DELETE FROM sources WHERE id = ?", [id]);
  return result.changes > 0;
}

export function markSourceIndexed(id: string, file_count: number): void {
  getDb().run(
    "UPDATE sources SET last_indexed_at = datetime('now'), file_count = ?, updated_at = datetime('now') WHERE id = ?",
    [file_count, id]
  );
}
