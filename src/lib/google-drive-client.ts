import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import type { GoogleDriveExportFormats } from "../types/index.js";

const DRIVE_API_BASE = "https://www.googleapis.com/drive/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const PROFILE_REFRESH_BUFFER_MS = 5 * 60 * 1000;

export const GOOGLE_FOLDER_MIME = "application/vnd.google-apps.folder";

const DEFAULT_EXPORT_FORMATS: Required<GoogleDriveExportFormats> = {
  document: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  spreadsheet: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  presentation: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  drawing: "image/png",
};

const EXPORT_EXTENSIONS: Record<string, string> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/pdf": ".pdf",
  "text/plain": ".txt",
  "text/csv": ".csv",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/svg+xml": ".svg",
};

export interface GoogleDriveApiFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  version?: string;
  md5Checksum?: string;
  size?: string;
  modifiedTime?: string;
}

export interface GoogleDriveApiSharedDrive {
  id: string;
  name: string;
}

export interface GoogleDriveListFilesOptions {
  pageSize?: number;
  pageToken?: string;
  q?: string;
  fields?: string;
  orderBy?: string;
  corpora?: "user" | "drive" | "allDrives";
  driveId?: string;
  supportsAllDrives?: boolean;
  includeItemsFromAllDrives?: boolean;
}

export interface GoogleDriveListSharedDrivesOptions {
  pageSize?: number;
  pageToken?: string;
  q?: string;
}

export interface GoogleDriveDownloadedFile {
  data: ArrayBuffer;
  filename: string;
  mimeType: string;
}

export interface GoogleDriveClient {
  listFiles(options: GoogleDriveListFilesOptions): Promise<{ files: GoogleDriveApiFile[]; nextPageToken?: string }>;
  listSharedDrives(options?: GoogleDriveListSharedDrivesOptions): Promise<{ drives: GoogleDriveApiSharedDrive[]; nextPageToken?: string }>;
  downloadFile(file: GoogleDriveApiFile, exportFormats?: GoogleDriveExportFormats): Promise<GoogleDriveDownloadedFile>;
}

interface OAuth2Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

interface OAuthCredentials {
  clientId?: string;
  clientSecret?: string;
}

export function listGoogleDriveProfilesFromConnectorConfig(): string[] {
  const profilesDir = getProfilesDir();
  if (!existsSync(profilesDir)) return [];

  const profiles = new Set<string>();
  for (const entry of readdirSync(profilesDir, { withFileTypes: true })) {
    if (entry.isDirectory()) profiles.add(entry.name);
    if (entry.isFile() && entry.name.endsWith(".json")) profiles.add(basename(entry.name, ".json"));
  }
  return Array.from(profiles).sort((a, b) => a.localeCompare(b));
}

export function createConnectorProfileGoogleDriveClient(profile: string): GoogleDriveClient {
  return new ConnectorProfileGoogleDriveClient(profile);
}

class ConnectorProfileGoogleDriveClient implements GoogleDriveClient {
  constructor(private readonly profile: string) {}

  async listFiles(options: GoogleDriveListFilesOptions): Promise<{ files: GoogleDriveApiFile[]; nextPageToken?: string }> {
    return this.getJson("/files", {
      pageSize: options.pageSize ?? 1000,
      pageToken: options.pageToken,
      q: options.q,
      fields: options.fields,
      orderBy: options.orderBy,
      corpora: options.corpora,
      driveId: options.driveId,
      supportsAllDrives: options.supportsAllDrives ?? true,
      includeItemsFromAllDrives: options.includeItemsFromAllDrives ?? false,
    });
  }

  async listSharedDrives(options: GoogleDriveListSharedDrivesOptions = {}): Promise<{ drives: GoogleDriveApiSharedDrive[]; nextPageToken?: string }> {
    return this.getJson("/drives", {
      pageSize: options.pageSize ?? 100,
      pageToken: options.pageToken,
      q: options.q,
    });
  }

  async downloadFile(file: GoogleDriveApiFile, exportFormats: GoogleDriveExportFormats = {}): Promise<GoogleDriveDownloadedFile> {
    if (file.mimeType.startsWith("application/vnd.google-apps.")) {
      const exportMimeType = getExportMimeType(file.mimeType, exportFormats);
      const data = await this.getBinary(`/files/${encodeURIComponent(file.id)}/export`, {
        mimeType: exportMimeType,
        supportsAllDrives: true,
      });
      return {
        data,
        filename: `${file.name}${getExtensionForMimeType(exportMimeType)}`,
        mimeType: exportMimeType,
      };
    }

    const data = await this.getBinary(`/files/${encodeURIComponent(file.id)}`, {
      alt: "media",
      supportsAllDrives: true,
    });
    return {
      data,
      filename: file.name,
      mimeType: file.mimeType || "application/octet-stream",
    };
  }

  private async getJson<T>(path: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
    const response = await this.request(path, params);
    const text = await response.text();
    return text ? JSON.parse(text) as T : {} as T;
  }

