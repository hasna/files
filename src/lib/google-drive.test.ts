import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type {
  GoogleDriveApiFile,
  GoogleDriveApiSharedDrive,
  GoogleDriveClient,
  GoogleDriveDownloadedFile,
  GoogleDriveListFilesOptions,
  GoogleDriveListSharedDrivesOptions,
} from "./google-drive-client.js";

const testDir = mkdtempSync(join(tmpdir(), "open-files-"));
process.env.HASNA_FILES_DATA_DIR = testDir;
process.env.HASNA_FILES_DB_PATH = join(testDir, "files.db");

const { closeDb } = await import("../db/database.js");
const { getCurrentMachine } = await import("../db/machines.js");
const { createSource } = await import("../db/sources.js");
const { getFile, listFiles } = await import("../db/files.js");
const {
  listGoogleDriveItems,
  setGoogleDriveClientFactoryForTests,
  setGoogleDriveStorageAdapterForTests,
  syncGoogleDriveSource,
} = await import("./google-drive.js");
const { listGoogleDriveImportedObjects } = await import("../db/google-drive.js");
const { loadConfig, saveConfig } = await import("./config.js");
const { GOOGLE_FOLDER_MIME } = await import("./google-drive-client.js");

type FilePage = { files: GoogleDriveApiFile[]; nextPageToken?: string };
type DrivePage = { drives: GoogleDriveApiSharedDrive[]; nextPageToken?: string };

class MockDriveClient implements GoogleDriveClient {
  readonly listFileCalls: GoogleDriveListFilesOptions[] = [];
  readonly downloaded: string[] = [];

  constructor(
    private readonly filePages: (options: GoogleDriveListFilesOptions) => FilePage,
    private readonly drivePages: (options?: GoogleDriveListSharedDrivesOptions) => DrivePage = () => ({ drives: [] }),
  ) {}

  async listFiles(options: GoogleDriveListFilesOptions): Promise<FilePage> {
    this.listFileCalls.push(options);
    return this.filePages(options);
  }

  async listSharedDrives(options?: GoogleDriveListSharedDrivesOptions): Promise<DrivePage> {
    return this.drivePages(options);
  }

  async downloadFile(file: GoogleDriveApiFile): Promise<GoogleDriveDownloadedFile> {
    this.downloaded.push(file.id);
    return {
      data: new TextEncoder().encode(`data:${file.id}`).buffer,
      filename: file.name,
      mimeType: file.mimeType,
    };
  }
}

beforeEach(() => {
  closeDb();
  rmSync(process.env.HASNA_FILES_DB_PATH!, { force: true });
  rmSync(`${process.env.HASNA_FILES_DB_PATH!}-shm`, { force: true });
  rmSync(`${process.env.HASNA_FILES_DB_PATH!}-wal`, { force: true });
  setGoogleDriveClientFactoryForTests();
  setGoogleDriveStorageAdapterForTests();
  saveConfig({ ...loadConfig(), google_drive_default_destination_source_id: "" });
});

afterAll(() => {
  closeDb();
  rmSync(testDir, { recursive: true, force: true });
});

describe("Google Drive discovery", () => {
  test("paginates My Drive and shared drives while preserving folder paths", async () => {
    const machine = getCurrentMachine();
    const googleSource = createSource({
      name: "Drive",
      type: "google_drive",
      machine_id: machine.id,
      config: {
        profile: "work",
        include_my_drive: true,
        include_all_shared_drives: true,
        delete_behavior: "ignore",
      },
    });

    const client = new MockDriveClient(
      (options) => {
        if (options.driveId === "shared-a") {
          return {
            files: [
              folder("folder-shared", "Shared Folder"),
              file("shared-doc", "deck.pdf", "folder-shared", "application/pdf"),
            ],
          };
        }
        if (options.pageToken === "my-page-2") {
          return { files: [file("my-2", "notes.md", undefined, "text/markdown")] };
        }
        return {
          files: [
            folder("folder-1", "Folder"),
            file("my-1", "report.txt", "folder-1", "text/plain"),
          ],
          nextPageToken: "my-page-2",
        };
      },
      (options) => options?.pageToken === "shared-page-2"
        ? { drives: [{ id: "shared-b", name: "Shared B" }] }
        : { drives: [{ id: "shared-a", name: "Shared A" }], nextPageToken: "shared-page-2" },
    );
    setGoogleDriveClientFactoryForTests(() => client);

    const items = await listGoogleDriveItems(googleSource);

    expect(items.map((item) => [item.drive_id, item.path])).toContainEqual(["my-drive", "Folder/report.txt"]);
    expect(items.map((item) => [item.drive_id, item.path])).toContainEqual(["my-drive", "notes.md"]);
    expect(items.map((item) => [item.drive_name, item.path])).toContainEqual(["Shared A", "Shared Folder/deck.pdf"]);
    expect(items.some((item) => item.mime === GOOGLE_FOLDER_MIME)).toBe(false);
    expect(client.listFileCalls.some((call) => call.pageToken === "my-page-2")).toBe(true);
  });
});

