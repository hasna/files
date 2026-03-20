import { getDb } from "./database.js";

/**
 * Resolve a partial ID to a full ID for files, sources, collections, projects, tags, machines.
 * Matches from the start of the ID string.
 */

type EntityType = "files" | "sources" | "collections" | "projects" | "tags" | "machines";

export function resolveId(partial: string, table: EntityType): string | null {
  const db = getDb();
  // Exact match first
  const exact = db.query<{ id: string }, [string]>(`SELECT id FROM ${table} WHERE id = ?`).get(partial);
  if (exact) return exact.id;
  // Prefix match
  const matches = db.query<{ id: string }, [string]>(`SELECT id FROM ${table} WHERE id LIKE ?`).all(`${partial}%`);
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new Error(`Ambiguous ID "${partial}" matches ${matches.length} ${table}: ${matches.map((m) => m.id).join(", ")}`);
  return null;
}

export function requireId(partial: string, table: EntityType): string {
  const id = resolveId(partial, table);
  if (!id) throw new Error(`No ${table.slice(0, -1)} found matching "${partial}"`);
  return id;
}
