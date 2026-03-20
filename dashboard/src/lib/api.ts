const BASE = "/api";

async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json() as Promise<T>;
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json() as Promise<T>;
}

export const api = {
  health: () => get<{ ok: boolean }>("/health"),
  machines: () => get<import("../types.js").Machine[]>("/machines"),
  sources: (machine_id?: string) => get<import("../types.js").Source[]>(`/sources${machine_id ? `?machine_id=${machine_id}` : ""}`),
  indexSource: (id: string) => post(`/sources/${id}/index`, {}),
  files: (params: Record<string, string | number>) => {
    const q = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
    return get<import("../types.js").FileRecord[]>(`/files?${q}`);
  },
  getFile: (id: string) => get<import("../types.js").FileRecord>(`/files/${id}`),
  addTag: (id: string, tags: string[]) => post(`/files/${id}/tags`, { tags }),
  removeTags: (id: string, tags: string[]) => fetch(`/api/files/${id}/tags`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tags }) }),
  tags: () => get<import("../types.js").Tag[]>("/tags"),
  collections: () => get<import("../types.js").Collection[]>("/collections"),
  projects: () => get<import("../types.js").Project[]>("/projects"),
};
