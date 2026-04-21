import { getDb } from "./database.js";
import type { GoogleDriveImportedObject, GoogleDriveSyncState } from "../types/index.js";

interface GoogleDriveSyncStateRow {
  source_id: string;
  last_synced_at: string | null;
  last_full_scan_at: string | null;
  last_error: string | null;
}

interface GoogleDriveImportedObjectRow {
  source_id: string;
  drive_id: string;
  file_id: string;
  parent_id: string | null;
  path: string;
  name: string;
  mime: string;
  size: number;
  modified_at: string | null;
  version: string | null;
  hash: string | null;
  s3_key: string;
  file_record_id: string;
  deleted: number;
  last_imported_at: string;
}

function toSyncState(row: GoogleDriveSyncStateRow): GoogleDriveSyncState {
  return {
    source_id: row.source_id,
    last_synced_at: row.last_synced_at ?? undefined,
    last_full_scan_at: row.last_full_scan_at ?? undefined,
    last_error: row.last_error ?? undefined,
  };
}

function toImportedObject(row: GoogleDriveImportedObjectRow): GoogleDriveImportedObject {
  return {
    source_id: row.source_id,
    drive_id: row.drive_id,
    file_id: row.file_id,
    parent_id: row.parent_id ?? undefined,
    path: row.path,
    name: row.name,
    mime: row.mime,
    size: row.size,
    modified_at: row.modified_at ?? undefined,
    version: row.version ?? undefined,
    hash: row.hash ?? undefined,
    s3_key: row.s3_key,
    file_record_id: row.file_record_id,
    deleted: row.deleted === 1,
    last_imported_at: row.last_imported_at,
  };
}

export function getGoogleDriveSyncState(source_id: string): GoogleDriveSyncState | null {
  const row = getDb().query<GoogleDriveSyncStateRow, [string]>(
    "SELECT * FROM google_drive_sync_state WHERE source_id = ?"
  ).get(source_id);
  return row ? toSyncState(row) : null;
}

export function upsertGoogleDriveSyncState(input: GoogleDriveSyncState): GoogleDriveSyncState {
  getDb().run(
    `INSERT INTO google_drive_sync_state (source_id, last_synced_at, last_full_scan_at, last_error)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       last_synced_at = excluded.last_synced_at,
       last_full_scan_at = excluded.last_full_scan_at,
       last_error = excluded.last_error`,
    [
      input.source_id,
      input.last_synced_at ?? null,
      input.last_full_scan_at ?? null,
      input.last_error ?? null,
    ]
  );
  return getGoogleDriveSyncState(input.source_id)!;
}

export function markGoogleDriveSynced(source_id: string, fullScan = false): void {
  const existing = getGoogleDriveSyncState(source_id);
  upsertGoogleDriveSyncState({
    source_id,
    last_synced_at: new Date().toISOString(),
    last_full_scan_at: fullScan ? new Date().toISOString() : existing?.last_full_scan_at,
    last_error: undefined,
  });
}

export function markGoogleDriveSyncError(source_id: string, error: string): void {
  const existing = getGoogleDriveSyncState(source_id);
  upsertGoogleDriveSyncState({
    source_id,
    last_synced_at: existing?.last_synced_at,
    last_full_scan_at: existing?.last_full_scan_at,
    last_error: error,
  });
}

export function getGoogleDriveImportedObject(source_id: string, drive_id: string, file_id: string): GoogleDriveImportedObject | null {
  const row = getDb().query<GoogleDriveImportedObjectRow, [string, string, string]>(
    "SELECT * FROM google_drive_imported_objects WHERE source_id = ? AND drive_id = ? AND file_id = ?"
  ).get(source_id, drive_id, file_id);
  return row ? toImportedObject(row) : null;
}

export function listGoogleDriveImportedObjects(source_id: string): GoogleDriveImportedObject[] {
  return getDb()
    .query<GoogleDriveImportedObjectRow, [string]>(
      "SELECT * FROM google_drive_imported_objects WHERE source_id = ? ORDER BY path ASC"
    )
    .all(source_id)
    .map(toImportedObject);
}

export function upsertGoogleDriveImportedObject(input: GoogleDriveImportedObject): GoogleDriveImportedObject {
  getDb().run(
    `INSERT INTO google_drive_imported_objects (
      source_id, drive_id, file_id, parent_id, path, name, mime, size,
      modified_at, version, hash, s3_key, file_record_id, deleted, last_imported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, drive_id, file_id) DO UPDATE SET
      parent_id = excluded.parent_id,
      path = excluded.path,
      name = excluded.name,
      mime = excluded.mime,
      size = excluded.size,
      modified_at = excluded.modified_at,
      version = excluded.version,
      hash = excluded.hash,
      s3_key = excluded.s3_key,
      file_record_id = excluded.file_record_id,
      deleted = excluded.deleted,
      last_imported_at = excluded.last_imported_at`,
    [
      input.source_id,
      input.drive_id,
      input.file_id,
      input.parent_id ?? null,
      input.path,
      input.name,
      input.mime,
      input.size,
      input.modified_at ?? null,
      input.version ?? null,
      input.hash ?? null,
      input.s3_key,
      input.file_record_id,
      input.deleted ? 1 : 0,
      input.last_imported_at,
    ]
  );
  return getGoogleDriveImportedObject(input.source_id, input.drive_id, input.file_id)!;
}

export function markMissingGoogleDriveObjectsDeleted(source_id: string, seenKeys: Array<{ drive_id: string; file_id: string }>): number {
  const db = getDb();
  const seen = new Set(seenKeys.map((item) => `${item.drive_id}:${item.file_id}`));
  const rows = db.query<Pick<GoogleDriveImportedObjectRow, "drive_id" | "file_id">, [string]>(
    "SELECT drive_id, file_id FROM google_drive_imported_objects WHERE source_id = ? AND deleted = 0"
  ).all(source_id);

  let changes = 0;
  for (const row of rows) {
    if (seen.has(`${row.drive_id}:${row.file_id}`)) continue;
    const result = db.run(
      "UPDATE google_drive_imported_objects SET deleted = 1 WHERE source_id = ? AND drive_id = ? AND file_id = ? AND deleted = 0",
      [source_id, row.drive_id, row.file_id]
    );
    changes += result.changes;
  }

  return changes;
}

export function listDeletedGoogleDriveImportedObjects(source_id: string): GoogleDriveImportedObject[] {
  return getDb()
    .query<GoogleDriveImportedObjectRow, [string]>(
      "SELECT * FROM google_drive_imported_objects WHERE source_id = ? AND deleted = 1 ORDER BY path ASC"
    )
    .all(source_id)
    .map(toImportedObject);
}
