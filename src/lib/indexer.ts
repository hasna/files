import { readdirSync, statSync, existsSync } from "fs";
import { join, relative, extname, basename } from "path";
import { lookup as mimeLookup } from "mime-types";
import { hashFile } from "./hasher.js";
import { loadIgnorePatterns } from "./ignore.js";
import { upsertFile, markFileDeleted, getFileByPath, listFiles } from "../db/files.js";
import { markSourceIndexed } from "../db/sources.js";
import type { Source, IndexStats } from "../types/index.js";

const IGNORE_DIRS = new Set([
  "node_modules", ".git", ".DS_Store", "__pycache__", ".next",
  "dist", ".cache", ".bun", "bun.lockb",
]);

export async function indexLocalSource(source: Source, machine_id: string): Promise<IndexStats> {
  if (!source.path) throw new Error("Local source missing path");
  if (!existsSync(source.path)) throw new Error(`Path does not exist: ${source.path}`);

  const start = Date.now();
  const stats: IndexStats = { source_id: source.id, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 0 };
  const isIgnored = loadIgnorePatterns(source.path);

  // Walk and upsert
  const seenPaths = new Set<string>();
  await walkDir(source.path, source.path, source, machine_id, seenPaths, stats, isIgnored);

  // Mark deleted — files in DB that are no longer on disk
  const existing = listFiles({ source_id: source.id, status: "active", limit: 100000 });
  for (const f of existing) {
    if (!seenPaths.has(f.path)) {
      markFileDeleted(source.id, f.path);
      stats.deleted++;
    }
  }

  stats.duration_ms = Date.now() - start;
  markSourceIndexed(source.id, stats.added + stats.updated);
  return stats;
}

async function walkDir(
  rootPath: string,
  dirPath: string,
  source: Source,
  machine_id: string,
  seenPaths: Set<string>,
  stats: IndexStats,
  isIgnored: (relPath: string, isDir: boolean) => boolean
): Promise<void> {
  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    stats.errors++;
    return;
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry)) continue;
    const fullPath = join(dirPath, entry);
    const relPath = relative(rootPath, fullPath);
    let stat;
    try {
      stat = statSync(fullPath);
    } catch {
      stats.errors++;
      continue;
    }

    if (isIgnored(relPath, stat.isDirectory())) continue;

    if (stat.isDirectory()) {
      await walkDir(rootPath, fullPath, source, machine_id, seenPaths, stats, isIgnored);
    } else if (stat.isFile()) {
      seenPaths.add(relPath);

      const existing = getFileByPath(source.id, relPath);
      const mtime = stat.mtime.toISOString();
      const needsHash = !existing || existing.modified_at !== mtime;

      let hash: string | undefined;
      if (needsHash) {
        try {
          hash = hashFile(fullPath);
        } catch {
          stats.errors++;
          continue;
        }
      } else {
        hash = existing?.hash;
      }

      const ext = extname(entry).toLowerCase();
      const mime = (mimeLookup(entry) || "application/octet-stream") as string;

      const wasNew = !existing;
      upsertFile({
        source_id: source.id,
        machine_id,
        path: relPath,
        name: basename(entry),
        ext,
        size: stat.size,
        mime,
        hash,
        status: "active",
        modified_at: mtime,
      });

      if (wasNew) stats.added++;
      else stats.updated++;
    }
  }
}
