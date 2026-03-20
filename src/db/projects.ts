import { getDb } from "./database.js";
import { nanoid } from "nanoid";
import type { Project } from "../types/index.js";

export function createProject(name: string, description = ""): Project {
  const db = getDb();
  const id = `prj_${nanoid(10)}`;
  db.run("INSERT INTO projects (id, name, description) VALUES (?, ?, ?)", [id, name, description]);
  return db.query<Project, [string]>("SELECT * FROM projects WHERE id=?").get(id)!;
}

export function listProjects(): Project[] {
  return getDb().query<Project, []>("SELECT * FROM projects ORDER BY name").all();
}

export function getProject(id: string): Project | null {
  return getDb().query<Project, [string]>("SELECT * FROM projects WHERE id=?").get(id) ?? null;
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
