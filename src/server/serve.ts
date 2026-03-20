import { getCurrentMachine, listMachines } from "../db/machines.js";
import { createSource, listSources, getSource, deleteSource } from "../db/sources.js";
import { listFiles, getFile } from "../db/files.js";
import { searchFiles } from "../db/search.js";
import { tagFile, untagFile, listTags } from "../db/tags.js";
import { createCollection, listCollections, addToCollection, removeFromCollection } from "../db/collections.js";
import { createProject, listProjects, addToProject, removeFromProject } from "../db/projects.js";
import { indexLocalSource } from "../lib/indexer.js";
import { indexS3Source, downloadFromS3 } from "../lib/s3.js";
import { join } from "path";
import { homedir } from "os";
import type { S3Config } from "../types/index.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

function err(msg: string, status = 400): Response {
  return json({ error: msg }, status);
}

async function parseBody(req: Request): Promise<Record<string, unknown>> {
  try { return await req.json() as Record<string, unknown>; }
  catch { return {}; }
}

export function startServer(port: number): void {
  Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const method = req.method;

      if (method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*" } });

      // ── Sources ──────────────────────────────────────────────────────────
      if (path === "/sources" && method === "GET") {
        const machine_id = url.searchParams.get("machine_id") ?? undefined;
        return json(listSources(machine_id));
      }
      if (path === "/sources" && method === "POST") {
        const body = await parseBody(req);
        const machine = getCurrentMachine();
        const source = createSource({
          type: (body.type as "local" | "s3") ?? "local",
          path: body.path as string | undefined,
          bucket: body.bucket as string | undefined,
          prefix: body.prefix as string | undefined,
          region: body.region as string | undefined,
          name: (body.name as string | undefined) ?? (body.bucket as string) ?? (body.path as string),
          config: (body.config as S3Config) ?? {},
          machine_id: machine.id,
        });
        return json(source, 201);
      }
      if (path.match(/^\/sources\/[^/]+$/) && method === "DELETE") {
        const id = path.split("/")[2]!;
        deleteSource(id);
        return json({ ok: true });
      }
      if (path.match(/^\/sources\/[^/]+\/index$/) && method === "POST") {
        const id = path.split("/")[2]!;
        const source = getSource(id);
        if (!source) return err("Source not found", 404);
        const machine = getCurrentMachine();
        const stats = source.type === "s3"
          ? await indexS3Source(source, machine.id)
          : await indexLocalSource(source, machine.id);
        return json(stats);
      }

      // ── Files ─────────────────────────────────────────────────────────────
      if (path === "/files" && method === "GET") {
        const opts = {
          source_id: url.searchParams.get("source_id") ?? undefined,
          machine_id: url.searchParams.get("machine_id") ?? undefined,
          tag: url.searchParams.get("tag") ?? undefined,
          collection_id: url.searchParams.get("collection_id") ?? undefined,
          project_id: url.searchParams.get("project_id") ?? undefined,
          ext: url.searchParams.get("ext") ?? undefined,
          limit: parseInt(url.searchParams.get("limit") ?? "50"),
          offset: parseInt(url.searchParams.get("offset") ?? "0"),
        };
        const q = url.searchParams.get("q");
        const files = q ? searchFiles(q, opts) : listFiles(opts);
        return json(files);
      }
      if (path.match(/^\/files\/[^/]+$/) && method === "GET") {
        const id = path.split("/")[2]!;
        const file = getFile(id);
        if (!file) return err("File not found", 404);
        return json(file);
      }
      if (path.match(/^\/files\/[^/]+\/download$/) && method === "GET") {
        const id = path.split("/")[2]!;
        const file = getFile(id);
        if (!file) return err("File not found", 404);
        const source = getSource(file.source_id);
        if (!source) return err("Source not found", 404);
        if (source.type === "local") {
          const fullPath = join(source.path!, file.path);
          return json({ local_path: fullPath });
        }
        const dest = join(homedir(), "Downloads", file.name);
        await downloadFromS3(source, file.path, dest);
        return json({ downloaded_to: dest });
      }
      if (path.match(/^\/files\/[^/]+\/tags$/) && method === "POST") {
        const id = path.split("/")[2]!;
        const body = await parseBody(req);
        const tags = (body.tags as string[]) ?? [];
        for (const t of tags) tagFile(id, t);
        return json({ ok: true });
      }
      if (path.match(/^\/files\/[^/]+\/tags$/) && method === "DELETE") {
        const id = path.split("/")[2]!;
        const body = await parseBody(req);
        const tags = (body.tags as string[]) ?? [];
        for (const t of tags) untagFile(id, t);
        return json({ ok: true });
      }

      // ── Tags ──────────────────────────────────────────────────────────────
      if (path === "/tags" && method === "GET") return json(listTags());

      // ── Collections ───────────────────────────────────────────────────────
      if (path === "/collections" && method === "GET") return json(listCollections());
      if (path === "/collections" && method === "POST") {
        const body = await parseBody(req);
        return json(createCollection(body.name as string, body.description as string | undefined), 201);
      }
      if (path.match(/^\/collections\/[^/]+\/files$/) && method === "POST") {
        const id = path.split("/")[2]!;
        const body = await parseBody(req);
        addToCollection(id, body.file_id as string);
        return json({ ok: true });
      }
      if (path.match(/^\/collections\/[^/]+\/files\/[^/]+$/) && method === "DELETE") {
        const parts = path.split("/");
        removeFromCollection(parts[2]!, parts[4]!);
        return json({ ok: true });
      }

      // ── Projects ──────────────────────────────────────────────────────────
      if (path === "/projects" && method === "GET") return json(listProjects());
      if (path === "/projects" && method === "POST") {
        const body = await parseBody(req);
        return json(createProject(body.name as string, body.description as string | undefined), 201);
      }
      if (path.match(/^\/projects\/[^/]+\/files$/) && method === "POST") {
        const id = path.split("/")[2]!;
        const body = await parseBody(req);
        addToProject(id, body.file_id as string);
        return json({ ok: true });
      }
      if (path.match(/^\/projects\/[^/]+\/files\/[^/]+$/) && method === "DELETE") {
        const parts = path.split("/");
        removeFromProject(parts[2]!, parts[4]!);
        return json({ ok: true });
      }

      // ── Machines ──────────────────────────────────────────────────────────
      if (path === "/machines" && method === "GET") return json(listMachines());
      if (path === "/machines/current" && method === "GET") return json(getCurrentMachine());

      // ── Sync ──────────────────────────────────────────────────────────────
      if (path === "/sync" && method === "POST") {
        const body = await parseBody(req);
        const peers = (body.peers as string[]) ?? [];
        if (!peers.length) return err("peers array required");
        const { syncWithPeers } = await import("../lib/sync.js");
        const results = await syncWithPeers(peers);
        return json(results);
      }

      // ── Health ────────────────────────────────────────────────────────────
      if (path === "/health") return json({ ok: true, version: "0.1.0" });

      return err("Not found", 404);
    },
  });

  console.log(`files-serve running on http://localhost:${port}`);
}