  private async getBinary(path: string, params: Record<string, string | number | boolean | undefined>): Promise<ArrayBuffer> {
    const response = await this.request(path, params);
    return response.arrayBuffer();
  }

  private async request(path: string, params: Record<string, string | number | boolean | undefined>): Promise<Response> {
    const token = await getValidAccessToken(this.profile);
    const url = new URL(`${DRIVE_API_BASE}${path}`);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Google Drive request failed (${response.status}): ${extractGoogleError(body) || response.statusText}`);
    }
    return response;
  }
}

async function getValidAccessToken(profile: string): Promise<string> {
  const envToken = process.env.GOOGLE_ACCESS_TOKEN;
  if (envToken) return envToken;

  const tokens = loadTokens(profile);
  if (!tokens?.accessToken && !tokens?.refreshToken) {
    throw new Error(`Google Drive profile "${profile}" is not authenticated. Run: connectors auth googledrive`);
  }

  if (!tokens.expiresAt || Date.now() < tokens.expiresAt - PROFILE_REFRESH_BUFFER_MS) {
    return tokens.accessToken;
  }

  if (!tokens.refreshToken) return tokens.accessToken;
  return (await refreshAccessToken(profile, tokens)).accessToken;
}

async function refreshAccessToken(profile: string, currentTokens: OAuth2Tokens): Promise<OAuth2Tokens> {
  const credentials = loadCredentials(profile);
  if (!credentials.clientId || !credentials.clientSecret) {
    throw new Error("Google Drive OAuth credentials are not configured. Run: connectors auth googledrive");
  }
  if (!currentTokens.refreshToken) {
    throw new Error(`Google Drive profile "${profile}" has no refresh token. Run: connectors auth googledrive`);
  }

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: currentTokens.refreshToken,
      grant_type: "refresh_token",
    }),
  });

  const data = await response.json().catch(() => ({})) as {
    access_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !data.access_token) {
    throw new Error(`Google Drive token refresh failed: ${data.error_description || data.error || response.statusText}`);
  }

  const tokens: OAuth2Tokens = {
    accessToken: data.access_token,
    refreshToken: currentTokens.refreshToken,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    tokenType: data.token_type ?? currentTokens.tokenType,
    scope: data.scope ?? currentTokens.scope,
  };
  saveTokens(profile, tokens);
  return tokens;
}

function getExportMimeType(googleMimeType: string, exportFormats: GoogleDriveExportFormats): string {
  if (googleMimeType.endsWith(".document")) return exportFormats.document ?? DEFAULT_EXPORT_FORMATS.document;
  if (googleMimeType.endsWith(".spreadsheet")) return exportFormats.spreadsheet ?? DEFAULT_EXPORT_FORMATS.spreadsheet;
  if (googleMimeType.endsWith(".presentation")) return exportFormats.presentation ?? DEFAULT_EXPORT_FORMATS.presentation;
  if (googleMimeType.endsWith(".drawing")) return exportFormats.drawing ?? DEFAULT_EXPORT_FORMATS.drawing;
  throw new Error(`Cannot export Google Workspace file type: ${googleMimeType}`);
}

function getExtensionForMimeType(mimeType: string): string {
  return EXPORT_EXTENSIONS[mimeType] ?? "";
}

function extractGoogleError(body: string): string {
  if (!body) return "";
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } };
    return parsed.error?.message ?? body;
  } catch {
    return body;
  }
}

function loadCredentials(profile: string): OAuthCredentials {
  const envClientId = process.env.GOOGLE_CLIENT_ID;
  const envClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (envClientId && envClientSecret) return { clientId: envClientId, clientSecret: envClientSecret };

  return {
    ...readJson<OAuthCredentials>(join(getConnectorConfigDir(), "credentials.json")),
    ...readJson<OAuthCredentials>(join(getProfileDir(profile), "config.json")),
  };
}

function loadTokens(profile: string): OAuth2Tokens | null {
  const fromProfile = readJson<OAuth2Tokens>(join(getProfileDir(profile), "tokens.json"));
  if (fromProfile) return fromProfile;

  const flat = readJson<{ tokens?: OAuth2Tokens } & OAuth2Tokens>(join(getProfilesDir(), `${profile}.json`));
  if (!flat) return null;
  return flat.tokens ?? (flat.accessToken ? flat : null);
}

function saveTokens(profile: string, tokens: OAuth2Tokens): void {
  const profileDir = getProfileDir(profile);
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "tokens.json"), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function getConnectorConfigDir(): string {
  const explicit = process.env.HASNA_GOOGLE_DRIVE_CONNECTOR_DIR ?? process.env.GOOGLE_DRIVE_CONNECTOR_DIR;
  if (explicit) return explicit;

  const baseDir = process.env.HASNA_CONNECTORS_DIR ?? join(homedir(), ".hasna", "connectors");
  return join(baseDir, "googledrive");
}

function getProfilesDir(): string {
  return join(getConnectorConfigDir(), "profiles");
}

function getProfileDir(profile: string): string {
  return join(getProfilesDir(), profile);
}
