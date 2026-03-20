/**
 * Peer-to-peer sync between machines.
 *
 * Each machine runs its own SQLite DB. Sync works by:
 * 1. Fetching the remote machine's /machines/current and /files endpoint
 * 2. Upserting remote file records into local DB (tagged with remote machine_id)
 * 3. Upserting remote machine record so it appears in list_machines
 *
 * This gives you a merged view across all machines without a central DB.
 */

import { upsertMachine } from "../db/machines.js";
import { upsertFile } from "../db/files.js";
import { createSource, getSource } from "../db/sources.js";
import type { Machine, FileRecord, Source } from "../types/index.js";

export interface SyncResult {
  peer: string;
  machines_synced: number;
  files_synced: number;
  errors: string[];
}

export async function syncWithPeer(peerUrl: string): Promise<SyncResult> {
  const result: SyncResult = { peer: peerUrl, machines_synced: 0, files_synced: 0, errors: [] };

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

  // Ensure we have a local source record for each remote source
  for (const rs of remoteSources) {
    const existing = getSource(rs.id);
    if (!existing) {
      // Create a stub source record for the remote machine
      createSource({
        ...rs,
        machine_id: remoteMachine.id,
        config: {},
      });
    }
  }

  // 3. Fetch remote files (paginated)
  let offset = 0;
  const limit = 200;
  while (true) {
    try {
      const resp = await fetch(`${peerUrl}/files?machine_id=${remoteMachine.id}&limit=${limit}&offset=${offset}`);
      if (!resp.ok) break;
      const files = await resp.json() as FileRecord[];
      if (!files.length) break;

      for (const f of files) {
        upsertFile({ ...f });
        result.files_synced++;
      }

      if (files.length < limit) break;
      offset += limit;
    } catch (e) {
      result.errors.push(`File sync error at offset ${offset}: ${(e as Error).message}`);
      break;
    }
  }

  return result;
}

export async function syncWithPeers(peerUrls: string[]): Promise<SyncResult[]> {
  return Promise.all(peerUrls.map(syncWithPeer));
}
