import { getDb } from "./database.js";
import { nanoid } from "nanoid";
import type { Tag } from "../types/index.js";

export function listTags(): Tag[] {
  return getDb().query<Tag, []>("SELECT * FROM tags ORDER BY name").all();
}

export function getOrCreateTag(name: string, color?: string): Tag {
  const db = getDb();
  const existing = db.query<Tag, [string]>("SELECT * FROM tags WHERE name = ?").get(name.toLowerCase());
  if (existing) return existing;
  const id = `tag_${nanoid(8)}`;
  db.run("INSERT INTO tags (id, name, color) VALUES (?, ?, ?)", [id, name.toLowerCase(), color ?? "#6366f1"]);
  return db.query<Tag, [string]>("SELECT * FROM tags WHERE id = ?").get(id)!;
}

export function deleteTag(id: string): boolean {
  return getDb().run("DELETE FROM tags WHERE id = ?", [id]).changes > 0;
}

export function tagFile(file_id: string, tag_name: string): void {
  const tag = getOrCreateTag(tag_name);
  const db = getDb();
  db.run(
    "INSERT OR IGNORE INTO file_tags (file_id, tag_id) VALUES (?, ?)",
    [file_id, tag.id]
  );
  refreshFileFts(db, file_id);
}

export function untagFile(file_id: string, tag_name: string): boolean {
  const db = getDb();
  const tag = db.query<Tag, [string]>("SELECT * FROM tags WHERE name = ?").get(tag_name.toLowerCase());
  if (!tag) return false;
  const removed = db.run("DELETE FROM file_tags WHERE file_id=? AND tag_id=?", [file_id, tag.id]).changes > 0;
  if (removed) refreshFileFts(db, file_id);
  return removed;
}

function refreshFileFts(db: ReturnType<typeof getDb>, file_id: string): void {
  const file = db.query<{ name: string; path: string; ext: string; mime: string; canonical_name: string | null; description: string }, [string]>(
    "SELECT name, path, ext, mime, canonical_name, description FROM files WHERE id=?"
  ).get(file_id);
  if (!file) return;
  const tags = db.query<{ name: string }, [string]>(
    "SELECT t.name FROM tags t JOIN file_tags ft ON ft.tag_id=t.id WHERE ft.file_id=?"
  ).all(file_id).map((r) => r.name).join(" ");
  db.run("DELETE FROM files_fts WHERE id=?", [file_id]);
  db.run(
    "INSERT INTO files_fts (id, name, path, ext, mime, tags, canonical_name, description) VALUES (?,?,?,?,?,?,?,?)",
    [file_id, file.name, file.path, file.ext, file.mime, tags, file.canonical_name ?? "", file.description ?? ""]
  );
}

export function getFileTags(file_id: string): Tag[] {
  return getDb().query<Tag, [string]>(
    "SELECT t.* FROM tags t JOIN file_tags ft ON ft.tag_id=t.id WHERE ft.file_id=? ORDER BY t.name"
  ).all(file_id);
}
