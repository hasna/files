import { getDb } from "./database.js";
import { nanoid } from "nanoid";
import type { Collection } from "../types/index.js";

export function createCollection(name: string, description = ""): Collection {
  const db = getDb();
  const id = `col_${nanoid(10)}`;
  db.run("INSERT INTO collections (id, name, description) VALUES (?, ?, ?)", [id, name, description]);
  return db.query<Collection, [string]>("SELECT * FROM collections WHERE id=?").get(id)!;
}

export function listCollections(): Collection[] {
  return getDb().query<Collection, []>("SELECT * FROM collections ORDER BY name").all();
}

export function getCollection(id: string): Collection | null {
  return getDb().query<Collection, [string]>("SELECT * FROM collections WHERE id=?").get(id) ?? null;
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
