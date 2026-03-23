#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getCurrentMachine, listMachines } from "../db/machines.js";
import { createSource, listSources, getSource, deleteSource } from "../db/sources.js";
import { listFiles, getFile } from "../db/files.js";
import { searchFiles } from "../db/search.js";
import { tagFile, untagFile, listTags } from "../db/tags.js";
import { createCollection, listCollections, addToCollection, removeFromCollection } from "../db/collections.js";
import { createProject, listProjects, addToProject, removeFromProject } from "../db/projects.js";
import { indexLocalSource } from "../lib/indexer.js";
import { indexS3Source, downloadFromS3, uploadToS3, getPresignedUrl } from "../lib/s3.js";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import type { S3Config } from "../types/index.js";

const server = new McpServer({
  name: "files",
  version: "0.1.0",
});

// ─── Sources ──────────────────────────────────────────────────────────────────

server.tool("list_sources", "List all configured file sources", {
  machine_id: z.string().optional().describe("Filter by machine ID"),
}, async ({ machine_id }) => {
  const sources = listSources(machine_id);
  return { content: [{ type: "text", text: JSON.stringify(sources, null, 2) }] };
});

server.tool("add_source", "Add a local folder or S3 bucket as an indexed source", {
  type: z.enum(["local", "s3"]).describe("Source type"),
  path: z.string().optional().describe("Local folder path (required for local)"),
  bucket: z.string().optional().describe("S3 bucket name (required for s3)"),
  prefix: z.string().optional().describe("S3 key prefix"),
  region: z.string().optional().describe("AWS region"),
  name: z.string().optional().describe("Human-readable source name"),
  config: z.object({
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    sessionToken: z.string().optional(),
    endpoint: z.string().optional(),
  }).optional().describe("S3 credentials (optional — uses env/profile if omitted)"),
}, async ({ type, path, bucket, prefix, region, name, config }) => {
  const machine = getCurrentMachine();
  const source = createSource({
    type,
    path,
    bucket,
    prefix,
    region,
    name: name ?? (type === "s3" ? bucket! : path!),
    config: (config as S3Config) ?? {},
    machine_id: machine.id,
  });
  return { content: [{ type: "text", text: JSON.stringify(source, null, 2) }] };
});

server.tool("remove_source", "Remove a source and all its indexed file records", {
  id: z.string().describe("Source ID"),
}, async ({ id }) => {
  const ok = deleteSource(id);
  return { content: [{ type: "text", text: ok ? `Source ${id} removed` : `Source not found: ${id}` }] };
});

