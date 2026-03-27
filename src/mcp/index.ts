#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerCloudTools } from "@hasna/cloud";
import { z } from "zod";
import { getCurrentMachine, listMachines } from "../db/machines.js";
import { createSource, listSources, getSource, deleteSource } from "../db/sources.js";
import { listFiles, getFile, annotateFile } from "../db/files.js";
import { searchFiles } from "../db/search.js";
import { tagFile, untagFile, listTags } from "../db/tags.js";
import { createCollection, updateCollection, listCollections, getCollection, addToCollection, removeFromCollection, autoPopulateCollection } from "../db/collections.js";
import { createProject, updateProject, listProjects, getProject, addToProject, removeFromProject } from "../db/projects.js";
import { indexLocalSource } from "../lib/indexer.js";
import { indexS3Source, downloadFromS3, uploadToS3, getPresignedUrl } from "../lib/s3.js";
import { registerAgent, getAgent, listAgents as listDbAgents, updateAgentHeartbeat, setAgentFocus } from "../db/agents.js";
import { logActivity, getFileHistory, getAgentActivity, getSessionActivity } from "../db/activity.js";
import { join } from "path";
import { existsSync } from "fs";
import { homedir } from "os";
import type { S3Config } from "../types/index.js";

const server = new McpServer({
  name: "files",
  version: "0.2.0",
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
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ source_id, agent_id }) => {
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
      if (agent_id) logActivity({ agent_id, action: "index", source_id: source.id, metadata: { stats } });
    } catch (e) {
      results.push({ source_id: source.id, name: source.name, error: (e as Error).message });
    }
  }
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
});

// ─── Files ────────────────────────────────────────────────────────────────────

server.tool("list_files", "List indexed files with optional filters. If agent_id is set and agent has a focused project, auto-applies project filter.", {
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
  agent_id: z.string().optional().describe("Agent ID — auto-applies focused project filter if set"),
}, async (opts) => {
  // Workspace scoping: auto-apply agent's focused project
  if (opts.agent_id && !opts.project_id) {
    const agent = getAgent(opts.agent_id);
    if (agent?.project_id) opts.project_id = agent.project_id;
  }
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
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ query, source_id, machine_id, tag, ext, limit, offset, agent_id }) => {
  const results = searchFiles(query, { source_id, machine_id, tag, ext, limit, offset });
  if (agent_id) {
    logActivity({ agent_id, action: "search", metadata: { query, results_count: results.length } });
  }
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
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ id, dest, agent_id }) => {
  const file = getFile(id);
  if (!file) return { content: [{ type: "text", text: `File not found: ${id}` }], isError: true };
  const source = getSource(file.source_id);
  if (!source) return { content: [{ type: "text", text: "Source not found" }], isError: true };

  if (source.type === "local") {
    const fullPath = join(source.path!, file.path);
    if (agent_id) logActivity({ agent_id, action: "read", file_id: id, metadata: { path: fullPath } });
    return { content: [{ type: "text", text: `Local file: ${fullPath}` }] };
  }

  const outPath = dest ?? join(homedir(), "Downloads", file.name);
  await downloadFromS3(source, file.path, outPath);
  if (agent_id) logActivity({ agent_id, action: "download", file_id: id, metadata: { dest: outPath } });
  return { content: [{ type: "text", text: `Downloaded to: ${outPath}` }] };
});

