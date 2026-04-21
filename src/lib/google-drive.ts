import { basename, dirname, extname, posix } from "path";
import { lookup as mimeLookup } from "mime-types";
import { Drive, setProfileOverride } from "@hasna/connect-googledrive";
import { getCurrentMachine } from "../db/machines.js";
import { markFileDeleted, upsertFile } from "../db/files.js";
import {
  getGoogleDriveImportedObject,
  listDeletedGoogleDriveImportedObjects,
  listGoogleDriveImportedObjects,
  markGoogleDriveSynced,
  markGoogleDriveSyncError,
  upsertGoogleDriveImportedObject,
  markMissingGoogleDriveObjectsDeleted,
} from "../db/google-drive.js";
import { getSource, markSourceIndexed } from "../db/sources.js";
import { uploadBufferToS3 } from "./s3.js";
import type {
  GoogleDriveConfig,
  GoogleDriveItem,
  GoogleDriveSharedDrive,
  GoogleDriveImportedObject,
  IndexStats,
  Source,
} from "../types/index.js";

type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  version?: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime?: string;
};

const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";
const DRIVE_FIELDS = "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents,version,md5Checksum)";

function getGoogleDriveConfig(source: Source): GoogleDriveConfig {
  if (source.type !== "google_drive") throw new Error("Source is not a Google Drive source");
  return source.config as GoogleDriveConfig;
}

function getDestinationSource(source: Source): Source {
  const config = getGoogleDriveConfig(source);
  const destination = getSource(config.destination_source_id);
  if (!destination) throw new Error(`Destination source not found: ${config.destination_source_id}`);
  if (destination.type !== "s3") throw new Error("Google Drive import destination must be an S3 source");
  if (!destination.bucket) throw new Error("Destination S3 source missing bucket");
  return destination;
}

function withProfile<T>(profile: string, fn: () => Promise<T>): Promise<T> {
  setProfileOverride(profile);
  return fn().finally(() => setProfileOverride(undefined));
}

function createDrive(profile: string): Promise<Drive> {
  return withProfile(profile, async () => Drive.create());
}

export async function listGoogleDriveSharedDrives(source: Source): Promise<GoogleDriveSharedDrive[]> {
  const config = getGoogleDriveConfig(source);
  const drive = await createDrive(config.profile);
  const response = await withProfile(config.profile, () => drive.drives.list());
  return response.drives.map((item) => ({ id: item.id, name: item.name }));
}

export async function listGoogleDriveItems(source: Source): Promise<GoogleDriveItem[]> {
  const config = getGoogleDriveConfig(source);
  const drive = await createDrive(config.profile);
  return withProfile(config.profile, async () => {
    const items: GoogleDriveItem[] = [];
    if (config.include_my_drive) {
      items.push(...await listMyDriveItems(drive, config));
    }
    for (const shared of await getIncludedSharedDrives(source, drive)) {
      items.push(...await listSharedDriveItems(drive, shared.id, shared.name));
    }
    return items;
  });
}

