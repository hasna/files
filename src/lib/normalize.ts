import { nanoid } from "nanoid";
import { extname, basename } from "path";

/**
 * Normalize a file name to lowercase, dashes, no special chars.
 * "Final Report (2).pdf" → "final-report-2"
 * "My   File___v3--FINAL.docx" → "my-file-v3-final"
 */
export function normalizeFileName(name: string): string {
  const ext = extname(name);
  const base = basename(name, ext);

  return base
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-") // non-alphanumeric → dash
    .replace(/^-+|-+$/g, "")     // trim leading/trailing dashes
    .replace(/-{2,}/g, "-")      // collapse consecutive dashes
    .slice(0, 100)               // max 100 chars
    || "unnamed";
}

/**
 * Generate a canonical name: {nanoid8}-{normalized}.{ext}
 * "Final Report (2).pdf" → "xK9mP2qR-final-report-2.pdf"
 */
export function generateCanonicalName(originalName: string): string {
  const ext = extname(originalName).toLowerCase();
  const normalized = normalizeFileName(originalName);
  const id = nanoid(8);
  return `${id}-${normalized}${ext}`;
}
