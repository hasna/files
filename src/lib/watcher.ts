import chokidar, { type FSWatcher } from "chokidar";
import { extname, basename, relative } from "path";
import { statSync } from "fs";
import { lookup as mimeLookup } from "mime-types";
import { hashFile } from "./hasher.js";
import { upsertFile, markFileDeleted } from "../db/files.js";
import type { Source } from "../types/index.js";

const IGNORE_PATTERNS = [
  /node_modules/,
  /\.git/,
  /\.DS_Store/,
  /__pycache__/,
  /\.next/,
  /\/dist\//,
];

const watchers = new Map<string, FSWatcher>();

export function watchSource(source: Source, machine_id: string): void {
  if (!source.path) return;
  if (watchers.has(source.id)) return;

  const watcher = chokidar.watch(source.path, {
    ignored: IGNORE_PATTERNS,
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on("add", (fullPath) => handleAdd(fullPath, source, machine_id));
  watcher.on("change", (fullPath) => handleAdd(fullPath, source, machine_id));
  watcher.on("unlink", (fullPath) => {
    const relPath = relative(source.path!, fullPath);
    markFileDeleted(source.id, relPath);
  });

  watchers.set(source.id, watcher);
}

export function unwatchSource(source_id: string): void {
  const w = watchers.get(source_id);
  if (w) {
    w.close();
    watchers.delete(source_id);
  }
}

export function stopAllWatchers(): void {
  for (const [id] of watchers) unwatchSource(id);
}

function handleAdd(fullPath: string, source: Source, machine_id: string): void {
  try {
    const stat = statSync(fullPath);
    if (!stat.isFile()) return;
    const relPath = relative(source.path!, fullPath);
    const entry = basename(fullPath);
    const hash = hashFile(fullPath);
    upsertFile({
      source_id: source.id,
      machine_id,
      path: relPath,
      name: entry,
      ext: extname(entry).toLowerCase(),
      size: stat.size,
      mime: (mimeLookup(entry) || "application/octet-stream") as string,
      hash,
      status: "active",
      modified_at: stat.mtime.toISOString(),
    });
  } catch {
    // ignore watch errors
  }
}
