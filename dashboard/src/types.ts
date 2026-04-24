export interface Machine {
  id: string; name: string; hostname: string; platform: string; arch: string;
  is_current: boolean; last_seen: string; created_at: string;
}
export interface Source {
  id: string; name: string; type: "local" | "s3" | "google_drive"; path?: string; bucket?: string;
  prefix?: string; region?: string; config?: { profile?: string }; enabled: boolean; file_count: number;
  last_indexed_at?: string; machine_id: string; created_at: string;
}
export interface FileRecord {
  id: string; source_id: string; machine_id: string; path: string; name: string;
  ext: string; size: number; mime: string; hash?: string; status: string;
  indexed_at: string; modified_at?: string; tags: string[];
}
export interface Tag { id: string; name: string; color: string; }
export interface Collection { id: string; name: string; description: string; }
export interface Project { id: string; name: string; description: string; }
