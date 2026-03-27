/**
 * Peer-to-peer sync between machines.
 *
 * Each machine runs its own SQLite DB. Sync works by:
 * 1. Fetching the remote machine's /machines/current and /files endpoint
 * 2. Upserting remote file records into local DB (tagged with remote machine_id)
 * 3. Upserting remote machine record so it appears in list_machines
 *
 * Incremental sync: uses sync_version to only fetch files changed since last sync.
 * Conflict detection: if remote file has different hash for same path, marks as 'conflict'.
 */

import { upsertMachine } from "../db/machines.js";
import { upsertFile, getFileByPath } from "../db/files.js";
import { createSource, getSource } from "../db/sources.js";
import { getDb } from "../db/database.js";
import type { Machine, FileRecord, Source } from "../types/index.js";

export interface SyncResult {
  peer: string;
  machines_synced: number;
  files_synced: number;
  conflicts: number;
  errors: string[];
}

export async function syncWithPeer(peerUrl: string): Promise<SyncResult> {
  const result: SyncResult = { peer: peerUrl, machines_synced: 0, files_synced: 0, conflicts: 0, errors: [] };
  const db = getDb();

  // 1. Fetch remote machine
  let remoteMachine: Machine;
  try {
    const resp = await fetch(`${peerUrl}/machines/current`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    remoteMachine = await resp.json() as Machine;
    upsertMachine({ ...remoteMachine, is_current: false, last_seen: new Date().toISOString() });
    result.machines_synced++;
  } catch (e) {
    result.errors.push(`Failed to fetch remote machine: ${(e as Error).message}`);
    return result;
  }

  // 2. Fetch remote sources
  let remoteSources: Source[] = [];
  try {
    const resp = await fetch(`${peerUrl}/sources?machine_id=${remoteMachine.id}`);
    if (resp.ok) remoteSources = await resp.json() as Source[];
  } catch {
    // non-fatal
  }

  for (const rs of remoteSources) {
    const existing = getSource(rs.id);
    if (!existing) {
      createSource({ ...rs, machine_id: remoteMachine.id, config: {} });
    }
  }

  // 3. Get last_sync_version for this peer
  const peerRow = db.query<{ id: string; last_sync_version: number }, [string]>(
    "SELECT id, last_sync_version FROM peers WHERE url = ?"
  ).get(peerUrl);
  const sinceVersion = peerRow?.last_sync_version ?? 0;

  // 4. Fetch remote files incrementally
  let offset = 0;
  const limit = 200;
  let maxRemoteVersion = sinceVersion;

  while (true) {
    try {
      const resp = await fetch(
        `${peerUrl}/files?machine_id=${remoteMachine.id}&limit=${limit}&offset=${offset}&since_version=${sinceVersion}`
      );
      if (!resp.ok) break;
      const files = await resp.json() as (FileRecord & { sync_version?: number })[];
      if (!files.length) break;

      for (const f of files) {
        // Conflict detection: if we have same source+path with different hash
        const local = getFileByPath(f.source_id, f.path);
        if (local && local.hash && f.hash && local.hash !== f.hash) {
          db.run("UPDATE files SET sync_status = 'conflict' WHERE id = ?", [local.id]);
          result.conflicts++;
        }

        upsertFile({ ...f });
        db.run("UPDATE files SET sync_status = 'synced' WHERE source_id = ? AND path = ? AND sync_status = 'local_only'", [f.source_id, f.path]);
        result.files_synced++;

        if (f.sync_version && f.sync_version > maxRemoteVersion) {
          maxRemoteVersion = f.sync_version;
        }
      }

      if (files.length < limit) break;
      offset += limit;
    } catch (e) {
      result.errors.push(`File sync error at offset ${offset}: ${(e as Error).message}`);
      break;
    }
  }

  // 5. Update peer's last_sync_version
  if (peerRow) {
    db.run("UPDATE peers SET last_sync_version = ?, last_synced_at = datetime('now') WHERE id = ?", [maxRemoteVersion, peerRow.id]);
  }

  return result;
}

export async function syncWithPeers(peerUrls: string[]): Promise<SyncResult[]> {
  return Promise.all(peerUrls.map(syncWithPeer));
}
