#!/usr/bin/env bun
import { Command } from "commander";
import chalk from "chalk";
import { getCurrentMachine, listMachines } from "../db/machines.js";
import { createSource, listSources, deleteSource, getSource, updateSource } from "../db/sources.js";
import { listFiles, getFile } from "../db/files.js";
import { searchFiles } from "../db/search.js";
import { listTags, tagFile, untagFile } from "../db/tags.js";
import { createCollection, listCollections, addToCollection, deleteCollection } from "../db/collections.js";
import { createProject, listProjects, addToProject, deleteProject } from "../db/projects.js";
import { listPeers, addPeer, removePeer } from "../db/peers.js";
import { loadConfig, setConfigValue, CONFIG_PATH_EXPORT } from "../lib/config.js";
import { indexLocalSource } from "../lib/indexer.js";
import { indexS3Source, downloadFromS3, uploadToS3 } from "../lib/s3.js";
import { DB_PATH, getDb } from "../db/database.js";
import { requireId } from "../db/resolve.js";
import { resolve, join } from "path";
import { existsSync } from "fs";
import type { S3Config } from "../types/index.js";

import { createRequire } from "module";
const _require = createRequire(import.meta.url);
const _pkg = _require("../../package.json") as { version: string };

const program = new Command();

program
  .name("files")
  .description("Agent-first file management — index, search, and retrieve files across local and S3 sources")
  .version(_pkg.version);

// ─── sources ────────────────────────────────────────────────────────────────

const sources = program.command("sources").description("Manage file sources");

sources
  .command("list")
  .alias("ls")
  .description("List all configured sources")
  .action(() => {
    const machine = getCurrentMachine();
    const all = listSources();
    if (!all.length) {
      console.log(chalk.dim("No sources configured. Run: files sources add <path>"));
      return;
    }
    for (const s of all) {
      const isMine = s.machine_id === machine.id;
      const typeLabel = s.type === "s3"
        ? chalk.blue(`s3://${s.bucket}${s.prefix ? `/${s.prefix}` : ""}`)
        : chalk.green(s.path ?? "");
      const status = s.enabled ? chalk.green("enabled") : chalk.red("disabled");
      const mine = isMine ? "" : chalk.dim(` [${s.machine_id}]`);
      console.log(`${chalk.bold(s.id)}  ${chalk.cyan(s.name)}  ${typeLabel}  ${status}  ${chalk.dim(s.file_count + " files")}${mine}`);
    }
  });

