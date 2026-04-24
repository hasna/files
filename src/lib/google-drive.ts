import { mkdirSync, writeFileSync } from "fs";
import { basename, dirname, extname, join, posix } from "path";
import { lookup as mimeLookup } from "mime-types";
import { getCurrentMachine } from "../db/machines.js";
import { markFileDeletedById, upsertFile } from "../db/files.js";
import {
  getGoogleDriveImportedObject,
  listDeletedGoogleDriveImportedObjects,
  listGoogleDriveImportedObjects,
  markGoogleDriveSynced,
  markGoogleDriveSyncError,
  upsertGoogleDriveImportedObject,
  markMissingGoogleDriveObjectsDeleted,
} from "../db/google-drive.js";
import { getDb } from "../db/database.js";
import { getSource, listSources, markSourceIndexed } from "../db/sources.js";
import { hashBuffer } from "./hasher.js";
import { loadConfig } from "./config.js";
import { uploadBufferToS3 } from "./s3.js";
import {
  GOOGLE_FOLDER_MIME,
  createConnectorProfileGoogleDriveClient,
  listGoogleDriveProfilesFromConnectorConfig,
  type GoogleDriveApiFile,
  type GoogleDriveClient,
} from "./google-drive-client.js";
import type {
  GoogleDriveConfig,
  GoogleDriveItem,
  GoogleDriveSharedDrive,
  GoogleDriveImportedObject,
  IndexStats,
  Source,
} from "../types/index.js";

const DRIVE_FIELDS = "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,version,md5Checksum)";

type GoogleDriveStorageType = "s3" | "local";

type GoogleDriveStorageAdapter = {
  uploadS3: typeof uploadBufferToS3;
  writeLocal: (source: Source, relativePath: string, data: Buffer) => Promise<string>;
};

let clientFactory: (profile: string) => GoogleDriveClient = createConnectorProfileGoogleDriveClient;
let storageAdapter: GoogleDriveStorageAdapter = {
  uploadS3: uploadBufferToS3,
  writeLocal: async (source, relativePath, data) => {
    if (!source.path) throw new Error("Local destination source missing path");
    const localPath = join(source.path, relativePath);
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, data);
    return relativePath;
  },
};

export function setGoogleDriveClientFactoryForTests(factory?: (profile: string) => GoogleDriveClient): void {
  clientFactory = factory ?? createConnectorProfileGoogleDriveClient;
}

export function setGoogleDriveStorageAdapterForTests(adapter?: Partial<GoogleDriveStorageAdapter>): void {
  storageAdapter = {
    uploadS3: adapter?.uploadS3 ?? uploadBufferToS3,
    writeLocal: adapter?.writeLocal ?? (async (source, relativePath, data) => {
      if (!source.path) throw new Error("Local destination source missing path");
      const localPath = join(source.path, relativePath);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, data);
      return relativePath;
    }),
  };
}

export function listGoogleDriveProfiles(): string[] {
  return listGoogleDriveProfilesFromConnectorConfig();
}

function getGoogleDriveConfig(source: Source): GoogleDriveConfig {
  if (source.type !== "google_drive") throw new Error("Source is not a Google Drive source");
  const config = source.config as GoogleDriveConfig;
  if (!config.profile) throw new Error("Google Drive source missing profile");
  return config;
}

function getDestinationSource(source: Source): { source: Source; storage_type: GoogleDriveStorageType } {
  const config = getGoogleDriveConfig(source);
  const configuredId = config.destination_source_id || getConfiguredDefaultDestinationSourceId();

  if (configuredId) {
    const destination = getSource(configuredId);
    if (!destination) throw new Error(`Destination source not found: ${configuredId}`);
    if (destination.type !== "s3" && destination.type !== "local") {
      throw new Error("Google Drive import destination must be an S3 or local source");
    }
    if (destination.type === "s3" && !destination.bucket) throw new Error("Destination S3 source missing bucket");
    if (destination.type === "local" && !destination.path) throw new Error("Destination local source missing path");
    return { source: destination, storage_type: destination.type };
  }

  const machineS3 = listSources(source.machine_id).find((item) => item.enabled && item.type === "s3" && item.bucket);
  const anyS3 = machineS3 ?? listSources().find((item) => item.enabled && item.type === "s3" && item.bucket);
  if (anyS3) return { source: anyS3, storage_type: "s3" };

  throw new Error(
    "Google Drive sync needs an S3 destination by default. Add an S3 source, set google_drive_default_destination_source_id, or pass a local destination source.",
  );
}

