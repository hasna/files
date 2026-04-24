import { getDb } from "./database.js";
import { nanoid } from "nanoid";
import type { AgentActivity, ActionType } from "../types/index.js";
import type { SQLQueryBindings } from "bun:sqlite";

interface ActivityRow {
  id: string;
  agent_id: string;
  action: string;
  file_id: string | null;
  source_id: string | null;
  session_id: string | null;
  metadata: string;
  created_at: string;
}

function toActivity(row: ActivityRow): AgentActivity {
  return {
    ...row,
    action: row.action as ActionType,
    file_id: row.file_id ?? undefined,
    source_id: row.source_id ?? undefined,
    session_id: row.session_id ?? undefined,
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

export function logActivity(opts: {
  agent_id: string;
  action: ActionType;
  file_id?: string;
  source_id?: string;
  session_id?: string;
  metadata?: Record<string, unknown>;
}): AgentActivity {
  const db = getDb();
  const id = `act_${nanoid(10)}`;
  db.run(
    `INSERT INTO agent_activity (id, agent_id, action, file_id, source_id, session_id, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.agent_id,
      opts.action,
      opts.file_id ?? null,
      opts.source_id ?? null,
      opts.session_id ?? null,
      JSON.stringify(opts.metadata ?? {}),
    ]
  );
  return toActivity(db.query<ActivityRow, [string]>("SELECT * FROM agent_activity WHERE id = ?").get(id)!);
}

interface ActivityQueryOpts {
  after?: string;
  before?: string;
  action?: ActionType;
  limit?: number;
  offset?: number;
}

export function getFileHistory(file_id: string, opts: ActivityQueryOpts = {}): AgentActivity[] {
  const db = getDb();
  const conditions: string[] = ["file_id = ?"];
  const params: SQLQueryBindings[] = [file_id];
  applyFilters(conditions, params, opts);
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  return db
    .query<ActivityRow, SQLQueryBindings[]>(
      `SELECT * FROM agent_activity WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset)
    .map(toActivity);
}

export function getAgentActivity(agent_id: string, opts: ActivityQueryOpts = {}): AgentActivity[] {
  const db = getDb();
  const conditions: string[] = ["agent_id = ?"];
  const params: SQLQueryBindings[] = [agent_id];
  applyFilters(conditions, params, opts);
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  return db
    .query<ActivityRow, SQLQueryBindings[]>(
      `SELECT * FROM agent_activity WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset)
    .map(toActivity);
}

export function getSessionActivity(session_id: string, opts: ActivityQueryOpts = {}): AgentActivity[] {
  const db = getDb();
  const conditions: string[] = ["session_id = ?"];
  const params: SQLQueryBindings[] = [session_id];
  applyFilters(conditions, params, opts);
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  return db
    .query<ActivityRow, SQLQueryBindings[]>(
      `SELECT * FROM agent_activity WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset)
    .map(toActivity);
}

function applyFilters(conditions: string[], params: SQLQueryBindings[], opts: ActivityQueryOpts): void {
  if (opts.after) { conditions.push("created_at >= ?"); params.push(opts.after); }
  if (opts.before) { conditions.push("created_at <= ?"); params.push(opts.before); }
  if (opts.action) { conditions.push("action = ?"); params.push(opts.action); }
}
