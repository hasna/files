import { getDb } from "./database.js";
import { nanoid } from "nanoid";
import type { Project, ProjectStatus } from "../types/index.js";

interface ProjectRow {
  id: string;
  name: string;
  description: string;
  status: string;
  metadata: string;
  created_at: string;
  updated_at: string;
}

function toProject(row: ProjectRow): Project {
  return {
    ...row,
    status: row.status as ProjectStatus,
    metadata: JSON.parse(row.metadata || "{}"),
  };
}

export function createProject(
  name: string,
  description = "",
  opts?: { status?: ProjectStatus; metadata?: Record<string, unknown> }
): Project {
  const db = getDb();
  const id = `prj_${nanoid(10)}`;
  db.run(
    "INSERT INTO projects (id, name, description, status, metadata) VALUES (?, ?, ?, ?, ?)",
    [id, name, description, opts?.status ?? "active", JSON.stringify(opts?.metadata ?? {})]
  );
  return toProject(db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id=?").get(id)!);
}

export function updateProject(
  id: string,
  updates: { name?: string; description?: string; status?: ProjectStatus; metadata?: Record<string, unknown> }
): Project | null {
  const db = getDb();
  const existing = db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id=?").get(id);
  if (!existing) return null;

  const name = updates.name ?? existing.name;
  const description = updates.description ?? existing.description;
  const status = updates.status ?? existing.status;
  const metadata = updates.metadata !== undefined ? JSON.stringify(updates.metadata) : existing.metadata;

  db.run(
    "UPDATE projects SET name=?, description=?, status=?, metadata=?, updated_at=datetime('now') WHERE id=?",
    [name, description, status, metadata, id]
  );
  return toProject(db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id=?").get(id)!);
}

export function listProjects(status?: ProjectStatus): Project[] {
  const db = getDb();
  if (status) {
    return db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE status = ? ORDER BY name").all(status).map(toProject);
  }
  return db.query<ProjectRow, []>("SELECT * FROM projects ORDER BY name").all().map(toProject);
}

export function getProject(id: string): (Project & { file_count: number }) | null {
  const db = getDb();
  const row = db.query<ProjectRow, [string]>("SELECT * FROM projects WHERE id=?").get(id);
  if (!row) return null;
  const file_count = db.query<{ cnt: number }, [string]>(
    "SELECT COUNT(*) as cnt FROM project_files WHERE project_id=?"
  ).get(id)!.cnt;
  return { ...toProject(row), file_count };
}

export function deleteProject(id: string): boolean {
  return getDb().run("DELETE FROM projects WHERE id=?", [id]).changes > 0;
}

export function addToProject(project_id: string, file_id: string): void {
  getDb().run("INSERT OR IGNORE INTO project_files (project_id, file_id) VALUES (?,?)", [project_id, file_id]);
}

export function removeFromProject(project_id: string, file_id: string): boolean {
  return getDb().run("DELETE FROM project_files WHERE project_id=? AND file_id=?", [project_id, file_id]).changes > 0;
}
