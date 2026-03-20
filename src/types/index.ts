export type SourceType = "local" | "s3";
export type FileStatus = "active" | "deleted" | "moved";

export interface Machine {
  id: string;
  name: string;
  hostname: string;
  platform: string;
  arch: string;
  is_current: boolean;
  last_seen: string;
  created_at: string;
}

export interface S3Config {
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  endpoint?: string;
}

export interface Source {
  id: string;
  name: string;
  type: SourceType;
  path?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  config: S3Config;
  machine_id: string;
  enabled: boolean;
  last_indexed_at?: string;
  file_count: number;
  created_at: string;
  updated_at: string;
}

export interface FileRecord {
  id: string;
  source_id: string;
  machine_id: string;
  path: string;
  name: string;
  ext: string;
  size: number;
  mime: string;
  hash?: string;
  status: FileStatus;
  indexed_at: string;
  modified_at?: string;
  created_at: string;
}

export interface FileWithTags extends FileRecord {
  tags: string[];
}

export interface Tag {
  id: string;
  name: string;
  color: string;
  created_at: string;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface SearchResult extends FileWithTags {
  source_name?: string;
  machine_name?: string;
  rank?: number;
}

export interface ListFilesOptions {
  source_id?: string;
  machine_id?: string;
  tag?: string;
  collection_id?: string;
  project_id?: string;
  ext?: string;
  status?: FileStatus;
  limit?: number;
  offset?: number;
  query?: string;
  after?: string;       // ISO date string, filters on modified_at or indexed_at
  before?: string;      // ISO date string
  min_size?: number;    // bytes
  max_size?: number;    // bytes
  sort?: "name" | "size" | "date";
  sort_dir?: "asc" | "desc";
}

export interface IndexStats {
  source_id: string;
  added: number;
  updated: number;
  deleted: number;
  errors: number;
  duration_ms: number;
}