server.tool("upload_file", "Upload a local file to an S3 source", {
  local_path: z.string().describe("Path to local file"),
  source_id: z.string().describe("Target S3 source ID"),
  s3_key: z.string().optional().describe("Custom S3 key (defaults to prefix/filename)"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ local_path, source_id, s3_key, agent_id }) => {
  const source = getSource(source_id);
  if (!source) return { content: [{ type: "text", text: `Source not found: ${source_id}` }], isError: true };
  if (source.type !== "s3") return { content: [{ type: "text", text: "upload_file only works with S3 sources" }], isError: true };
  if (!existsSync(local_path)) return { content: [{ type: "text", text: `File not found: ${local_path}` }], isError: true };

  const machine = getCurrentMachine();
  const key = await uploadToS3(source, local_path, s3_key);
  await indexS3Source(source, machine.id);
  if (agent_id) logActivity({ agent_id, action: "upload", source_id, metadata: { local_path, s3_key: key } });
  return { content: [{ type: "text", text: `Uploaded to s3://${source.bucket}/${key}` }] };
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

server.tool("list_tags", "List all tags", {}, async () => {
  return { content: [{ type: "text", text: JSON.stringify(listTags(), null, 2) }] };
});

server.tool("tag_file", "Add one or more tags to a file", {
  file_id: z.string(),
  tags: z.array(z.string()).describe("Tag names to add"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ file_id, tags, agent_id }) => {
  for (const tag of tags) tagFile(file_id, tag);
  if (agent_id) logActivity({ agent_id, action: "tag", file_id, metadata: { tags } });
  return { content: [{ type: "text", text: `Tagged file ${file_id} with: ${tags.join(", ")}` }] };
});

server.tool("untag_file", "Remove tags from a file", {
  file_id: z.string(),
  tags: z.array(z.string()),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ file_id, tags, agent_id }) => {
  for (const tag of tags) untagFile(file_id, tag);
  if (agent_id) logActivity({ agent_id, action: "untag", file_id, metadata: { tags } });
  return { content: [{ type: "text", text: "Tags removed" }] };
});

// ─── Collections ──────────────────────────────────────────────────────────────

server.tool("list_collections", "List all collections", {
  parent_id: z.string().optional().describe("Filter by parent collection ID"),
}, async ({ parent_id }) => {
  return { content: [{ type: "text", text: JSON.stringify(listCollections(parent_id), null, 2) }] };
});

server.tool("create_collection", "Create a new collection (supports nesting and auto-rules)", {
  name: z.string(),
  description: z.string().optional().default(""),
  parent_id: z.string().optional().describe("Parent collection ID for nesting"),
  auto_rules: z.object({
    ext: z.array(z.string()).optional().describe("File extensions to auto-include (e.g. [\".pdf\", \".docx\"])"),
    tags: z.array(z.string()).optional().describe("Tags to auto-include"),
    name_pattern: z.string().optional().describe("Glob-like name pattern (e.g. *quarterly*)"),
    source_id: z.string().optional().describe("Limit to a specific source"),
  }).optional().describe("Smart rules to auto-populate the collection"),
}, async ({ name, description, parent_id, auto_rules }) => {
  const c = createCollection(name, description, { parent_id, auto_rules });
  return { content: [{ type: "text", text: JSON.stringify(c, null, 2) }] };
});

server.tool("update_collection", "Update a collection's name, description, parent, or rules", {
  id: z.string().describe("Collection ID"),
  name: z.string().optional(),
  description: z.string().optional(),
  parent_id: z.string().nullable().optional().describe("New parent ID or null to make top-level"),
  auto_rules: z.object({
    ext: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    name_pattern: z.string().optional(),
    source_id: z.string().optional(),
  }).optional(),
}, async ({ id, name, description, parent_id, auto_rules }) => {
  const c = updateCollection(id, { name, description, parent_id, auto_rules });
  if (!c) return { content: [{ type: "text", text: `Collection not found: ${id}` }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(c, null, 2) }] };
});

server.tool("get_collection", "Get collection details with file count and child collections", {
  id: z.string().describe("Collection ID"),
}, async ({ id }) => {
  const c = getCollection(id);
  if (!c) return { content: [{ type: "text", text: `Collection not found: ${id}` }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(c, null, 2) }] };
});

