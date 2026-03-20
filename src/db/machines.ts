import { getDb } from "./database.js";
import { nanoid } from "nanoid";
import { hostname, platform, arch } from "os";
import type { Machine } from "../types/index.js";

interface MachineRow {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  arch: string;
  is_current: number;
  last_seen: string;
  created_at: string;
}

function toMachine(row: MachineRow): Machine {
  return { ...row, is_current: row.is_current === 1 };
}

export function getCurrentMachine(): Machine {
  const db = getDb();
  const h = hostname();
  const existing = db.query<MachineRow, [string]>(
    "SELECT * FROM machines WHERE hostname = ? AND is_current = 1 LIMIT 1"
  ).get(h);
  if (existing) {
    db.run("UPDATE machines SET last_seen = datetime('now') WHERE id = ?", [existing.id]);
    return toMachine(existing);
  }
  // Register this machine
  const id = `m_${nanoid(10)}`;
  db.run(
    "UPDATE machines SET is_current = 0 WHERE is_current = 1"
  );
  db.run(
    `INSERT INTO machines (id, name, hostname, platform, arch, is_current)
     VALUES (?, ?, ?, ?, ?, 1)`,
    [id, h, h, platform(), arch()]
  );
  return toMachine(db.query<MachineRow, [string]>("SELECT * FROM machines WHERE id = ?").get(id)!);
}

export function listMachines(): Machine[] {
  return getDb().query<MachineRow, []>("SELECT * FROM machines ORDER BY last_seen DESC").all().map(toMachine);
}

export function getMachine(id: string): Machine | null {
  const row = getDb().query<MachineRow, [string]>("SELECT * FROM machines WHERE id = ?").get(id);
  return row ? toMachine(row) : null;
}

export function upsertMachine(m: Omit<Machine, "created_at">): Machine {
  const db = getDb();
  db.run(
    `INSERT INTO machines (id, name, hostname, platform, arch, is_current, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       hostname = excluded.hostname,
       platform = excluded.platform,
       arch = excluded.arch,
       last_seen = excluded.last_seen`,
    [m.id, m.name, m.hostname, m.platform, m.arch, m.is_current ? 1 : 0, m.last_seen]
  );
  return getMachine(m.id)!;
}
