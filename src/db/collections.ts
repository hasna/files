import { getDb } from "./database.js";
import { nanoid } from "nanoid";
import type { Collection, AutoRules } from "../types/index.js";

interface CollectionRow {
  id: string;
  name: string;
  description: string;
  parent_id: string | null;
  auto_rules: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

function toCollection(row: CollectionRow): Collection {
  return {
    ...row,
    parent_id: row.parent_id ?? undefined,
    auto_rules: JSON.parse(row.auto_rules || "{}"),
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

export function createCollection(
  name: string,
  description = "",
  opts?: { parent_id?: string; auto_rules?: AutoRules; metadata?: Record<string, unknown> }
): Collection {
  const db = getDb();
  const id = `col_${nanoid(10)}`;
  db.run(
    "INSERT INTO collections (id, name, description, parent_id, auto_rules, metadata) VALUES (?, ?, ?, ?, ?, ?)",
    [id, name, description, opts?.parent_id ?? null, JSON.stringify(opts?.auto_rules ?? {}), JSON.stringify(opts?.metadata ?? {})]
  );
  return toCollection(db.query<CollectionRow, [string]>("SELECT * FROM collections WHERE id=?").get(id)!);
}

export function updateCollection(
  id: string,
  updates: { name?: string; description?: string; parent_id?: string | null; auto_rules?: AutoRules; metadata?: Record<string, unknown> }
): Collection | null {
  const db = getDb();
  const existing = db.query<CollectionRow, [string]>("SELECT * FROM collections WHERE id=?").get(id);
  if (!existing) return null;

  const name = updates.name ?? existing.name;
  const description = updates.description ?? existing.description;
  const parent_id = updates.parent_id !== undefined ? updates.parent_id : existing.parent_id;
  const auto_rules = updates.auto_rules !== undefined ? JSON.stringify(updates.auto_rules) : existing.auto_rules;
  const metadata = updates.metadata !== undefined ? JSON.stringify(updates.metadata) : existing.metadata;

  db.run(
    "UPDATE collections SET name=?, description=?, parent_id=?, auto_rules=?, metadata=?, updated_at=datetime('now') WHERE id=?",
    [name, description, parent_id, auto_rules, metadata, id]
  );
  return toCollection(db.query<CollectionRow, [string]>("SELECT * FROM collections WHERE id=?").get(id)!);
}

export function listCollections(parent_id?: string): Collection[] {
  const db = getDb();
  if (parent_id !== undefined) {
    return db.query<CollectionRow, [string]>(
      "SELECT * FROM collections WHERE parent_id = ? ORDER BY name"
    ).all(parent_id).map(toCollection);
  }
  return db.query<CollectionRow, []>("SELECT * FROM collections ORDER BY name").all().map(toCollection);
}

export function getCollection(id: string): (Collection & { file_count: number; children: Collection[] }) | null {
  const db = getDb();
  const row = db.query<CollectionRow, [string]>("SELECT * FROM collections WHERE id=?").get(id);
  if (!row) return null;
  const file_count = db.query<{ cnt: number }, [string]>(
    "SELECT COUNT(*) as cnt FROM collection_files WHERE collection_id=?"
  ).get(id)!.cnt;
  const children = db.query<CollectionRow, [string]>(
    "SELECT * FROM collections WHERE parent_id=? ORDER BY name"
  ).all(id).map(toCollection);
  return { ...toCollection(row), file_count, children };
}

export function deleteCollection(id: string): boolean {
  return getDb().run("DELETE FROM collections WHERE id=?", [id]).changes > 0;
}

export function addToCollection(collection_id: string, file_id: string): void {
  getDb().run("INSERT OR IGNORE INTO collection_files (collection_id, file_id) VALUES (?,?)", [collection_id, file_id]);
}

export function removeFromCollection(collection_id: string, file_id: string): boolean {
  return getDb().run("DELETE FROM collection_files WHERE collection_id=? AND file_id=?", [collection_id, file_id]).changes > 0;
}

export function autoPopulateCollection(collection_id: string): number {
  const db = getDb();
  const row = db.query<CollectionRow, [string]>("SELECT * FROM collections WHERE id=?").get(collection_id);
  if (!row) return 0;

  const rules: AutoRules = JSON.parse(row.auto_rules || "{}");
  if (!rules.ext?.length && !rules.tags?.length && !rules.name_pattern && !rules.source_id) return 0;

  const conditions: string[] = ["f.status = 'active'"];
  const params: unknown[] = [];

  if (rules.source_id) { conditions.push("f.source_id = ?"); params.push(rules.source_id); }
  if (rules.ext?.length) {
    conditions.push(`f.ext IN (${rules.ext.map(() => "?").join(",")})`);
    params.push(...rules.ext.map(e => e.startsWith(".") ? e : `.${e}`));
  }
  if (rules.name_pattern) {
    conditions.push("f.name LIKE ?");
    params.push(rules.name_pattern.replace(/\*/g, "%"));
  }

  let join = "";
  if (rules.tags?.length) {
    join = " JOIN file_tags ft ON ft.file_id = f.id JOIN tags t ON t.id = ft.tag_id";
    conditions.push(`t.name IN (${rules.tags.map(() => "?").join(",")})`);
    params.push(...rules.tags);
  }

  const files = (db.query(
    `SELECT DISTINCT f.id FROM files f ${join} WHERE ${conditions.join(" AND ")}`
  ) as any).all(params) as { id: string }[];

  let added = 0;
  for (const f of files) {
    const result = db.run(
      "INSERT OR IGNORE INTO collection_files (collection_id, file_id) VALUES (?, ?)",
      [collection_id, f.id]
    );
    if (result.changes > 0) added++;
  }
  return added;
}