sources
  .command("add <path-or-s3>")
  .description("Add a local folder or S3 bucket as a source")
  .option("-n, --name <name>", "Source name (defaults to path/bucket)")
  .option("--region <region>", "AWS region (for S3)")
  .option("--prefix <prefix>", "S3 key prefix (for S3)")
  .option("--access-key <key>", "AWS access key ID (for S3)")
  .option("--secret-key <secret>", "AWS secret access key (for S3)")
  .option("--endpoint <url>", "Custom S3 endpoint (for S3-compatible storage)")
  .action((pathOrS3: string, opts: {
    name?: string;
    region?: string;
    prefix?: string;
    accessKey?: string;
    secretKey?: string;
    endpoint?: string;
  }) => {
    const machine = getCurrentMachine();

    if (pathOrS3.startsWith("s3://")) {
      const url = new URL(pathOrS3);
      const bucket = url.hostname;
      const prefix = opts.prefix ?? (url.pathname.replace(/^\//, "") || undefined);
      const config: S3Config = {};
      if (opts.accessKey) config.accessKeyId = opts.accessKey;
      if (opts.secretKey) config.secretAccessKey = opts.secretKey;
      if (opts.endpoint) config.endpoint = opts.endpoint;

      const source = createSource({
        name: opts.name ?? bucket,
        type: "s3",
        bucket,
        prefix,
        region: opts.region ?? "us-east-1",
        config,
        machine_id: machine.id,
      });
      console.log(chalk.green(`✓ S3 source added: ${source.id} → s3://${bucket}${prefix ? `/${prefix}` : ""}`));
    } else {
      const absPath = resolve(pathOrS3);
      if (!existsSync(absPath)) {
        console.error(chalk.red(`Path does not exist: ${absPath}`));
        process.exit(1);
      }
      const source = createSource({
        name: opts.name ?? absPath,
        type: "local",
        path: absPath,
        config: {},
        machine_id: machine.id,
      });
      console.log(chalk.green(`✓ Local source added: ${source.id} → ${absPath}`));
    }
  });

sources
  .command("rename <id> <name>")
  .description("Rename a source")
  .action((id: string, name: string) => {
    try {
      const resolvedId = requireId(id, "sources");
      updateSource(resolvedId, { name });
      console.log(chalk.green(`✓ Source renamed to "${name}"`));
    } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
  });

sources
  .command("enable <id>")
  .description("Enable a source")
  .action((id: string) => {
    try { updateSource(requireId(id, "sources"), { enabled: true }); console.log(chalk.green("✓ Source enabled")); }
    catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
  });

sources
  .command("disable <id>")
  .description("Disable a source (skipped during index)")
  .action((id: string) => {
    try { updateSource(requireId(id, "sources"), { enabled: false }); console.log(chalk.green("✓ Source disabled")); }
    catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
  });

sources
  .command("remove <id>")
  .description("Remove a source (and all its indexed files)")
  .action((id: string) => {
    try {
      const resolvedId = requireId(id, "sources");
      deleteSource(resolvedId);
      console.log(chalk.green(`✓ Source ${resolvedId} removed`));
    } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
  });

// ─── index ──────────────────────────────────────────────────────────────────

program
  .command("index [source-id]")
  .description("Index all sources (or a specific one)")
  .action(async (sourceId?: string) => {
    const machine = getCurrentMachine();
    let resolvedSourceId = sourceId;
    if (sourceId) {
      try { resolvedSourceId = requireId(sourceId, "sources"); }
      catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
    }
    const toIndex = resolvedSourceId
      ? [getSource(resolvedSourceId)].filter(Boolean)
      : listSources(machine.id).filter((s) => s.enabled);

    if (!toIndex.length) {
      console.log(chalk.dim("No sources to index."));
      return;
    }

    for (const source of toIndex) {
      if (!source) continue;
      console.log(chalk.dim(`Indexing ${source.name}...`));
      try {
        const stats = source.type === "s3"
          ? await indexS3Source(source, machine.id)
          : await indexLocalSource(source, machine.id);
        console.log(
          chalk.green(`✓ ${source.name}`) +
          chalk.dim(` +${stats.added} ~${stats.updated} -${stats.deleted} errors:${stats.errors} (${stats.duration_ms}ms)`)
        );
      } catch (e) {
        console.error(chalk.red(`✗ ${source.name}: ${(e as Error).message}`));
      }
    }
  });

// ─── machines ───────────────────────────────────────────────────────────────

program
  .command("machines")
  .description("List known machines")
  .action(() => {
    const machines = listMachines();
    for (const m of machines) {
      const current = m.is_current ? chalk.green(" (this machine)") : "";
      console.log(`${chalk.bold(m.id)}  ${chalk.cyan(m.hostname)}  ${m.platform}/${m.arch}  ${chalk.dim(m.last_seen)}${current}`);
    }
  });

// ─── search ─────────────────────────────────────────────────────────────────

program
  .command("search <query>")
  .description("Search files by name, path, or tags")
  .option("-s, --source <id>", "Filter by source ID")
  .option("-m, --machine <id>", "Filter by machine ID")
  .option("-t, --tag <tag>", "Filter by tag")
  .option("-e, --ext <ext>", "Filter by extension")
  .option("-l, --limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .action((query: string, opts: { source?: string; machine?: string; tag?: string; ext?: string; limit: string; json?: boolean }) => {
    const results = searchFiles(query, {
      source_id: opts.source,
      machine_id: opts.machine,
      tag: opts.tag,
      ext: opts.ext,
      limit: parseInt(opts.limit, 10),
    });
    if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
    if (!results.length) { console.log(chalk.dim("No results.")); return; }
    for (const f of results) {
      const tags = f.tags.length ? chalk.yellow(` [${f.tags.join(", ")}]`) : "";
      const src = f.source_name ? chalk.dim(` (${f.source_name})`) : "";
      console.log(`${chalk.bold(f.id)}  ${chalk.cyan(f.name)}  ${chalk.dim(f.path)}${tags}${src}`);
    }
    console.log(chalk.dim(`\n${results.length} result(s)`));
  });

// ─── list ───────────────────────────────────────────────────────────────────

program
  .command("list")
  .alias("ls")
  .description("List files")
  .option("-s, --source <id>", "Filter by source ID")
  .option("-m, --machine <id>", "Filter by machine ID")
  .option("-t, --tag <tag>", "Filter by tag")
  .option("-e, --ext <ext>", "Filter by extension")
  .option("-c, --collection <id>", "Filter by collection ID")
  .option("-p, --project <id>", "Filter by project ID")
  .option("-l, --limit <n>", "Max results", "50")
  .option("--offset <n>", "Offset", "0")
  .option("--after <date>", "Modified after date (YYYY-MM-DD)")
  .option("--before <date>", "Modified before date (YYYY-MM-DD)")
  .option("--min-size <size>", "Minimum size (e.g. 1mb, 500kb, 1024)")
  .option("--max-size <size>", "Maximum size (e.g. 100mb)")
  .option("--sort <field>", "Sort by: name, size, date (default: date)")
  .option("--asc", "Sort ascending (default: descending)")
  .option("--json", "Output as JSON")
  .action((opts: {
    source?: string; machine?: string; tag?: string; ext?: string;
    collection?: string; project?: string; limit: string; offset: string;
    after?: string; before?: string; minSize?: string; maxSize?: string;
    sort?: string; asc?: boolean; json?: boolean;
  }) => {
    const files = listFiles({
      source_id: opts.source,
      machine_id: opts.machine,
      tag: opts.tag,
      ext: opts.ext,
      collection_id: opts.collection,
      project_id: opts.project,
      limit: parseInt(opts.limit, 10),
      offset: parseInt(opts.offset, 10),
      after: opts.after,
      before: opts.before,
      min_size: opts.minSize ? parseSize(opts.minSize) : undefined,
      max_size: opts.maxSize ? parseSize(opts.maxSize) : undefined,
      sort: (opts.sort as "name" | "size" | "date") ?? "date",
      sort_dir: opts.asc ? "asc" : "desc",
    });
    if (opts.json) { console.log(JSON.stringify(files, null, 2)); return; }
    if (!files.length) { console.log(chalk.dim("No files found.")); return; }
    for (const f of files) {
      const tags = f.tags.length ? chalk.yellow(` [${f.tags.join(", ")}]`) : "";
      console.log(`${chalk.bold(f.id)}  ${chalk.cyan(f.name)}  ${chalk.dim(formatSize(f.size))}  ${chalk.dim(f.path)}${tags}`);
    }
    console.log(chalk.dim(`\n${files.length} file(s)`));
  });

// ─── tag ────────────────────────────────────────────────────────────────────

program
  .command("tag <file-id> <tags...>")
  .description("Add tags to a file")
  .action((fileId: string, tags: string[]) => {
    try {
      const id = requireId(fileId, "files");
      const file = getFile(id)!;
      for (const tag of tags) tagFile(id, tag);
      console.log(chalk.green(`✓ Tagged ${file.name} with: ${tags.join(", ")}`));
    } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
  });

program
  .command("untag <file-id> <tags...>")
  .description("Remove tags from a file")
  .action((fileId: string, tags: string[]) => {
    try {
      const id = requireId(fileId, "files");
      for (const tag of tags) untagFile(id, tag);
      console.log(chalk.green(`✓ Tags removed`));
    } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
  });

program
  .command("tags")
  .description("List all tags")
  .action(() => {
    const tags = listTags();
    if (!tags.length) { console.log(chalk.dim("No tags yet.")); return; }
    for (const t of tags) console.log(`${chalk.bold(t.id)}  ${chalk.hex(t.color)(t.name)}`);
  });

// ─── download ───────────────────────────────────────────────────────────────

program
  .command("download <file-id> [dest]")
  .description("Download a file to local disk")
  .action(async (fileId: string, dest?: string) => {
    let file; try { file = getFile(requireId(fileId, "files"))!; } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
    const source = getSource(file.source_id);
    if (!source) { console.error(chalk.red("Source not found")); process.exit(1); }

    if (source.type === "local") {
      const fullPath = join(source.path!, file.path);
      console.log(chalk.dim(`Local file at: ${fullPath}`));
      return;
    }

    const outPath = dest ?? file.name;
    console.log(chalk.dim(`Downloading ${file.name}...`));
    await downloadFromS3(source, file.path, outPath);
    console.log(chalk.green(`✓ Downloaded to ${outPath}`));
  });

// ─── upload ──────────────────────────────────────────────────────────────────

program
  .command("upload <local-path> <source-id> [s3-key]")
  .description("Upload a local file to an S3 source")
  .action(async (localPath: string, sourceId: string, s3Key?: string) => {
    let source; try { source = getSource(requireId(sourceId, "sources"))!; } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
    if (source.type !== "s3") { console.error(chalk.red("upload only works with S3 sources")); process.exit(1); }
    if (!existsSync(localPath)) { console.error(chalk.red(`File not found: ${localPath}`)); process.exit(1); }
    console.log(chalk.dim(`Uploading ${localPath}...`));
    const machine = getCurrentMachine();
    const key = await uploadToS3(source, localPath, s3Key);
    console.log(chalk.green(`✓ Uploaded to s3://${source.bucket}/${key}`));
    // Re-index source to register the new file
    await indexS3Source(source, machine.id);
  });

// ─── collections / projects ──────────────────────────────────────────────────

const cols = program.command("collections").description("Manage collections");
cols.command("list").action(() => {
  for (const c of listCollections()) console.log(`${chalk.bold(c.id)}  ${chalk.cyan(c.name)}  ${chalk.dim(c.description)}`);
});
cols.command("create <name> [description]").action((name: string, desc?: string) => {
  const c = createCollection(name, desc);
  console.log(chalk.green(`✓ Collection created: ${c.id}`));
});
cols.command("remove <id>").description("Delete a collection").action((id: string) => {
  try {
    const ok = deleteCollection(requireId(id, "collections"));
    console.log(ok ? chalk.green("✓ Collection removed") : chalk.red("Collection not found"));
  } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
});
cols.command("add <collection-id> <file-id>").action((colId: string, fileId: string) => {
  try {
    addToCollection(requireId(colId, "collections"), requireId(fileId, "files"));
    console.log(chalk.green("✓ Added to collection"));
  } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
});

const projs = program.command("projects").description("Manage projects");
projs.command("list").action(() => {
  for (const p of listProjects()) console.log(`${chalk.bold(p.id)}  ${chalk.cyan(p.name)}  ${chalk.dim(p.description)}`);
});
projs.command("create <name> [description]").action((name: string, desc?: string) => {
  const p = createProject(name, desc);
  console.log(chalk.green(`✓ Project created: ${p.id}`));
});
projs.command("remove <id>").description("Delete a project").action((id: string) => {
  try {
    const ok = deleteProject(requireId(id, "projects"));
    console.log(ok ? chalk.green("✓ Project removed") : chalk.red("Project not found"));
  } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
});
projs.command("add <project-id> <file-id>").action((projId: string, fileId: string) => {
  try {
    addToProject(requireId(projId, "projects"), requireId(fileId, "files"));
    console.log(chalk.green("✓ Added to project"));
  } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
});

// ─── info ────────────────────────────────────────────────────────────────────

program
  .command("info <file-id>")
  .description("Show file details")
  .action((fileId: string) => {
    let file; try { file = getFile(requireId(fileId, "files"))!; } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
    console.log(`${chalk.bold("ID:")}        ${file.id}`);
    console.log(`${chalk.bold("Name:")}      ${file.name}`);
    console.log(`${chalk.bold("Path:")}      ${file.path}`);
    console.log(`${chalk.bold("Size:")}      ${formatSize(file.size)}`);
    console.log(`${chalk.bold("MIME:")}      ${file.mime}`);
    console.log(`${chalk.bold("Hash:")}      ${file.hash ?? "-"}`);
    console.log(`${chalk.bold("Tags:")}      ${file.tags.join(", ") || "-"}`);
    console.log(`${chalk.bold("Indexed:")}   ${file.indexed_at}`);
    console.log(`${chalk.bold("Modified:")}  ${file.modified_at ?? "-"}`);
    console.log(`${chalk.bold("Source:")}    ${file.source_id}`);
    console.log(`${chalk.bold("Machine:")}   ${file.machine_id}`);
  });

program
  .command("stats")
  .description("Show storage statistics")
  .action(() => {
    const db = getDb();
    const totalFiles = (db.query<{ n: number }, []>("SELECT COUNT(*) as n FROM files WHERE status='active'").get())!.n;
    const totalSize = (db.query<{ s: number }, []>("SELECT COALESCE(SUM(size),0) as s FROM files WHERE status='active'").get())!.s;

    console.log(chalk.bold("\n  Files Overview"));
    console.log(`  ${chalk.cyan(totalFiles.toLocaleString())} files  ${chalk.cyan(formatSize(totalSize))} total\n`);

    const bySrc = db.query<{ name: string; cnt: number; sz: number }, []>(`
      SELECT s.name, COUNT(f.id) as cnt, COALESCE(SUM(f.size),0) as sz
      FROM sources s LEFT JOIN files f ON f.source_id=s.id AND f.status='active'
      GROUP BY s.id ORDER BY sz DESC
    `).all();
    if (bySrc.length) {
      console.log(chalk.bold("  By Source"));
      for (const r of bySrc) console.log(`  ${chalk.cyan(r.name.padEnd(30))} ${String(r.cnt).padStart(7)} files  ${formatSize(r.sz).padStart(9)}`);
      console.log();
    }

    const byExt = db.query<{ ext: string; cnt: number; sz: number }, []>(`
      SELECT ext, COUNT(*) as cnt, COALESCE(SUM(size),0) as sz
      FROM files WHERE status='active' AND ext != ''
      GROUP BY ext ORDER BY cnt DESC LIMIT 15
    `).all();
    if (byExt.length) {
      console.log(chalk.bold("  Top Extensions"));
      for (const r of byExt) console.log(`  ${chalk.yellow((r.ext || "(none)").padEnd(12))} ${String(r.cnt).padStart(7)} files  ${formatSize(r.sz).padStart(9)}`);
      console.log();
    }

    const byMachine = db.query<{ hostname: string; cnt: number; sz: number }, []>(`
      SELECT m.hostname, COUNT(f.id) as cnt, COALESCE(SUM(f.size),0) as sz
      FROM machines m LEFT JOIN files f ON f.machine_id=m.id AND f.status='active'
      GROUP BY m.id ORDER BY cnt DESC
    `).all();
    if (byMachine.length) {
      console.log(chalk.bold("  By Machine"));
      for (const r of byMachine) console.log(`  ${chalk.magenta(r.hostname.padEnd(30))} ${String(r.cnt).padStart(7)} files  ${formatSize(r.sz).padStart(9)}`);
      console.log();
    }
  });

program
  .command("dupes")
  .description("Find duplicate files (same BLAKE3 hash, different paths)")
  .option("-s, --source <id>", "Limit to a specific source")
  .action((opts: { source?: string }) => {
    const db = getDb();
    const sourceFilter = opts.source ? `AND f.source_id = '${requireId(opts.source, "sources")}'` : "";
    const groups = db.query<{ hash: string; cnt: number; total_size: number }, []>(`
      SELECT hash, COUNT(*) as cnt, SUM(size) as total_size
      FROM files WHERE status='active' AND hash IS NOT NULL ${sourceFilter}
      GROUP BY hash HAVING cnt > 1
      ORDER BY total_size DESC
    `).all();

    if (!groups.length) {
      console.log(chalk.green("✓ No duplicates found."));
      return;
    }

    const wasted = groups.reduce((acc, g) => acc + g.total_size - (g.total_size / g.cnt), 0);
    console.log(chalk.bold(`\n  ${groups.length} duplicate group(s) — ${formatSize(wasted)} wasted\n`));

    for (const g of groups) {
      const files = db.query<{ id: string; name: string; path: string; source_id: string; size: number }, [string]>(
        "SELECT id, name, path, source_id, size FROM files WHERE hash=? AND status='active' ORDER BY indexed_at"
      ).all(g.hash);
      console.log(chalk.yellow(`  ${g.hash.slice(0, 16)}…  ${chalk.dim(`×${g.cnt}  ${formatSize(files[0]!.size)} each`)}`));
      for (const f of files) {
        console.log(`    ${chalk.bold(f.id)}  ${chalk.cyan(f.name)}  ${chalk.dim(f.path)}`);
      }
      console.log();
    }
  });

// ─── peers ───────────────────────────────────────────────────────────────────

const peers = program.command("peers").description("Manage peer machines for sync");

peers
  .command("list")
  .alias("ls")
  .description("List saved peers")
  .action(() => {
    const all = listPeers();
    if (!all.length) { console.log(chalk.dim("No peers saved. Run: files peers add <url>")); return; }
    for (const p of all) {
      const auto = p.auto_sync ? chalk.green(` [auto every ${p.sync_interval_minutes}m]`) : "";
      const last = p.last_synced_at ? chalk.dim(` last synced ${p.last_synced_at}`) : chalk.dim(" never synced");
      console.log(`${chalk.bold(p.id)}  ${chalk.cyan(p.url)}  ${p.name || ""}${auto}${last}`);
    }
  });

peers
  .command("add <url>")
  .description("Add a peer machine URL")
  .option("-n, --name <name>", "Peer name")
  .option("--auto", "Enable auto-sync")
  .option("--interval <minutes>", "Auto-sync interval in minutes", "30")
  .action((url: string, opts: { name?: string; auto?: boolean; interval: string }) => {
    const peer = addPeer(url, opts.name ?? "", opts.auto ?? false, parseInt(opts.interval, 10));
    console.log(chalk.green(`✓ Peer added: ${peer.id} → ${peer.url}`));
    if (peer.auto_sync) console.log(chalk.dim(`  Auto-sync every ${peer.sync_interval_minutes} minutes`));
  });

peers
  .command("remove <id-or-url>")
  .description("Remove a peer")
  .action((idOrUrl: string) => {
    const ok = removePeer(idOrUrl);
    if (ok) console.log(chalk.green("✓ Peer removed"));
    else console.error(chalk.red(`Peer not found: ${idOrUrl}`));
  });

program
  .command("sync <peer-url...>")
  .description("Sync file index from one or more peer machines (e.g. http://192.168.1.10:19432)")
  .action(async (peerUrls: string[]) => {
    const { syncWithPeers } = await import("../lib/sync.js");
    const results = await syncWithPeers(peerUrls);
    for (const r of results) {
      if (r.errors.length) {
        console.error(chalk.red(`✗ ${r.peer}: ${r.errors.join(", ")}`));
      } else {
        console.log(chalk.green(`✓ ${r.peer}`) + chalk.dim(` machines:${r.machines_synced} files:${r.files_synced}`));
      }
    }
  });

program
  .command("open <file-id>")
  .description("Open a file in the default application")
  .action((fileId: string) => {
    try {
      const file = getFile(requireId(fileId, "files"))!;
      const source = getSource(file.source_id);
      if (!source || source.type !== "local") { console.error(chalk.red("open only works with local sources")); process.exit(1); }
      const fullPath = join(source.path!, file.path);
      Bun.spawn(["open", fullPath], { stdout: "inherit", stderr: "inherit" });
    } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
  });

program
  .command("where <file-id>")
  .description("Print the full absolute path of a file (for shell scripting)")
  .action((fileId: string) => {
    try {
      const file = getFile(requireId(fileId, "files"))!;
      const source = getSource(file.source_id);
      if (!source || source.type !== "local") { console.error(chalk.red("where only works with local sources")); process.exit(1); }
      process.stdout.write(join(source.path!, file.path) + "\n");
    } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
  });

program
  .command("cat <file-id>")
  .description("Print file content to stdout")
  .option("--max-bytes <n>", "Max bytes to read (default: unlimited)", "0")
  .action((fileId: string, opts: { maxBytes: string }) => {
    try {
      const file = getFile(requireId(fileId, "files"))!;
      const source = getSource(file.source_id);
      if (!source || source.type !== "local") { console.error(chalk.red("cat only works with local sources")); process.exit(1); }
      const fullPath = join(source.path!, file.path);
      const { readFileSync } = require("fs") as typeof import("fs");
      const maxBytes = parseInt(opts.maxBytes, 10);
      const buf = readFileSync(fullPath);
      const slice = maxBytes > 0 ? buf.slice(0, maxBytes) : buf;
      process.stdout.write(slice);
    } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
  });

program
  .command("recent")
  .description("Show recently indexed files")
  .option("-l, --limit <n>", "Max results", "20")
  .option("--json", "Output as JSON")
  .action((opts: { limit: string; json?: boolean }) => {
    const db = getDb();
    const files = db.query<{ id: string; name: string; path: string; size: number; indexed_at: string; source_id: string }, [number]>(
      "SELECT id, name, path, size, indexed_at, source_id FROM files WHERE status='active' ORDER BY indexed_at DESC LIMIT ?"
    ).all(parseInt(opts.limit, 10));
    if (opts.json) { console.log(JSON.stringify(files, null, 2)); return; }
    for (const f of files) {
      console.log(`${chalk.bold(f.id)}  ${chalk.cyan(f.name)}  ${formatSize(f.size)}  ${chalk.dim(f.indexed_at)}`);
    }
  });

program
  .command("watch")
  .description("Start file watcher for all local sources (foreground daemon)")
  .action(async () => {
    const machine = getCurrentMachine();
    const { watchSource } = await import("../lib/watcher.js");
    const localSources = listSources(machine.id).filter((s) => s.enabled && s.type === "local");
    if (!localSources.length) { console.log(chalk.dim("No local sources to watch.")); return; }
    for (const s of localSources) {
      watchSource(s, machine.id);
      console.log(chalk.green(`✓ Watching: ${s.name} (${s.path})`));
    }
    console.log(chalk.dim("Press Ctrl+C to stop."));
    await new Promise(() => {}); // keep alive
  });

// ─── config ──────────────────────────────────────────────────────────────────

const config = program.command("config").description("Manage configuration");

config
  .command("list")
  .alias("ls")
  .description("Show all config values")
  .action(() => {
    const cfg = loadConfig();
    console.log(chalk.bold(`\n  Config: ${CONFIG_PATH_EXPORT}\n`));
    for (const [k, v] of Object.entries(cfg)) {
      console.log(`  ${chalk.cyan(k.padEnd(24))} ${JSON.stringify(v)}`);
    }
    console.log();
  });

config
  .command("get <key>")
  .description("Get a config value")
  .action((key: string) => {
    const cfg = loadConfig();
    const val = cfg[key];
    if (val === undefined) { console.error(chalk.red(`Unknown key: ${key}`)); process.exit(1); }
    console.log(JSON.stringify(val));
  });

config
  .command("set <key> <value>")
  .description("Set a config value (auto_watch, hash_skip_bytes, default_limit, ignore_patterns)")
  .action((key: string, value: string) => {
    try {
      setConfigValue(key, value);
      console.log(chalk.green(`✓ ${key} = ${value}`));
    } catch (e) { console.error(chalk.red((e as Error).message)); process.exit(1); }
  });

program
  .command("db")
  .description("Show database path")
  .action(() => console.log(DB_PATH));

// ─── utils ───────────────────────────────────────────────────────────────────

function parseSize(s: string): number {
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(kb|mb|gb|b)?$/i);
  if (!m) return parseInt(s, 10) || 0;
  const n = parseFloat(m[1]!);
  const unit = (m[2] ?? "b").toLowerCase();
  if (unit === "kb") return Math.floor(n * 1024);
  if (unit === "mb") return Math.floor(n * 1024 ** 2);
  if (unit === "gb") return Math.floor(n * 1024 ** 3);
  return Math.floor(n);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)}KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)}MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
}

// remove — alias for sources remove (consistent with open-* CLI conventions)
program
  .command("remove <source-id>")
  .description("Remove a source and all its indexed files (alias for sources remove)")
  .action((id: string) => {
    const resolvedId = requireId(id, "sources");
    const ok = deleteSource(resolvedId);
    if (ok) console.log(chalk.green(`✓ Source ${resolvedId} removed`));
    else { console.error(chalk.red(`Source not found: ${resolvedId}`)); process.exit(1); }
  });

program.parse();