export async function syncGoogleDriveSource(source: Source): Promise<IndexStats> {
  const config = getGoogleDriveConfig(source);
  const destination = getDestinationSource(source);
  const machine = getCurrentMachine();
  const start = Date.now();
  const stats: IndexStats = { source_id: source.id, added: 0, updated: 0, deleted: 0, errors: 0, duration_ms: 0 };

  try {
    const drive = await createDrive(config.profile);
    const items = await listGoogleDriveItems(source);
    const seen = new Array<{ drive_id: string; file_id: string }>();

    for (const item of items) {
      seen.push({ drive_id: item.drive_id, file_id: item.id });
      try {
        const existing = getGoogleDriveImportedObject(source.id, item.drive_id, item.id);
        if (existing && !shouldImport(item, existing)) continue;

        const downloaded = await withProfile(config.profile, () => drive.files.download(item.id));
        const importedName = basename(downloaded.filename);
        const importedPath = buildImportedPath(item, importedName);
        const contentType = ((mimeLookup(downloaded.filename) || item.mime || "application/octet-stream") as string);
        const key = buildS3Key(source, importedPath);
        await uploadBufferToS3(destination, Buffer.from(downloaded.data), key, contentType, downloaded.data.byteLength);
        const fileRecord = upsertFile({
          id: existing?.file_record_id,
          source_id: source.id,
          machine_id: machine.id,
          path: importedPath,
          name: importedName,
          ext: extname(importedName).toLowerCase(),
          size: downloaded.data.byteLength,
          mime: contentType,
          hash: item.hash,
          status: "active",
          modified_at: item.modified_at,
        });

        upsertGoogleDriveImportedObject({
          source_id: source.id,
          drive_id: item.drive_id,
          file_id: item.id,
          parent_id: item.parent_id,
          path: importedPath,
          name: importedName,
          mime: contentType,
          size: downloaded.data.byteLength,
          modified_at: item.modified_at,
          version: item.version,
          hash: item.hash,
          s3_key: key,
          file_record_id: fileRecord.id,
          deleted: false,
          last_imported_at: new Date().toISOString(),
        });

        if (existing) stats.updated++;
        else stats.added++;
      } catch {
        stats.errors++;
      }
    }

    if (config.delete_behavior === "mark_deleted") {
      stats.deleted += markMissingGoogleDriveObjectsDeleted(source.id, seen);
      for (const record of listDeletedGoogleDriveImportedObjects(source.id)) {
        markFileDeleted(source.id, record.path);
      }
    }

    markGoogleDriveSynced(source.id, true);
    markSourceIndexed(source.id, listGoogleDriveImportedObjectsCount(source.id));
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

async function getIncludedSharedDrives(source: Source, drive: Drive): Promise<GoogleDriveSharedDrive[]> {
  const config = getGoogleDriveConfig(source);
  if (!config.include_all_shared_drives && (!config.shared_drive_ids || config.shared_drive_ids.length === 0)) {
    return [];
  }

  const response = await drive.drives.list();
  const all = response.drives.map((item) => ({ id: item.id, name: item.name }));
  if (config.include_all_shared_drives) return all;
  const allowed = new Set(config.shared_drive_ids ?? []);
  return all.filter((item) => allowed.has(item.id));
}

async function listMyDriveItems(drive: Drive, config: GoogleDriveConfig): Promise<GoogleDriveItem[]> {
  const files = await listAllDriveFiles(async (pageToken) => {
    const response = await drive.files.list({
      pageSize: 100,
      pageToken,
      q: config.root_folder_ids?.length ? buildParentQuery(config.root_folder_ids) : "trashed = false",
      fields: DRIVE_FIELDS,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return {
      files: response.files as DriveFile[],
      nextPageToken: response.nextPageToken,
    };
  });
  return buildGoogleDriveItems(files, "my-drive", "My Drive", false);
}

async function listSharedDriveItems(drive: Drive, driveId: string, driveName: string): Promise<GoogleDriveItem[]> {
  const files = await listAllDriveFiles(async (pageToken) => {
    const response = await drive.drives.listFiles(driveId, {
      pageSize: 100,
      pageToken,
    });
    return {
      files: response.files as DriveFile[],
      nextPageToken: response.nextPageToken,
    };
  });
  return buildGoogleDriveItems(files, driveId, driveName, true);
}

async function listAllDriveFiles(
  fetchPage: (pageToken?: string) => Promise<{ files: DriveFile[]; nextPageToken?: string }>,
): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;

  do {
    const response = await fetchPage(pageToken);
    files.push(...response.files);
    pageToken = response.nextPageToken;
  } while (pageToken);

  return files;
}

function buildGoogleDriveItems(files: DriveFile[], driveId: string, driveName: string, isSharedDrive: boolean): GoogleDriveItem[] {
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

function buildPath(folderId: string | undefined, byId: Map<string, DriveFile>): string {
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
  return `trashed = false and (${folderIds.map((id) => `'${id}' in parents`).join(" or ")})`;
}

function buildS3Key(source: Source, importedPath: string): string {
  const destination = getDestinationSource(source);
  return destination.prefix ? posix.join(destination.prefix, importedPath) : importedPath;
}

function shouldImport(item: GoogleDriveItem, existing: GoogleDriveImportedObject): boolean {
  return existing.path !== buildImportedPath(item, existing.name) || existing.hash !== item.hash || existing.modified_at !== item.modified_at || existing.version !== item.version || existing.deleted;
}

function buildImportedPath(item: GoogleDriveItem, importedName: string): string {
  return item.path === item.name ? importedName : posix.join(dirname(item.path), importedName);
}
