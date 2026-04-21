import {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  type _Object,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";
import { createWriteStream, createReadStream, statSync } from "fs";
import { basename, extname } from "path";
import { pipeline } from "stream/promises";
import { lookup as mimeLookup } from "mime-types";
import { upsertFile, listFiles } from "../db/files.js";
import { getDb } from "../db/database.js";
import { markSourceIndexed } from "../db/sources.js";
import type { Source, IndexStats, S3Config } from "../types/index.js";

function makeClient(source: Source): S3Client {
  const cfg = source.config as S3Config;
  return new S3Client({
    region: source.region ?? "us-east-1",
    ...(cfg.endpoint ? { endpoint: cfg.endpoint } : {}),
    ...(cfg.accessKeyId
      ? {
          credentials: {
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey!,
            sessionToken: cfg.sessionToken,
          },
        }
      : {}),
  });
}

export async function indexS3Source(source: Source, machine_id: string): Promise<IndexStats> {
  if (!source.bucket) throw new Error("S3 source missing bucket");
  const client = makeClient(source);
  const start = Date.now();
  const stats: IndexStats = { source_id: source.id, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 0 };

  const seen = new Set<string>();

  let continuationToken: string | undefined;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: source.bucket,
        Prefix: source.prefix ?? undefined,
        ContinuationToken: continuationToken,
      })
    );

    for (const obj of resp.Contents ?? []) {
      if (!obj.Key || obj.Key.endsWith("/")) continue;
      seen.add(obj.Key);
      await indexS3Object(obj, source, machine_id, stats);
    }

    continuationToken = resp.IsTruncated ? resp.NextContinuationToken : undefined;
  } while (continuationToken);

  // Mark files as deleted if they no longer exist in S3
  const indexedFiles = listFiles({ source_id: source.id, status: "active" });
  for (const file of indexedFiles) {
    if (!seen.has(file.path)) {
      const result = getDb().run(
        "UPDATE files SET status='deleted', indexed_at=datetime('now') WHERE id=? AND status='active'",
        [file.id]
      );
      if (result.changes > 0) stats.deleted++;
    }
  }

  stats.duration_ms = Date.now() - start;
  markSourceIndexed(source.id, stats.added + stats.updated);
  return stats;
}

async function indexS3Object(
  obj: _Object,
  source: Source,
  machine_id: string,
  stats: IndexStats
): Promise<void> {
  const key = obj.Key!;
  if (key.endsWith("/")) return; // skip folder markers

  try {
    const name = basename(key);
    const ext = extname(name).toLowerCase();
    const mime = (mimeLookup(name) || "application/octet-stream") as string;
    const size = obj.Size ?? 0;
    const modified_at = obj.LastModified?.toISOString();
    const hash = obj.ETag?.replace(/"/g, "");

    const result = upsertFile({
      source_id: source.id,
      machine_id,
      path: key,
      name,
      ext,
      size,
      mime,
      hash,
      status: "active",
      modified_at,
    });
    if (result.created_at === result.indexed_at) stats.added++;
    else stats.updated++;
  } catch {
    stats.errors++;
  }
}

export async function downloadFromS3(source: Source, filePath: string, destPath: string): Promise<void> {
  if (!source.bucket) throw new Error("S3 source missing bucket");
  const client = makeClient(source);
  const resp = await client.send(
    new GetObjectCommand({ Bucket: source.bucket, Key: filePath })
  );
  if (!resp.Body) throw new Error("Empty response body");
  const ws = createWriteStream(destPath);
  await pipeline(resp.Body as NodeJS.ReadableStream, ws);
}

export async function uploadToS3(source: Source, localPath: string, s3Key?: string): Promise<string> {
  if (!source.bucket) throw new Error("S3 source missing bucket");
  const key = s3Key ?? (source.prefix ? `${source.prefix}/${basename(localPath)}` : basename(localPath));
  const mime = (mimeLookup(localPath) || "application/octet-stream") as string;
  const stat = statSync(localPath);

  return uploadBufferToS3(source, createReadStream(localPath), key, mime, stat.size);
}

export async function uploadBufferToS3(
  source: Source,
  body: ArrayBuffer | Uint8Array | Buffer | NodeJS.ReadableStream,
  s3Key: string,
  contentType = "application/octet-stream",
  contentLength?: number,
): Promise<string> {
  if (!source.bucket) throw new Error("S3 source missing bucket");
  const client = makeClient(source);

  const upload = new Upload({
    client,
    params: {
      Bucket: source.bucket,
      Key: s3Key,
      Body: body,
      ContentType: contentType,
      ...(contentLength !== undefined ? { ContentLength: contentLength } : {}),
    },
  });

  await upload.done();
  return s3Key;
}

export async function deleteFromS3(source: Source, filePath: string): Promise<void> {
  if (!source.bucket) throw new Error("S3 source missing bucket");
  const client = makeClient(source);
  await client.send(new DeleteObjectCommand({ Bucket: source.bucket, Key: filePath }));
}

export async function getPresignedUrl(source: Source, filePath: string, expiresIn = 3600): Promise<string> {
  if (!source.bucket) throw new Error("S3 source missing bucket");
  const client = makeClient(source);
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: source.bucket, Key: filePath }),
    { expiresIn }
  );
}

export async function headS3Object(source: Source, filePath: string): Promise<{ size: number; mime: string; modified_at: string } | null> {
  if (!source.bucket) return null;
  try {
    const client = makeClient(source);
    const resp = await client.send(new HeadObjectCommand({ Bucket: source.bucket, Key: filePath }));
    return {
      size: resp.ContentLength ?? 0,
      mime: resp.ContentType ?? "application/octet-stream",
      modified_at: resp.LastModified?.toISOString() ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