function getConfiguredDefaultDestinationSourceId(): string | undefined {
  const value = loadConfig().google_drive_default_destination_source_id;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function listGoogleDriveSharedDrives(source: Source): Promise<GoogleDriveSharedDrive[]> {
  const config = getGoogleDriveConfig(source);
  const client = clientFactory(config.profile);
  return listAllSharedDrives(client);
}

export async function listGoogleDriveItems(source: Source): Promise<GoogleDriveItem[]> {
  const config = getGoogleDriveConfig(source);
  const client = clientFactory(config.profile);
  return listGoogleDriveItemsWithClient(source, client);
}

async function listGoogleDriveItemsWithClient(source: Source, client: GoogleDriveClient): Promise<GoogleDriveItem[]> {
  const config = getGoogleDriveConfig(source);
  const items: GoogleDriveItem[] = [];
  if (config.include_my_drive) {
    items.push(...await listMyDriveItems(client, config));
  }
  for (const shared of await getIncludedSharedDrives(source, client)) {
    items.push(...await listSharedDriveItems(client, shared.id, shared.name));
  }
  return items;
}

export async function syncGoogleDriveSource(source: Source): Promise<IndexStats> {
  const config = getGoogleDriveConfig(source);
  const destination = getDestinationSource(source);
  const machine = getCurrentMachine();
  const start = Date.now();
  const stats: IndexStats = { source_id: source.id, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 0 };
  let lastImportError: string | undefined;

  try {
    const client = clientFactory(config.profile);
    const items = await listGoogleDriveItemsWithClient(source, client);
    const seen = new Array<{ drive_id: string; file_id: string }>();

    for (const item of items) {
      seen.push({ drive_id: item.drive_id, file_id: item.id });
      try {
        const existing = getGoogleDriveImportedObject(source.id, item.drive_id, item.id);
        if (existing && !shouldImport(config, item, existing, destination.source.id, destination.storage_type)) continue;

        const downloaded = await client.downloadFile(toApiFile(item), config.export_formats);
        const importedName = basename(downloaded.filename);
        const importedPath = buildImportedPath(config, item, importedName);
        const contentType = downloaded.mimeType || ((mimeLookup(downloaded.filename) || item.mime || "application/octet-stream") as string);
        const data = Buffer.from(downloaded.data);
        const storageKey = await writeToDestination(destination.source, destination.storage_type, importedPath, data, contentType);
        const fileRecord = upsertFile({
          id: existing?.file_record_id,
          source_id: destination.source.id,
          machine_id: machine.id,
          path: storageKey,
          name: importedName,
          ext: extname(importedName).toLowerCase(),
          size: data.byteLength,
          mime: contentType,
          hash: item.hash ?? hashBuffer(data),
          status: "active",
          modified_at: item.modified_at,
        });

        upsertGoogleDriveImportedObject({
          source_id: source.id,
          drive_id: item.drive_id,
          file_id: item.id,
          profile: config.profile,
          parent_id: item.parent_id,
          path: importedPath,
          name: importedName,
          mime: contentType,
          size: data.byteLength,
          modified_at: item.modified_at,
          version: item.version,
          hash: item.hash,
          storage_type: destination.storage_type,
          storage_key: storageKey,
          destination_source_id: destination.source.id,
          s3_key: destination.storage_type === "s3" ? storageKey : "",
          file_record_id: fileRecord.id,
          deleted: false,
          last_imported_at: new Date().toISOString(),
        });

        if (existing) stats.updated++;
        else stats.added++;
      } catch (error) {
        lastImportError = `${item.path}: ${(error as Error).message}`;
        markGoogleDriveSyncError(source.id, lastImportError);
        stats.errors++;
      }
    }

    if (config.delete_behavior === "mark_deleted") {
      stats.deleted += markMissingGoogleDriveObjectsDeleted(source.id, seen);
      for (const record of listDeletedGoogleDriveImportedObjects(source.id)) {
        markFileDeletedById(record.file_record_id);
      }
    }

    markGoogleDriveSynced(source.id, true);
    if (lastImportError) markGoogleDriveSyncError(source.id, lastImportError);
    markSourceIndexed(source.id, listGoogleDriveImportedObjectsCount(source.id));
    markSourceIndexed(destination.source.id, countActiveFiles(destination.source.id));
    stats.duration_ms = Date.now() - start;
    return stats;
  } catch (error) {
    markGoogleDriveSyncError(source.id, (error as Error).message);
    stats.duration_ms = Date.now() - start;
    throw error;
  }
}

function listGoogleDriveImportedObjectsCount(source_id: string): number {
  return listGoogleDriveImportedObjects(source_id).filter((item) => !item.deleted).length;
}

function countActiveFiles(source_id: string): number {
  const row = getDb().query<{ n: number }, [string]>(
    "SELECT COUNT(*) AS n FROM files WHERE source_id = ? AND status = 'active'",
  ).get(source_id);
  return row?.n ?? 0;
}

async function writeToDestination(
  source: Source,
  storageType: GoogleDriveStorageType,
  importedPath: string,
  data: Buffer,
  contentType: string,
): Promise<string> {
  if (storageType === "s3") {
    const key = buildStorageKey(source, importedPath);
    return storageAdapter.uploadS3(source, data, key, contentType, data.byteLength);
  }
  return storageAdapter.writeLocal(source, importedPath, data);
}

async function getIncludedSharedDrives(source: Source, client: GoogleDriveClient): Promise<GoogleDriveSharedDrive[]> {
  const config = getGoogleDriveConfig(source);
  if (!config.include_all_shared_drives && (!config.shared_drive_ids || config.shared_drive_ids.length === 0)) {
    return [];
  }

  const all = await listAllSharedDrives(client);
  if (config.include_all_shared_drives) return all;
  const allowed = new Set(config.shared_drive_ids ?? []);
  return all.filter((item) => allowed.has(item.id));
}

async function listAllSharedDrives(client: GoogleDriveClient): Promise<GoogleDriveSharedDrive[]> {
  const drives: GoogleDriveSharedDrive[] = [];
  let pageToken: string | undefined;
  do {
    const response = await client.listSharedDrives({ pageSize: 100, pageToken });
    drives.push(...response.drives.map((item) => ({ id: item.id, name: item.name })));
    pageToken = response.nextPageToken;
  } while (pageToken);
  return drives;
}

async function listMyDriveItems(client: GoogleDriveClient, config: GoogleDriveConfig): Promise<GoogleDriveItem[]> {
  if (config.root_folder_ids?.length) {
    const files = await listFolderTree(client, config.root_folder_ids);
    return buildGoogleDriveItems(files, "my-drive", "My Drive", false);
  }

  const files = await listAllDriveFiles(async (pageToken) => {
    const response = await client.listFiles({
      pageSize: 1000,
      pageToken,
      q: "trashed = false",
      fields: DRIVE_FIELDS,
      corpora: "user",
      supportsAllDrives: true,
      includeItemsFromAllDrives: false,
    });
    return {
      files: response.files,
      nextPageToken: response.nextPageToken,
    };
  });
  return buildGoogleDriveItems(files, "my-drive", "My Drive", false);
}

async function listFolderTree(client: GoogleDriveClient, rootFolderIds: string[]): Promise<GoogleDriveApiFile[]> {
  const files: GoogleDriveApiFile[] = [];
  const queue = [...rootFolderIds];
  const visited = new Set<string>();

  while (queue.length) {
    const folderId = queue.shift()!;
    if (visited.has(folderId)) continue;
    visited.add(folderId);

    const children = await listAllDriveFiles(async (pageToken) => {
      const response = await client.listFiles({
        pageSize: 1000,
        pageToken,
        q: buildParentQuery([folderId]),
        fields: DRIVE_FIELDS,
        corpora: "user",
        supportsAllDrives: true,
        includeItemsFromAllDrives: false,
      });
      return {
        files: response.files,
        nextPageToken: response.nextPageToken,
      };
    });

    files.push(...children);
    for (const child of children) {
      if (child.mimeType === GOOGLE_FOLDER_MIME) queue.push(child.id);
    }
  }

  return files;
}

async function listSharedDriveItems(client: GoogleDriveClient, driveId: string, driveName: string): Promise<GoogleDriveItem[]> {
  const files = await listAllDriveFiles(async (pageToken) => {
    const response = await client.listFiles({
      pageSize: 1000,
      pageToken,
      q: "trashed = false",
      fields: DRIVE_FIELDS,
      corpora: "drive",
      driveId,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return {
      files: response.files,
      nextPageToken: response.nextPageToken,
    };
  });
  return buildGoogleDriveItems(files, driveId, driveName, true);
}

async function listAllDriveFiles(
  fetchPage: (pageToken?: string) => Promise<{ files: GoogleDriveApiFile[]; nextPageToken?: string }>,
): Promise<GoogleDriveApiFile[]> {
  const files: GoogleDriveApiFile[] = [];
  let pageToken: string | undefined;

  do {
    const response = await fetchPage(pageToken);
    files.push(...response.files);
    pageToken = response.nextPageToken;
  } while (pageToken);

  return files;
}

function buildGoogleDriveItems(files: GoogleDriveApiFile[], driveId: string, driveName: string, isSharedDrive: boolean): GoogleDriveItem[] {
  const byId = new Map(files.map((file) => [file.id, file]));

  return files
    .filter((file) => file.mimeType !== GOOGLE_FOLDER_MIME)
    .map((file) => {
      const parentId = file.parents?.[0];
      const parentPath = buildPath(parentId, byId);
      return {
        id: file.id,
        drive_id: driveId,
        drive_name: driveName,
        is_shared_drive: isSharedDrive,
        parent_id: parentId,
        path: joinPath(parentPath, file.name),
        name: file.name,
        mime: file.mimeType,
        size: Number(file.size ?? 0),
        modified_at: file.modifiedTime,
        hash: file.md5Checksum,
        version: file.version,
      };
    });
}

function buildPath(folderId: string | undefined, byId: Map<string, GoogleDriveApiFile>): string {
  if (!folderId) return "";

  const parts: string[] = [];
  let currentId: string | undefined = folderId;
  while (currentId) {
    const current = byId.get(currentId);
    if (!current || current.mimeType !== GOOGLE_FOLDER_MIME) break;
    parts.unshift(current.name);
    currentId = current.parents?.[0];
  }
  return parts.join("/");
}

function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  return posix.join(parent, name);
}

function buildParentQuery(folderIds: string[]): string {
  return `trashed = false and (${folderIds.map((id) => `'${escapeDriveQueryValue(id)}' in parents`).join(" or ")})`;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function buildStorageKey(source: Source, importedPath: string): string {
  return source.prefix ? posix.join(source.prefix, importedPath) : importedPath;
}

function shouldImport(
  config: GoogleDriveConfig,
  item: GoogleDriveItem,
  existing: GoogleDriveImportedObject,
  destinationSourceId: string,
  storageType: GoogleDriveStorageType,
): boolean {
  return existing.path !== buildImportedPath(config, item, existing.name)
    || existing.hash !== item.hash
    || existing.modified_at !== item.modified_at
    || existing.version !== item.version
    || existing.destination_source_id !== destinationSourceId
    || existing.storage_type !== storageType
    || existing.deleted;
}

function buildImportedPath(config: GoogleDriveConfig, item: GoogleDriveItem, importedName: string): string {
  if (config.path_mode === "id_based") {
    return posix.join("google-drive", safePathSegment(config.profile), safePathSegment(item.drive_id), item.id, importedName);
  }

  const itemPath = item.path === item.name ? importedName : posix.join(dirname(item.path), importedName);
  const driveSegment = item.drive_id === "my-drive" ? "my-drive" : safePathSegment(item.drive_name || item.drive_id);
  return posix.join("google-drive", safePathSegment(config.profile), driveSegment, itemPath);
}

function safePathSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/\s+/g, " ").trim() || "unnamed";
}

function toApiFile(item: GoogleDriveItem): GoogleDriveApiFile {
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mime,
    parents: item.parent_id ? [item.parent_id] : undefined,
    version: item.version,
    md5Checksum: item.hash,
    size: String(item.size),
    modifiedTime: item.modified_at,
  };
}