server.tool("auto_populate_collection", "Run a collection's auto-rules and add all matching files", {
  collection_id: z.string().describe("Collection ID"),
}, async ({ collection_id }) => {
  const added = autoPopulateCollection(collection_id);
  return { content: [{ type: "text", text: `Added ${added} file(s) to collection` }] };
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

server.tool("list_projects", "List all projects", {
  status: z.enum(["active", "archived", "completed"]).optional().describe("Filter by status"),
}, async ({ status }) => {
  return { content: [{ type: "text", text: JSON.stringify(listProjects(status), null, 2) }] };
});

server.tool("create_project", "Create a new project", {
  name: z.string(),
  description: z.string().optional().default(""),
  status: z.enum(["active", "archived", "completed"]).optional().default("active"),
}, async ({ name, description, status }) => {
  const p = createProject(name, description, { status });
  return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
});

server.tool("update_project", "Update a project's name, description, status, or metadata", {
  id: z.string().describe("Project ID"),
  name: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["active", "archived", "completed"]).optional(),
}, async ({ id, name, description, status }) => {
  const p = updateProject(id, { name, description, status });
  if (!p) return { content: [{ type: "text", text: `Project not found: ${id}` }], isError: true };
  return { content: [{ type: "text", text: JSON.stringify(p, null, 2) }] };
});

server.tool("get_project", "Get project details with file count", {
  id: z.string().describe("Project ID"),
}, async ({ id }) => {
  const p = getProject(id);
  if (!p) return { content: [{ type: "text", text: `Project not found: ${id}` }], isError: true };
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
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ id, max_bytes, agent_id }) => {
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
    if (agent_id) logActivity({ agent_id, action: "read", file_id: id, metadata: { bytes_read: slice.length, truncated } });
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
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ tags, file_ids, query, source_id, ext, agent_id }) => {
  let ids: string[] = file_ids ?? [];
  if (query) {
    const results = searchFiles(query, { source_id, ext, limit: 500 });
    ids = [...new Set([...ids, ...results.map((f) => f.id)])];
  }
  for (const id of ids) {
    for (const tag of tags) tagFile(id, tag);
  }
  if (agent_id) logActivity({ agent_id, action: "tag", metadata: { tags, file_count: ids.length, query } });
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

// ─── File Operations ─────────────────────────────────────────────────────────

server.tool("move_file", "Move a file to a different path within the same source", {
  file_id: z.string().describe("File ID"),
  dest_path: z.string().describe("New path within the source"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ file_id, dest_path, agent_id }) => {
  const file = getFile(file_id);
  if (!file) return { content: [{ type: "text" as const, text: `File not found: ${file_id}` }], isError: true };
  const source = getSource(file.source_id);
  if (!source) return { content: [{ type: "text" as const, text: "Source not found" }], isError: true };

  if (source.type === "local") {
    const { renameSync, mkdirSync } = await import("fs");
    const { join: jp, dirname } = await import("path");
    const oldPath = jp(source.path!, file.path);
    const newPath = jp(source.path!, dest_path);
    mkdirSync(dirname(newPath), { recursive: true });
    renameSync(oldPath, newPath);
  }
  // Update DB
  const { getDb: getMoveDb } = await import("../db/database.js");
  getMoveDb().run("UPDATE files SET path=?, status='active', sync_version=sync_version+1 WHERE id=?", [dest_path, file_id]);
  if (agent_id) logActivity({ agent_id, action: "move", file_id, metadata: { from: file.path, to: dest_path } });
  return { content: [{ type: "text" as const, text: `Moved ${file.path} → ${dest_path}` }] };
});

server.tool("copy_file", "Copy a file to another source (local→S3, S3→local, etc.)", {
  file_id: z.string().describe("File ID to copy"),
  dest_source_id: z.string().describe("Destination source ID"),
  dest_path: z.string().optional().describe("Custom destination path"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ file_id, dest_source_id, dest_path, agent_id }) => {
  const file = getFile(file_id);
  if (!file) return { content: [{ type: "text" as const, text: `File not found: ${file_id}` }], isError: true };
  const srcSource = getSource(file.source_id);
  const dstSource = getSource(dest_source_id);
  if (!srcSource || !dstSource) return { content: [{ type: "text" as const, text: "Source not found" }], isError: true };

  const finalDest = dest_path ?? file.name;
  const { join: jp } = await import("path");

  if (srcSource.type === "local" && dstSource.type === "local") {
    const { copyFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    const src = jp(srcSource.path!, file.path);
    const dst = jp(dstSource.path!, finalDest);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    const machine = getCurrentMachine();
    await indexLocalSource(dstSource, machine.id);
  } else if (srcSource.type === "local" && dstSource.type === "s3") {
    const src = jp(srcSource.path!, file.path);
    await uploadToS3(dstSource, src, finalDest);
    const machine = getCurrentMachine();
    await indexS3Source(dstSource, machine.id);
  } else if (srcSource.type === "s3" && dstSource.type === "local") {
    const { mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    const dst = jp(dstSource.path!, finalDest);
    mkdirSync(dirname(dst), { recursive: true });
    await downloadFromS3(srcSource, file.path, dst);
    const machine = getCurrentMachine();
    await indexLocalSource(dstSource, machine.id);
  }

  if (agent_id) logActivity({ agent_id, action: "copy", file_id, source_id: dest_source_id, metadata: { dest: finalDest } });
  return { content: [{ type: "text" as const, text: `Copied ${file.name} to ${dstSource.name}/${finalDest}` }] };
});

server.tool("rename_file", "Rename a file and regenerate its canonical name", {
  file_id: z.string().describe("File ID"),
  new_name: z.string().describe("New file name"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ file_id, new_name, agent_id }) => {
  const file = getFile(file_id);
  if (!file) return { content: [{ type: "text" as const, text: `File not found: ${file_id}` }], isError: true };

  const { generateCanonicalName: genCan } = await import("../lib/normalize.js");
  const { extname: en } = await import("path");
  const canonical = genCan(new_name);
  const ext = en(new_name).toLowerCase();
  const { getDb: getRenameDb } = await import("../db/database.js");
  getRenameDb().run(
    "UPDATE files SET name=?, original_name=?, canonical_name=?, ext=?, sync_version=sync_version+1 WHERE id=?",
    [new_name, new_name, canonical, ext, file_id]
  );

  if (agent_id) logActivity({ agent_id, action: "rename", file_id, metadata: { old_name: file.name, new_name } });
  return { content: [{ type: "text" as const, text: `Renamed to ${new_name} (canonical: ${canonical})` }] };
});

server.tool("delete_file", "Soft-delete a file (or hard-delete from disk/S3)", {
  file_id: z.string().describe("File ID"),
  hard_delete: z.boolean().optional().default(false).describe("true = remove from disk/S3, false = soft delete (default)"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ file_id, hard_delete, agent_id }) => {
  const file = getFile(file_id);
  if (!file) return { content: [{ type: "text" as const, text: `File not found: ${file_id}` }], isError: true };

  if (hard_delete) {
    const source = getSource(file.source_id);
    if (source?.type === "local") {
      const { unlinkSync } = await import("fs");
      const { join: jp } = await import("path");
      try { unlinkSync(jp(source.path!, file.path)); } catch {}
    } else if (source?.type === "s3") {
      const { deleteFromS3: delS3 } = await import("../lib/s3.js");
      await delS3(source, file.path);
    }
  }

  const { getDb: getDelDb } = await import("../db/database.js");
  getDelDb().run("UPDATE files SET status='deleted', sync_version=sync_version+1 WHERE id=?", [file_id]);
  if (agent_id) logActivity({ agent_id, action: "delete", file_id, metadata: { hard_delete } });
  return { content: [{ type: "text" as const, text: `${hard_delete ? "Hard" : "Soft"}-deleted ${file.name}` }] };
});

server.tool("restore_file", "Restore a soft-deleted file", {
  file_id: z.string().describe("File ID"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ file_id, agent_id }) => {
  const { getDb: getRestoreDb } = await import("../db/database.js");
  const result = getRestoreDb().run(
    "UPDATE files SET status='active', sync_version=sync_version+1 WHERE id=? AND status='deleted'", [file_id]
  );
  if (result.changes === 0) return { content: [{ type: "text" as const, text: `File not found or not deleted: ${file_id}` }], isError: true };
  if (agent_id) logActivity({ agent_id, action: "restore", file_id });
  return { content: [{ type: "text" as const, text: `Restored file ${file_id}` }] };
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

// ─── get_stats ────────────────────────────────────────────────────────────────

server.tool("get_stats", "Get aggregate statistics about all indexed files", {}, async () => {
  const { getDb: getStatsDb } = await import("../db/database.js");
  const db = getStatsDb();

  const totals = db.query<{ total_files: number; total_size: number }, []>(
    "SELECT COUNT(*) as total_files, COALESCE(SUM(size), 0) as total_size FROM files WHERE status='active'"
  ).get()!;

  const by_ext = db.query<{ ext: string; count: number }, []>(
    "SELECT ext, COUNT(*) as count FROM files WHERE status='active' GROUP BY ext ORDER BY count DESC LIMIT 20"
  ).all();

  const by_source = db.query<{ source_id: string; name: string; count: number }, []>(
    "SELECT f.source_id, s.name, COUNT(*) as count FROM files f JOIN sources s ON s.id=f.source_id WHERE f.status='active' GROUP BY f.source_id ORDER BY count DESC"
  ).all();

  const by_machine = db.query<{ machine_id: string; name: string; count: number }, []>(
    "SELECT f.machine_id, m.name, COUNT(*) as count FROM files f JOIN machines m ON m.id=f.machine_id WHERE f.status='active' GROUP BY f.machine_id ORDER BY count DESC"
  ).all();

  const by_tag = db.query<{ tag: string; count: number }, []>(
    "SELECT t.name as tag, COUNT(*) as count FROM file_tags ft JOIN tags t ON t.id=ft.tag_id GROUP BY t.name ORDER BY count DESC LIMIT 20"
  ).all();

  const total_collections = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM collections").get()!.cnt;
  const total_projects = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM projects").get()!.cnt;
  const total_agents = db.query<{ cnt: number }, []>("SELECT COUNT(*) as cnt FROM agents").get()!.cnt;

  return { content: [{ type: "text" as const, text: JSON.stringify({
    ...totals, by_ext, by_source, by_machine, by_tag, total_collections, total_projects, total_agents,
  }, null, 2) }] };
});

// ─── annotate_file ────────────────────────────────────────────────────────────

server.tool("annotate_file", "Add or update a description/annotation on a file", {
  file_id: z.string().describe("File ID"),
  description: z.string().describe("Description or annotation text"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ file_id, description, agent_id }) => {
  const file = annotateFile(file_id, description);
  if (!file) return { content: [{ type: "text" as const, text: `File not found: ${file_id}` }], isError: true };
  if (agent_id) logActivity({ agent_id, action: "annotate", file_id, metadata: { description } });
  return { content: [{ type: "text" as const, text: JSON.stringify(file, null, 2) }] };
});

// ─── normalize_source ──────────────────────────────────────────────────────────

server.tool("normalize_source", "Batch-generate canonical names for all files in a source that don't have one", {
  source_id: z.string().describe("Source ID"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ source_id, agent_id }) => {
  const { getDb: getNormDb } = await import("../db/database.js");
  const { generateCanonicalName: genCanonical } = await import("../lib/normalize.js");
  const db = getNormDb();
  const rows = db.query<{ id: string; name: string }, [string]>(
    "SELECT id, name FROM files WHERE source_id = ? AND canonical_name IS NULL AND status = 'active'"
  ).all(source_id);
  let count = 0;
  for (const row of rows) {
    const canonical = genCanonical(row.name);
    db.run("UPDATE files SET original_name = ?, canonical_name = ? WHERE id = ?", [row.name, canonical, row.id]);
    count++;
  }
  if (agent_id) logActivity({ agent_id, action: "index", source_id, metadata: { normalized: count } });
  return { content: [{ type: "text" as const, text: `Normalized ${count} file(s) in source ${source_id}` }] };
});

// ─── Import ──────────────────────────────────────────────────────────────────

server.tool("import_from_url", "Import a file from any URL (iCloud, Google Drive, Azure, Dropbox shared links, etc.)", {
  url: z.string().describe("URL to download from"),
  dest_source_id: z.string().describe("Destination source ID (local or S3)"),
  dest_path: z.string().optional().describe("Custom destination path within the source"),
  tags: z.array(z.string()).optional().describe("Tags to apply after import"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ url: fileUrl, dest_source_id, dest_path, tags: importTags, agent_id }) => {
  const source = getSource(dest_source_id);
  if (!source) return { content: [{ type: "text" as const, text: `Source not found: ${dest_source_id}` }], isError: true };

  try {
    const resp = await fetch(fileUrl);
    if (!resp.ok) return { content: [{ type: "text" as const, text: `Failed to fetch URL: HTTP ${resp.status}` }], isError: true };

    // Extract filename from Content-Disposition or URL
    const disposition = resp.headers.get("content-disposition");
    let fileName = "downloaded-file";
    if (disposition) {
      const match = disposition.match(/filename[*]?=["']?([^"';\n]+)/);
      if (match) fileName = match[1]!;
    } else {
      const urlPath = new URL(fileUrl).pathname;
      const urlName = urlPath.split("/").pop();
      if (urlName && urlName.includes(".")) fileName = decodeURIComponent(urlName);
    }

    const { writeFileSync, mkdirSync } = await import("fs");
    const { join: joinPath, dirname, basename: baseName, extname: extName } = await import("path");
    const body = Buffer.from(await resp.arrayBuffer());

    if (source.type === "local") {
      const destDir = source.path!;
      const finalPath = dest_path ? joinPath(destDir, dest_path) : joinPath(destDir, fileName);
      mkdirSync(dirname(finalPath), { recursive: true });
      writeFileSync(finalPath, body);

      const machine = getCurrentMachine();
      await indexLocalSource(source, machine.id);
    } else if (source.type === "s3") {
      // Write to temp, upload, cleanup
      const tmpPath = `/tmp/files-import-${Date.now()}-${fileName}`;
      writeFileSync(tmpPath, body);
      const key = dest_path ?? fileName;
      await uploadToS3(source, tmpPath, key);
      const { unlinkSync } = await import("fs");
      try { unlinkSync(tmpPath); } catch {}
      const machine = getCurrentMachine();
      await indexS3Source(source, machine.id);
    }

    // Apply tags if provided
    if (importTags?.length) {
      const { getFileByPath: getByPath } = await import("../db/files.js");
      const relPath = dest_path ?? fileName;
      const file = getByPath(dest_source_id, relPath);
      if (file) {
        for (const tag of importTags) tagFile(file.id, tag);
      }
    }

    if (agent_id) logActivity({ agent_id, action: "import", source_id: dest_source_id, metadata: { url: fileUrl, fileName } });
    return { content: [{ type: "text" as const, text: `Imported ${fileName} to source ${source.name}` }] };
  } catch (e) {
    return { content: [{ type: "text" as const, text: `Import failed: ${(e as Error).message}` }], isError: true };
  }
});

server.tool("import_from_local", "Import a file from any local path into a managed source", {
  path: z.string().describe("Absolute path to the file (e.g. ~/Downloads/file.pdf, iCloud Drive path, etc.)"),
  dest_source_id: z.string().describe("Destination source ID"),
  dest_path: z.string().optional().describe("Custom path within the source"),
  tags: z.array(z.string()).optional().describe("Tags to apply after import"),
  copy: z.boolean().optional().default(true).describe("true=copy (default), false=move"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ path: srcPath, dest_source_id, dest_path, tags: importTags, copy, agent_id }) => {
  const source = getSource(dest_source_id);
  if (!source) return { content: [{ type: "text" as const, text: `Source not found: ${dest_source_id}` }], isError: true };
  if (!existsSync(srcPath)) return { content: [{ type: "text" as const, text: `File not found: ${srcPath}` }], isError: true };

  const { copyFileSync, renameSync, mkdirSync: mkDir } = await import("fs");
  const { join: joinPath, dirname, basename: baseName } = await import("path");
  const fileName = baseName(srcPath);

  if (source.type === "local") {
    const finalPath = dest_path ? joinPath(source.path!, dest_path) : joinPath(source.path!, fileName);
    mkDir(dirname(finalPath), { recursive: true });
    if (copy) copyFileSync(srcPath, finalPath);
    else renameSync(srcPath, finalPath);
    const machine = getCurrentMachine();
    await indexLocalSource(source, machine.id);
  } else if (source.type === "s3") {
    const key = dest_path ?? fileName;
    await uploadToS3(source, srcPath, key);
    if (!copy) { const { unlinkSync } = await import("fs"); try { unlinkSync(srcPath); } catch {} }
    const machine = getCurrentMachine();
    await indexS3Source(source, machine.id);
  }

  if (importTags?.length) {
    const { getFileByPath: getByPath } = await import("../db/files.js");
    const relPath = dest_path ?? fileName;
    const file = getByPath(dest_source_id, relPath);
    if (file) {
      for (const tag of importTags) tagFile(file.id, tag);
    }
  }

  if (agent_id) logActivity({ agent_id, action: "import", source_id: dest_source_id, metadata: { src: srcPath, copy } });
  return { content: [{ type: "text" as const, text: `Imported ${fileName} to source ${source.name}` }] };
});

server.tool("bulk_import", "Import multiple files at once from URLs or local paths", {
  items: z.array(z.object({
    url_or_path: z.string().describe("URL or local file path"),
    tags: z.array(z.string()).optional().describe("Per-file tags"),
  })).describe("List of files to import"),
  dest_source_id: z.string().describe("Destination source ID"),
  agent_id: z.string().optional().describe("Agent ID for activity tracking"),
}, async ({ items, dest_source_id, agent_id }) => {
  let imported = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const item of items) {
    const isUrl = item.url_or_path.startsWith("http://") || item.url_or_path.startsWith("https://");
    try {
      // Use the inner logic directly to avoid MCP re-entry
      if (isUrl) {
        const resp = await fetch(item.url_or_path);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const urlPath = new URL(item.url_or_path).pathname;
        const fileName = decodeURIComponent(urlPath.split("/").pop() || "file");
        const { writeFileSync: ws } = await import("fs");
        const tmpPath = `/tmp/files-import-${Date.now()}-${fileName}`;
        ws(tmpPath, Buffer.from(await resp.arrayBuffer()));
        const source = getSource(dest_source_id)!;
        if (source.type === "s3") {
          await uploadToS3(source, tmpPath, fileName);
        } else {
          const { copyFileSync: cpf, mkdirSync: mkd } = await import("fs");
          const { join: jp } = await import("path");
          mkd(source.path!, { recursive: true });
          cpf(tmpPath, jp(source.path!, fileName));
        }
        const { unlinkSync: ul } = await import("fs"); try { ul(tmpPath); } catch {}
      } else {
        if (!existsSync(item.url_or_path)) throw new Error(`File not found: ${item.url_or_path}`);
        const source = getSource(dest_source_id)!;
        const { basename: bn } = await import("path");
        const fileName = bn(item.url_or_path);
        if (source.type === "s3") {
          await uploadToS3(source, item.url_or_path, fileName);
        } else {
          const { copyFileSync: cpf, mkdirSync: mkd } = await import("fs");
          const { join: jp } = await import("path");
          mkd(source.path!, { recursive: true });
          cpf(item.url_or_path, jp(source.path!, fileName));
        }
      }
      imported++;
    } catch (e) {
      failed++;
      errors.push(`${item.url_or_path}: ${(e as Error).message}`);
    }
  }

  // Re-index the source once after all imports
  const source = getSource(dest_source_id);
  if (source) {
    const machine = getCurrentMachine();
    if (source.type === "s3") await indexS3Source(source, machine.id);
    else await indexLocalSource(source, machine.id);
  }

  if (agent_id) logActivity({ agent_id, action: "import", source_id: dest_source_id, metadata: { imported, failed } });
  return { content: [{ type: "text" as const, text: JSON.stringify({ imported, failed, errors }, null, 2) }] };
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

// ─── Agent Tools ──────────────────────────────────────────────────────────────

server.tool("register_agent", "Register an agent session. Returns agent_id. Auto-triggers a heartbeat.", {
  name: z.string(),
  session_id: z.string().optional(),
}, async (params) => {
  const agent = registerAgent(params.name, params.session_id);
  return { content: [{ type: "text" as const, text: JSON.stringify(agent) }] };
});

server.tool("heartbeat", "Update last_seen_at to signal agent is active.", {
  agent_id: z.string(),
}, async (params) => {
  const agent = updateAgentHeartbeat(params.agent_id);
  if (!agent) return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }], isError: true };
  return { content: [{ type: "text" as const, text: JSON.stringify({ agent_id: agent.id, last_seen_at: agent.last_seen_at }) }] };
});

server.tool("set_focus", "Set active project context for this agent session.", {
  agent_id: z.string(),
  project_id: z.string().optional(),
}, async (params) => {
  const agent = setAgentFocus(params.agent_id, params.project_id);
  if (!agent) return { content: [{ type: "text" as const, text: `Agent not found: ${params.agent_id}` }], isError: true };
  return { content: [{ type: "text" as const, text: JSON.stringify({ agent_id: agent.id, project_id: agent.project_id ?? null }) }] };
});

server.tool("list_agents", "List all registered agents.", {}, async () => {
  return { content: [{ type: "text" as const, text: JSON.stringify(listDbAgents()) }] };
});

// ─── Activity ─────────────────────────────────────────────────────────────────

server.tool("get_file_history", "Get all agent activity for a file", {
  file_id: z.string().describe("File ID"),
  after: z.string().optional().describe("Filter: activity after this date (ISO 8601)"),
  before: z.string().optional().describe("Filter: activity before this date (ISO 8601)"),
  action: z.string().optional().describe("Filter by action type (upload, download, tag, etc.)"),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
}, async ({ file_id, after, before, action, limit, offset }) => {
  const history = getFileHistory(file_id, { after, before, action: action as any, limit, offset });
  return { content: [{ type: "text" as const, text: JSON.stringify(history, null, 2) }] };
});

server.tool("get_agent_activity", "Get all activity by a specific agent", {
  agent_id: z.string().describe("Agent ID"),
  after: z.string().optional().describe("Filter: activity after this date (ISO 8601)"),
  before: z.string().optional().describe("Filter: activity before this date (ISO 8601)"),
  action: z.string().optional().describe("Filter by action type"),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
}, async ({ agent_id, after, before, action, limit, offset }) => {
  const activity = getAgentActivity(agent_id, { after, before, action: action as any, limit, offset });
  return { content: [{ type: "text" as const, text: JSON.stringify(activity, null, 2) }] };
});

server.tool("get_session_activity", "Get all activity within a session", {
  session_id: z.string().describe("Session ID"),
  after: z.string().optional().describe("Filter: activity after this date (ISO 8601)"),
  before: z.string().optional().describe("Filter: activity before this date (ISO 8601)"),
  action: z.string().optional().describe("Filter by action type"),
  limit: z.number().optional().default(50),
  offset: z.number().optional().default(0),
}, async ({ session_id, after, before, action, limit, offset }) => {
  const activity = getSessionActivity(session_id, { after, before, action: action as any, limit, offset });
  return { content: [{ type: "text" as const, text: JSON.stringify(activity, null, 2) }] };
});

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
registerCloudTools(server, "files");
await server.connect(transport);
