/**
 * Storage wiring. The pipeline depends on {@link StorageAdapter}; only this
 * module knows which backend is configured.
 */

import { google } from "googleapis";
import { GoogleDriveStorage, type DriveClientLike } from "./googleDrive.ts";
import { LocalStorage } from "./local.ts";
import { type StorageAdapter, StorageConfigError } from "./types.ts";

export * from "./types.ts";
export { GoogleDriveStorage } from "./googleDrive.ts";
export { LocalStorage } from "./local.ts";

/** Full Drive scope. The adapter creates folders, so metadata-only is not enough. */
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new StorageConfigError(`Missing required environment variable ${name}`);
  }
  return value;
}

/**
 * Builds an authenticated Drive client.
 *
 * Credentials come from `GOOGLE_SERVICE_ACCOUNT_KEY` (inline JSON) when set,
 * otherwise from Application Default Credentials, which picks up
 * `GOOGLE_APPLICATION_CREDENTIALS`.
 */
export function createDriveClient(): DriveClientLike {
  const inlineKey = process.env["GOOGLE_SERVICE_ACCOUNT_KEY"];

  if (inlineKey) {
    let credentials: { client_email?: string; private_key?: string };
    try {
      credentials = JSON.parse(inlineKey) as typeof credentials;
    } catch (error) {
      throw new StorageConfigError(
        `GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON: ${(error as Error).message}`,
      );
    }
    if (!credentials.client_email || !credentials.private_key) {
      throw new StorageConfigError(
        "GOOGLE_SERVICE_ACCOUNT_KEY must contain client_email and private_key",
      );
    }
    const auth = new google.auth.JWT({
      email: credentials.client_email,
      // Newline-escaped keys are what you get when the JSON is pasted into a
      // dashboard env var, so undo that before handing it to the JWT client.
      key: credentials.private_key.replace(/\\n/g, "\n"),
      scopes: [DRIVE_SCOPE],
    });
    return google.drive({ version: "v3", auth }) as unknown as DriveClientLike;
  }

  const auth = new google.auth.GoogleAuth({ scopes: [DRIVE_SCOPE] });
  return google.drive({ version: "v3", auth }) as unknown as DriveClientLike;
}

/**
 * Constructs the Drive adapter from environment configuration.
 *
 * Service accounts have no Drive storage quota of their own. Uploading into a
 * personal My Drive folder therefore fails at runtime with
 * `storageQuotaExceeded` — the folder must live in a Shared Drive. That failure
 * only shows up on the first upload, so it is checked here instead.
 */
export function googleDriveStorageFromEnv(): GoogleDriveStorage {
  const rootFolderId = required("DRIVE_ROOT_FOLDER_ID");
  const driveId = process.env["DRIVE_SHARED_DRIVE_ID"];
  const usingServiceAccount = Boolean(
    process.env["GOOGLE_SERVICE_ACCOUNT_KEY"] ?? process.env["GOOGLE_APPLICATION_CREDENTIALS"],
  );

  if (usingServiceAccount && !driveId && process.env["DRIVE_ALLOW_MY_DRIVE"] !== "true") {
    throw new StorageConfigError(
      "Service-account credentials with no DRIVE_SHARED_DRIVE_ID. A service account has no Drive " +
        "storage quota, so uploads into a personal My Drive folder fail with storageQuotaExceeded. " +
        "Put DRIVE_ROOT_FOLDER_ID inside a Shared Drive and set DRIVE_SHARED_DRIVE_ID, or use OAuth " +
        "user credentials. Set DRIVE_ALLOW_MY_DRIVE=true to bypass this check.",
    );
  }

  return new GoogleDriveStorage({
    drive: createDriveClient(),
    rootFolderId,
    ...(driveId ? { driveId } : {}),
    allowPublicLinks: process.env["DRIVE_ALLOW_PUBLIC_LINKS"] === "true",
  });
}

/** Selects a backend from `STORAGE_DRIVER`. Defaults to `local`. */
export function createStorage(): StorageAdapter {
  const driver = process.env["STORAGE_DRIVER"] ?? "local";
  switch (driver) {
    case "google-drive":
      return googleDriveStorageFromEnv();
    case "local":
      return new LocalStorage({ rootDir: process.env["LOCAL_STORAGE_DIR"] ?? ".data/storage" });
    default:
      throw new StorageConfigError(`Unknown STORAGE_DRIVER "${driver}" (expected "local" or "google-drive")`);
  }
}

/** Canonical key layout for a pipeline job, so producers and consumers agree. */
export const jobKeys = {
  root: (jobId: string) => `jobs/${jobId}`,
  source: (jobId: string, extension: string) => `jobs/${jobId}/source.${extension}`,
  audio: (jobId: string) => `jobs/${jobId}/audio.wav`,
  metadata: (jobId: string) => `jobs/${jobId}/metadata.json`,
  transcript: (jobId: string) => `jobs/${jobId}/transcript.json`,
  editPlan: (jobId: string) => `jobs/${jobId}/edit-plan.json`,
  shorts: (jobId: string) => `jobs/${jobId}/shorts`,
  short: (jobId: string, index: number) =>
    `jobs/${jobId}/shorts/clip-${String(index).padStart(2, "0")}.mp4`,
} as const;
