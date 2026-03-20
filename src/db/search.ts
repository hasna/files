import { getDb } from "./database.js";
import { getFile } from "./files.js";
import type { SearchResult, ListFilesOptions } from "../types/index.js";

/**
 * Full-text search using FTS5. Falls back to LIKE if query contains no FTS operators.
 */
export function searchFiles(query: string, opts: Omit<ListFilesOptions, "query"> = {}): SearchResult[] {
  const db = getDb();
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;

  // Sanitize query for FTS5 — escape special chars if it looks like a plain string
  const ftsQuery = sanitizeFtsQuery(query);

  let ftsIds: Array<{ id: string; rank: number }>;
  try {
    ftsIds = db.query<{ id: string; rank: number }, [string, number, number]>(
      "SELECT id, rank FROM files_fts WHERE files_fts MATCH ? ORDER BY rank LIMIT ? OFFSET ?"
    ).all(ftsQuery, limit, offset);
  } catch {
    // If FTS fails (bad syntax), fall back to name LIKE
    ftsIds = db.query<{ id: string; rank: number }, [string, number, number]>(
      "SELECT id, 0 as rank FROM files WHERE name LIKE ? AND status='active' ORDER BY indexed_at DESC LIMIT ? OFFSET ?"
    ).all(`%${query}%`, limit, offset);
  }

  const results: SearchResult[] = [];
  for (const { id, rank } of ftsIds) {
    const file = getFile(id);
    if (!file || file.status !== "active") continue;

    // Apply post-FTS filters
    if (opts.source_id && file.source_id !== opts.source_id) continue;
    if (opts.machine_id && file.machine_id !== opts.machine_id) continue;
    if (opts.ext && file.ext !== normalizeExt(opts.ext)) continue;
    if (opts.tag && !file.tags.includes(opts.tag.toLowerCase())) continue;

    // Enrich with source/machine names
    const source = db.query<{ name: string }, [string]>("SELECT name FROM sources WHERE id=?").get(file.source_id);
    const machine = db.query<{ name: string }, [string]>("SELECT name FROM machines WHERE id=?").get(file.machine_id);

    results.push({
      ...file,
      rank,
      source_name: source?.name,
      machine_name: machine?.name,
    });
  }

  return results;
}

function sanitizeFtsQuery(q: string): string {
  // If already contains FTS5 operators, use as-is
  if (/[*"^()OR AND NOT]/.test(q)) return q;
  // Otherwise prefix-match on each term
  return q
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(" ");
}

function normalizeExt(ext: string): string {
  return ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
}
