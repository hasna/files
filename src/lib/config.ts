import { readFileSync, writeFileSync, existsSync, mkdirSync, cpSync } from "fs";
import { join } from "path";
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
const CONFIG_PATH = join(DATA_DIR, "config.json");

export interface FilesConfig {
  auto_watch: boolean;
  hash_skip_bytes: number;        // skip hashing files larger than this (0 = always hash)
  default_limit: number;
  ignore_patterns: string[];      // global ignore patterns applied to all local sources
  google_drive_default_destination_source_id: string; // empty = auto-pick the first enabled S3 source
  [key: string]: unknown;
}

const DEFAULTS: FilesConfig = {
  auto_watch: false,
  hash_skip_bytes: 0,
  default_limit: 50,
  ignore_patterns: [],
  google_drive_default_destination_source_id: "",
};

export function loadConfig(): FilesConfig {
  if (!existsSync(CONFIG_PATH)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<FilesConfig>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveConfig(cfg: FilesConfig): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n");
}

export function getConfigValue(key: keyof FilesConfig): unknown {
  return loadConfig()[key];
}

export function setConfigValue(key: string, value: string): void {
  const cfg = loadConfig();
  const k = key as keyof FilesConfig;
  if (!(k in DEFAULTS)) throw new Error(`Unknown config key: ${key}`);
  const current = DEFAULTS[k];
  if (typeof current === "boolean") {
    cfg[k] = value === "true" || value === "1";
  } else if (typeof current === "number") {
    cfg[k] = Number(value);
  } else if (Array.isArray(current)) {
    cfg[k] = value.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    cfg[k] = value;
  }
  saveConfig(cfg);
}

export const CONFIG_PATH_EXPORT = CONFIG_PATH;
