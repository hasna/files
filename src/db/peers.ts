import { getDb } from "./database.js";
import { nanoid } from "nanoid";

export interface Peer {
  id: string;
  url: string;
  name: string;
  last_synced_at?: string;
  auto_sync: boolean;
  sync_interval_minutes: number;
  created_at: string;
}

interface PeerRow {
  id: string; url: string; name: string; last_synced_at: string | null;
  auto_sync: number; sync_interval_minutes: number; created_at: string;
}

function toPeer(row: PeerRow): Peer {
  return { ...row, auto_sync: row.auto_sync === 1, last_synced_at: row.last_synced_at ?? undefined };
}

export function listPeers(): Peer[] {
  return getDb().query<PeerRow, []>("SELECT * FROM peers ORDER BY created_at").all().map(toPeer);
}

export function addPeer(url: string, name = "", auto_sync = false, sync_interval_minutes = 30): Peer {
  const db = getDb();
  const existing = db.query<PeerRow, [string]>("SELECT * FROM peers WHERE url = ?").get(url);
  if (existing) return toPeer(existing);
  const id = `peer_${nanoid(8)}`;
  db.run(
    "INSERT INTO peers (id, url, name, auto_sync, sync_interval_minutes) VALUES (?, ?, ?, ?, ?)",
    [id, url, name, auto_sync ? 1 : 0, sync_interval_minutes]
  );
  return toPeer(db.query<PeerRow, [string]>("SELECT * FROM peers WHERE id = ?").get(id)!);
}

export function removePeer(id: string): boolean {
  return getDb().run("DELETE FROM peers WHERE id = ? OR url = ?", [id, id]).changes > 0;
}

export function markPeerSynced(id: string): void {
  getDb().run("UPDATE peers SET last_synced_at = datetime('now') WHERE id = ?", [id]);
}

export function getAutosyncPeers(): Peer[] {
  return getDb().query<PeerRow, []>("SELECT * FROM peers WHERE auto_sync = 1").all().map(toPeer);
}