server.tool("index_source", "Re-index a source (or all sources on this machine)", {
  source_id: z.string().optional().describe("Source ID — omit to index all enabled sources"),
}, async ({ source_id }) => {
  const machine = getCurrentMachine();
  const toIndex = source_id
    ? [getSource(source_id)].filter(Boolean)
    : listSources(machine.id).filter((s) => s.enabled);

  const results = [];
  for (const source of toIndex) {
    if (!source) continue;
    try {
      const stats = source.type === "s3"
        ? await indexS3Source(source, machine.id)
        : await indexLocalSource(source, machine.id);
      results.push({ name: source.name, ...stats });
    } catch (e) {
      results.push({ source_id: source.id, name: source.name, error: (e as Error).message });
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

// ─── Files ────────────────────────────────────────────────────────────────────

server.tool("list_files", "List indexed files with optional filters", {
  source_id: z.string().optional(),
  machine_id: z.string().optional(),
  tag: z.string().optional(),
  collection_id: z.string().optional(),
  project_id: z.string().optional(),
  ext: z.string().optional().describe("File extension filter (e.g. .pdf or pdf)"),
  after: z.string().optional().describe("Modified after this date (ISO 8601, e.g. 2024-01-01)"),
  before: z.string().optional().describe("Modified before this date (ISO 8601)"),
  min_size: z.number().optional().describe("Minimum file size in bytes"),
  max_size: z.number().optional().describe("Maximum file size in bytes"),
  sort: z.enum(["name", "size", "date"]).optional().default("date"),
  sort_dir: z.enum(["asc", "desc"]).optional().default("desc"),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
}, async (opts) => {
  const files = listFiles(opts);
  return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }] };
});

server.tool("search_files", "Full-text search across file names, paths, and tags", {
  query: z.string().describe("Search query"),
  source_id: z.string().optional(),
  machine_id: z.string().optional(),
  tag: z.string().optional(),
  ext: z.string().optional(),
  limit: z.number().optional().default(20),
  offset: z.number().optional().default(0),
}, async ({ query, source_id, machine_id, tag, ext, limit, offset }) => {
  const results = searchFiles(query, { source_id, machine_id, tag, ext, limit, offset });
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

server.tool("get_file", "Get full details for a file by ID", {
  id: z.string().describe("File ID"),
}, async ({ id }) => {
  const file = getFile(id);
  if (!file) return { content: [{ type: "text", text: `File not found: ${id}` }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(file, null, 2) }] };
});

server.tool("download_file", "Download a file from S3 to a local path", {
  id: z.string().describe("File ID"),
  dest: z.string().optional().describe("Destination path (defaults to ~/Downloads/<filename>)"),
}, async ({ id, dest }) => {
  const file = getFile(id);
  if (!file) return { content: [{ type: "text", text: `File not found: ${id}` }], isError: true };
  const source = getSource(file.source_id);
  if (!source) return { content: [{ type: "text", text: "Source not found" }], isError: true };

  if (source.type === "local") {
    const fullPath = join(source.path!, file.path);
    return { content: [{ type: "text", text: `Local file: ${fullPath}` }] };
  }

  const outPath = dest ?? join(homedir(), "Downloads", file.name);
  await downloadFromS3(source, file.path, outPath);
  return { content: [{ type: "text", text: `Downloaded to: ${outPath}` }] };
});

server.tool("upload_file", "Upload a local file to an S3 source", {
  local_path: z.string().describe("Path to local file"),
  source_id: z.string().describe("Target S3 source ID"),
  s3_key: z.string().optional().describe("Custom S3 key (defaults to prefix/filename)"),
}, async ({ local_path, source_id, s3_key }) => {
  const source = getSource(source_id);
  if (!source) return { content: [{ type: "text", text: `Source not found: ${source_id}` }], isError: true };
  if (source.type !== "s3") return { content: [{ type: "text", text: "upload_file only works with S3 sources" }], isError: true };
  if (!existsSync(local_path)) return { content: [{ type: "text", text: `File not found: ${local_path}` }], isError: true };

  const machine = getCurrentMachine();
  const key = await uploadToS3(source, local_path, s3_key);
  await indexS3Source(source, machine.id);
  return { content: [{ type: "text", text: `Uploaded to s3://${source.bucket}/${key}` }] };
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

server.tool("list_tags", "List all tags", {}, async () => {
  return { content: [{ type: "text", text: JSON.stringify(listTags(), null, 2) }] };
});

server.tool("tag_file", "Add one or more tags to a file", {
  file_id: z.string(),
  tags: z.array(z.string()).describe("Tag names to add"),
}, async ({ file_id, tags }) => {
  for (const tag of tags) tagFile(file_id, tag);
  return { content: [{ type: "text", text: `Tagged file ${file_id} with: ${tags.join(", ")}` }] };
});

server.tool("untag_file", "Remove tags from a file", {
  file_id: z.string(),
  tags: z.array(z.string()),
}, async ({ file_id, tags }) => {
  for (const tag of tags) untagFile(file_id, tag);
  return { content: [{ type: "text", text: "Tags removed" }] };
});

// ─── Collections ──────────────────────────────────────────────────────────────

server.tool("list_collections", "List all collections", {}, async () => {
  return { content: [{ type: "text", text: JSON.stringify(listCollections(), null, 2) }] };
});

server.tool("create_collection", "Create a new collection", {
  name: z.string(),
  description: z.string().optional().default(""),
}, async ({ name, description }) => {
  const c = createCollection(name, description);
  return { content: [{ type: "text", text: JSON.stringify(c, null, 2) }] };
});

server.tool("add_to_collection", "Add a file to a collection", {
  collection_id: z.string(),
  file_id: z.string(),
}, async ({ collection_id, file_id }) => {
  addToCollection(collection_id, file_id);
  return { content: [{ type: "text", text: "Added to collection" }] };
});

server.tool("remove_from_collection", "Remove a file from a collection", {
  collection_id: z.string(),
  file_id: z.string(),
}, async ({ collection_id, file_id }) => {
  removeFromCollection(collection_id, file_id);
  return { content: [{ type: "text", text: "Removed from collection" }] };
});

// ─── Projects ─────────────────────────────────────────────────────────────────

server.tool("list_projects", "List all projects", {}, async () => {
  return { content: [{ type: "text", text: JSON.stringify(listProjects(), null, 2) }] };
});

server.tool("create_project", "Create a new project", {
  name: z.string(),
  description: z.string().optional().default(""),
}, async ({ name, description }) => {
  const p = createProject(name, description);
  return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
});

server.tool("add_to_project", "Add a file to a project", {
  project_id: z.string(),
  file_id: z.string(),
}, async ({ project_id, file_id }) => {
  addToProject(project_id, file_id);
  return { content: [{ type: "text", text: "Added to project" }] };
});

server.tool("remove_from_project", "Remove a file from a project", {
  project_id: z.string(),
  file_id: z.string(),
}, async ({ project_id, file_id }) => {
  removeFromProject(project_id, file_id);
  return { content: [{ type: "text", text: "Removed from project" }] };
});

// ─── Machines ─────────────────────────────────────────────────────────────────

server.tool("list_machines", "List all known machines that have indexed files", {}, async () => {
  return { content: [{ type: "text", text: JSON.stringify(listMachines(), null, 2) }] };
});

// ─── get_file_url ─────────────────────────────────────────────────────────────

server.tool("get_file_url", "Get a pre-signed URL for temporary access to an S3 file", {
  id: z.string().describe("File ID"),
  expires_in: z.number().optional().default(3600).describe("URL expiry in seconds (default 1 hour)"),
}, async ({ id, expires_in }) => {
  const file = getFile(id);
  if (!file) return { content: [{ type: "text", text: `File not found: ${id}` }], isError: true };
  const source = getSource(file.source_id);
  if (!source) return { content: [{ type: "text", text: "Source not found" }], isError: true };
  if (source.type !== "s3") return { content: [{ type: "text", text: "get_file_url only works with S3 sources" }], isError: true };
  const url = await getPresignedUrl(source, file.path, expires_in ?? 3600);
  return { content: [{ type: "text", text: url }] };
});

// ─── get_file_content ─────────────────────────────────────────────────────────

server.tool("get_file_content", "Read the content of a text file (local sources only, max 1MB)", {
  id: z.string().describe("File ID"),
  max_bytes: z.number().optional().default(102400).describe("Max bytes to read (default 100KB)"),
}, async ({ id, max_bytes }) => {
  const file = getFile(id);
  if (!file) return { content: [{ type: "text", text: `File not found: ${id}` }], isError: true };
  const source = getSource(file.source_id);
  if (!source) return { content: [{ type: "text", text: "Source not found" }], isError: true };
  if (source.type !== "local") return { content: [{ type: "text", text: "get_file_content only works with local sources" }], isError: true };

  const fullPath = join(source.path!, file.path);
  const { readFileSync } = await import("fs");
  try {
    const buf = readFileSync(fullPath);
    const slice = buf.slice(0, max_bytes ?? 102400);
    const text = slice.toString("utf8");
    const truncated = buf.length > (max_bytes ?? 102400);
    return {
      content: [{ type: "text", text: truncated ? `${text}\n\n[truncated — ${buf.length} bytes total, showing first ${max_bytes} bytes]` : text }],
    };
  } catch (e) {
    return { content: [{ type: "text", text: `Failed to read file: ${(e as Error).message}` }], isError: true };
  }
});

// ─── bulk_tag ─────────────────────────────────────────────────────────────────

server.tool("bulk_tag", "Add tags to multiple files at once (by IDs or search query)", {
  tags: z.array(z.string()).describe("Tag names to add"),
  file_ids: z.array(z.string()).optional().describe("List of file IDs to tag"),
  query: z.string().optional().describe("Search query — tag all matching files"),
  source_id: z.string().optional(),
  ext: z.string().optional(),
}, async ({ tags, file_ids, query, source_id, ext }) => {
  let ids: string[] = file_ids ?? [];
  if (query) {
    const results = searchFiles(query, { source_id, ext, limit: 500 });
    ids = [...new Set([...ids, ...results.map((f) => f.id)])];
  }
  for (const id of ids) {
    for (const tag of tags) tagFile(id, tag);
  }
  return { content: [{ type: "text", text: `Tagged ${ids.length} file(s) with: ${tags.join(", ")}` }] };
});

// ─── describe_file ────────────────────────────────────────────────────────────

server.tool("describe_file", "Get file metadata + first lines of content in one call", {
  id: z.string().describe("File ID"),
  lines: z.number().optional().default(50).describe("Number of lines to preview (default 50)"),
}, async ({ id, lines }) => {
  const file = getFile(id);
  if (!file) return { content: [{ type: "text", text: `File not found: ${id}` }], isError: true };
  const source = getSource(file.source_id);

  let preview = "";
  if (source?.type === "local") {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    try {
      const fullPath = join(source.path!, file.path);
      const content = readFileSync(fullPath, "utf8");
      preview = content.split("\n").slice(0, lines ?? 50).join("\n");
    } catch { preview = "(binary or unreadable)"; }
  } else if (source?.type === "s3") {
    preview = "(S3 file — use get_file_content or get_file_url to access)";
  }

  const result = {
    ...file,
    source_name: source?.name,
    preview,
  };
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
});

// ─── find_duplicates ──────────────────────────────────────────────────────────

server.tool("find_duplicates", "Find files with the same BLAKE3 hash (duplicates)", {
  source_id: z.string().optional().describe("Limit to a specific source"),
}, async ({ source_id }) => {
  const { getDb } = await import("../db/database.js");
  const db = getDb();
  const sourceFilter = source_id ? `AND source_id = '${source_id}'` : "";
  const groups = db.query<{ hash: string; cnt: number; paths: string }, []>(`
    SELECT hash, COUNT(*) as cnt, GROUP_CONCAT(path, ' | ') as paths
    FROM files WHERE status='active' AND hash IS NOT NULL ${sourceFilter}
    GROUP BY hash HAVING cnt > 1
    ORDER BY cnt DESC
  `).all();
  return { content: [{ type: "text", text: JSON.stringify(groups, null, 2) }] };
});

// ─── Feedback ────────────────────────────────────────────────────────────────

server.tool(
  "send_feedback",
  "Send feedback about this service",
  {
    message: z.string(),
    email: z.string().optional(),
    category: z.enum(["bug", "feature", "general"]).optional(),
  },
  async (params) => {
    try {
      const { getDb: getFeedbackDb } = await import("../db/database.js");
      const db = getFeedbackDb();
      const pkg = require("../../package.json");
      db.run("INSERT INTO feedback (message, email, category, version) VALUES (?, ?, ?, ?)", [
        params.message, params.email || null, params.category || "general", pkg.version,
      ]);
      return { content: [{ type: "text" as const, text: "Feedback saved. Thank you!" }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: String(e) }], isError: true };
    }
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

// Auto-index all local sources on startup (non-blocking)
const machine = getCurrentMachine();
const allSources = listSources(machine.id).filter((s) => s.enabled);
for (const source of allSources) {
  if (source.type === "local") {
    indexLocalSource(source, machine.id).catch(() => {});
  }
}

const transport = new StdioServerTransport();
await server.connect(transport);
