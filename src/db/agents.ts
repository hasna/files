import { getDb } from "./database.js";
import { nanoid } from "nanoid";
import type { Agent } from "../types/index.js";

interface AgentRow {
  id: string;
  name: string;
  session_id: string | null;
  project_id: string | null;
  last_seen_at: string;
  created_at: string;
}

function toAgent(row: AgentRow): Agent {
  return {
    ...row,
    session_id: row.session_id ?? undefined,
    project_id: row.project_id ?? undefined,
  };
}

export function registerAgent(name: string, session_id?: string): Agent {
  const db = getDb();
  const existing = db.query<AgentRow, [string]>(
    "SELECT * FROM agents WHERE name = ?"
  ).get(name);

  if (existing) {
    db.run("UPDATE agents SET last_seen_at = datetime('now'), session_id = ? WHERE id = ?", [
      session_id ?? existing.session_id,
      existing.id,
    ]);
    return toAgent(db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(existing.id)!);
  }

  const id = `ag_${nanoid(8)}`;
  db.run(
    "INSERT INTO agents (id, name, session_id) VALUES (?, ?, ?)",
    [id, name, session_id ?? null]
  );
  return toAgent(db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id)!);
}

export function getAgent(id: string): Agent | null {
  const row = getDb().query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
  return row ? toAgent(row) : null;
}

export function listAgents(): Agent[] {
  return getDb()
    .query<AgentRow, []>("SELECT * FROM agents ORDER BY last_seen_at DESC")
    .all()
    .map(toAgent);
}

export function updateAgentHeartbeat(id: string): Agent | null {
  const db = getDb();
  db.run("UPDATE agents SET last_seen_at = datetime('now') WHERE id = ?", [id]);
  return getAgent(id);
}

export function setAgentFocus(id: string, project_id?: string): Agent | null {
  const db = getDb();
  db.run("UPDATE agents SET project_id = ? WHERE id = ?", [project_id ?? null, id]);
  return getAgent(id);
}