describe("Google Drive sync", () => {
  test("defaults to the first S3 source and records files under the S3 destination", async () => {
    const machine = getCurrentMachine();
    const s3Source = createSource({
      name: "Files bucket",
      type: "s3",
      bucket: "files-bucket",
      prefix: "imports",
      region: "us-east-1",
      config: {},
      machine_id: machine.id,
    });
    const googleSource = createSource({
      name: "Drive",
      type: "google_drive",
      machine_id: machine.id,
      config: {
        profile: "work",
        include_my_drive: true,
        include_all_shared_drives: false,
        delete_behavior: "ignore",
      },
    });
    const uploads: Array<{ key: string; data: string; source: string }> = [];
    setGoogleDriveStorageAdapterForTests({
      uploadS3: async (source, body, key) => {
        uploads.push({ key, data: Buffer.from(body as Uint8Array).toString("utf8"), source: source.id });
        return key;
      },
    });
    setGoogleDriveClientFactoryForTests(() => new MockDriveClient(() => ({
      files: [file("doc-1", "report.txt", undefined, "text/plain", { md5Checksum: "drive-md5", version: "7" })],
    })));

    const stats = await syncGoogleDriveSource(googleSource);

    expect(stats).toMatchObject({ added: 1, updated: 0, deleted: 0, errors: 0 });
    expect(uploads).toEqual([{
      source: s3Source.id,
      key: "imports/google-drive/work/my-drive/report.txt",
      data: "data:doc-1",
    }]);
    const indexed = listFiles({ source_id: s3Source.id });
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.path).toBe("imports/google-drive/work/my-drive/report.txt");
    expect(indexed[0]?.source_id).toBe(s3Source.id);

    const imports = listGoogleDriveImportedObjects(googleSource.id);
    expect(imports[0]).toMatchObject({
      destination_source_id: s3Source.id,
      storage_type: "s3",
      storage_key: "imports/google-drive/work/my-drive/report.txt",
      s3_key: "imports/google-drive/work/my-drive/report.txt",
      file_record_id: indexed[0]?.id,
    });
  });

  test("syncs to a configured local destination and marks missing Drive files deleted", async () => {
    const machine = getCurrentMachine();
    const localRoot = join(testDir, "local-destination");
    const localSource = createSource({
      name: "Local destination",
      type: "local",
      path: localRoot,
      config: {},
      machine_id: machine.id,
    });
    const googleSource = createSource({
      name: "Drive",
      type: "google_drive",
      machine_id: machine.id,
      config: {
        profile: "personal",
        include_my_drive: true,
        include_all_shared_drives: false,
        destination_source_id: localSource.id,
        delete_behavior: "mark_deleted",
      },
    });
    let files = [file("doc-1", "todo.txt", undefined, "text/plain")];
    setGoogleDriveClientFactoryForTests(() => new MockDriveClient(() => ({ files })));

    await syncGoogleDriveSource(googleSource);
    const storedPath = join(localRoot, "google-drive/personal/my-drive/todo.txt");
    expect(existsSync(storedPath)).toBe(true);
    expect(readFileSync(storedPath, "utf8")).toBe("data:doc-1");
    const indexed = listFiles({ source_id: localSource.id });
    expect(indexed[0]?.path).toBe("google-drive/personal/my-drive/todo.txt");

    files = [];
    const deleteStats = await syncGoogleDriveSource(googleSource);

    expect(deleteStats.deleted).toBe(1);
    expect(getFile(indexed[0]!.id)?.status).toBe("deleted");
    const imports = listGoogleDriveImportedObjects(googleSource.id);
    expect(imports[0]).toMatchObject({
      storage_type: "local",
      storage_key: "google-drive/personal/my-drive/todo.txt",
      destination_source_id: localSource.id,
      deleted: true,
    });
  });

  test("uses configured default destination source when Google Drive source omits one", async () => {
    const machine = getCurrentMachine();
    const localRoot = join(testDir, "configured-local-destination");
    const localSource = createSource({
      name: "Configured local",
      type: "local",
      path: localRoot,
      config: {},
      machine_id: machine.id,
    });
    saveConfig({ ...loadConfig(), google_drive_default_destination_source_id: localSource.id });
    const googleSource = createSource({
      name: "Drive",
      type: "google_drive",
      machine_id: machine.id,
      config: {
        profile: "personal",
        include_my_drive: true,
        include_all_shared_drives: false,
        delete_behavior: "ignore",
      },
    });
    setGoogleDriveClientFactoryForTests(() => new MockDriveClient(() => ({
      files: [file("doc-1", "configured.txt", undefined, "text/plain")],
    })));

    await syncGoogleDriveSource(googleSource);

    expect(listFiles({ source_id: localSource.id })[0]?.path).toBe("google-drive/personal/my-drive/configured.txt");
  });
});

function folder(id: string, name: string, parent?: string): GoogleDriveApiFile {
  return file(id, name, parent, GOOGLE_FOLDER_MIME);
}

function file(
  id: string,
  name: string,
  parent: string | undefined,
  mimeType: string,
  overrides: Partial<GoogleDriveApiFile> = {},
): GoogleDriveApiFile {
  return {
    id,
    name,
    mimeType,
    parents: parent ? [parent] : undefined,
    modifiedTime: "2026-04-24T09:00:00.000Z",
    size: "10",
    ...overrides,
  };
}
