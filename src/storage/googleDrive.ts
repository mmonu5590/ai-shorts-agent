/**
 * Google Drive implementation of {@link StorageAdapter}.
 *
 * Drive has no paths. It has a folder graph addressed by opaque file IDs, and
 * sibling names are not unique — two folders called `jobs` can coexist under the
 * same parent. This adapter imposes path semantics on top of that:
 *
 *   - Every key is resolved segment by segment from `rootFolderId`.
 *   - Folder IDs are memoised, because resolving `jobs/<id>/shorts/clip-01.mp4`
 *     is otherwise four round trips on every call.
 *   - When a name collides, the oldest matching file wins, so concurrent
 *     workers that race to create `jobs/` converge on the same folder instead
 *     of forking the tree.
 *
 * The Drive client is injected rather than constructed, so tests run without
 * credentials or network. See {@link googleDriveStorageFromEnv} for wiring.
 */

import type { Readable } from "node:stream";
import {
  type GetOptions,
  type PutOptions,
  type SignedUrl,
  type SignedUrlOptions,
  type StorageAdapter,
  type StorageKey,
  type StorageObject,
  StorageConfigError,
  StorageError,
  StorageNotFoundError,
  normalizeKey,
  splitKey,
} from "./types.ts";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/** The subset of `drive_v3.Drive` this adapter uses. */
export interface DriveClientLike {
  files: {
    list(params: Record<string, unknown>): Promise<{ data: DriveFileList }>;
    get(params: Record<string, unknown>, options?: Record<string, unknown>): Promise<{ data: unknown }>;
    create(params: Record<string, unknown>): Promise<{ data: DriveFile }>;
    update(params: Record<string, unknown>): Promise<{ data: DriveFile }>;
    delete(params: Record<string, unknown>): Promise<unknown>;
  };
  permissions: {
    create(params: Record<string, unknown>): Promise<unknown>;
  };
}

interface DriveFile {
  id?: string | null;
  name?: string | null;
  mimeType?: string | null;
  size?: string | null;
  modifiedTime?: string | null;
  webContentLink?: string | null;
  createdTime?: string | null;
}

interface DriveFileList {
  files?: DriveFile[];
}

export interface GoogleDriveStorageOptions {
  drive: DriveClientLike;
  /** Folder ID that becomes the storage root. Every key resolves beneath it. */
  rootFolderId: string;
  /**
   * Set when `rootFolderId` lives in a Shared Drive. Required for service-account
   * auth: a service account has no Drive quota of its own, so uploads into a
   * personal My Drive fail with `storageQuotaExceeded`.
   */
  driveId?: string;
  /**
   * Allows {@link GoogleDriveStorage.signedUrl} to grant `anyone with the link`
   * read access. Off by default — it makes the file world-readable to anyone
   * holding the URL, and Drive links cannot be time-limited.
   */
  allowPublicLinks?: boolean;
}

/** Escapes a value for interpolation into a Drive `q` query string. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function toStorageObject(key: string, file: DriveFile): StorageObject {
  if (!file.id) {
    throw new StorageError(`Drive returned a file without an ID for key "${key}"`);
  }
  return {
    key,
    size: file.size == null ? null : Number(file.size),
    contentType: file.mimeType ?? null,
    modifiedAt: file.modifiedTime ? new Date(file.modifiedTime) : null,
    nativeId: file.id,
  };
}

/** True when the Drive API rejected a lookup because the resource is absent. */
function isNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown; status?: unknown })?.code ?? (error as { status?: unknown })?.status;
  return code === 404 || code === "404";
}

export class GoogleDriveStorage implements StorageAdapter {
  readonly name = "google-drive";

  readonly #drive: DriveClientLike;
  readonly #rootFolderId: string;
  readonly #driveId: string | undefined;
  readonly #allowPublicLinks: boolean;
  /** Maps a normalised folder key to its Drive ID. `""` is the root. */
  readonly #folderIds = new Map<string, string>();

  constructor(options: GoogleDriveStorageOptions) {
    if (!options.rootFolderId) {
      throw new StorageConfigError("GoogleDriveStorage requires a rootFolderId");
    }
    this.#drive = options.drive;
    this.#rootFolderId = options.rootFolderId;
    this.#driveId = options.driveId;
    this.#allowPublicLinks = options.allowPublicLinks ?? false;
    this.#folderIds.set("", options.rootFolderId);
  }

  /** Shared-drive parameters. Drive ignores these on My Drive, so always send them. */
  get #driveScope(): Record<string, unknown> {
    return this.#driveId
      ? { supportsAllDrives: true, includeItemsFromAllDrives: true, corpora: "drive", driveId: this.#driveId }
      : { supportsAllDrives: true, includeItemsFromAllDrives: true };
  }

  /**
   * Finds the single child of `parentId` named `name`.
   *
   * Drive permits duplicate sibling names, so this deliberately sorts by
   * creation time and takes the oldest: every worker racing on the same key
   * then agrees on one file rather than picking whichever came back first.
   */
  async #findChild(parentId: string, name: string, folderOnly: boolean): Promise<DriveFile | null> {
    const clauses = [`${quote(parentId)} in parents`, `name = ${quote(name)}`, "trashed = false"];
    if (folderOnly) {
      clauses.push(`mimeType = ${quote(FOLDER_MIME)}`);
    }
    const response = await this.#drive.files.list({
      q: clauses.join(" and "),
      fields: "files(id,name,mimeType,size,modifiedTime,createdTime)",
      orderBy: "createdTime",
      pageSize: 1,
      ...this.#driveScope,
    });
    return response.data.files?.[0] ?? null;
  }

  /**
   * Resolves the folder chain for `segments`, creating missing folders when
   * `create` is set. Returns null when a folder is missing and `create` is not.
   */
  async #resolveFolder(segments: string[], create: boolean): Promise<string | null> {
    let parentId = this.#rootFolderId;
    let cacheKey = "";

    for (const segment of segments) {
      cacheKey = cacheKey === "" ? segment : `${cacheKey}/${segment}`;
      const cached = this.#folderIds.get(cacheKey);
      if (cached !== undefined) {
        parentId = cached;
        continue;
      }

      let folder = await this.#findChild(parentId, segment, true);
      if (!folder) {
        if (!create) {
          return null;
        }
        const created = await this.#drive.files.create({
          requestBody: { name: segment, mimeType: FOLDER_MIME, parents: [parentId] },
          fields: "id,name,mimeType,createdTime",
          supportsAllDrives: true,
        });
        // Re-read rather than trusting the create: a concurrent worker may have
        // created the same folder, and #findChild's oldest-wins rule is what
        // makes both workers converge on one ID.
        folder = (await this.#findChild(parentId, segment, true)) ?? created.data;
      }

      if (!folder.id) {
        throw new StorageError(`Drive folder "${segment}" has no ID`);
      }
      this.#folderIds.set(cacheKey, folder.id);
      parentId = folder.id;
    }

    return parentId;
  }

  /** Resolves the Drive file for `key`, or null when any path component is missing. */
  async #resolveFile(key: StorageKey): Promise<DriveFile | null> {
    const segments = splitKey(key);
    const filename = segments.at(-1) as string;
    const parentId = await this.#resolveFolder(segments.slice(0, -1), false);
    if (parentId === null) {
      return null;
    }
    return this.#findChild(parentId, filename, false);
  }

  async put(key: StorageKey, body: Readable, options: PutOptions = {}): Promise<StorageObject> {
    const normalized = normalizeKey(key);
    const segments = splitKey(normalized);
    const filename = segments.at(-1) as string;
    const parentId = await this.#resolveFolder(segments.slice(0, -1), true);
    if (parentId === null) {
      throw new StorageError(`Could not resolve parent folder for "${normalized}"`);
    }

    const mimeType = options.contentType ?? "application/octet-stream";
    const media = { mimeType, body };
    const fields = "id,name,mimeType,size,modifiedTime";
    const existing = await this.#findChild(parentId, filename, false);

    // googleapis switches to a resumable upload on its own for large streams,
    // which is what keeps multi-GB source videos off the heap.
    const response = existing?.id
      ? await this.#drive.files.update({
          fileId: existing.id,
          media,
          requestBody: { name: filename },
          fields,
          supportsAllDrives: true,
        })
      : await this.#drive.files.create({
          media,
          requestBody: { name: filename, parents: [parentId] },
          fields,
          supportsAllDrives: true,
        });

    return toStorageObject(normalized, response.data);
  }

  async get(key: StorageKey, options: GetOptions = {}): Promise<Readable> {
    const normalized = normalizeKey(key);
    const file = await this.#resolveFile(normalized);
    if (!file?.id) {
      throw new StorageNotFoundError(normalized);
    }

    const headers: Record<string, string> = {};
    if (options.range) {
      const { start, end } = options.range;
      headers["Range"] = `bytes=${start}-${end ?? ""}`;
    }

    try {
      const response = await this.#drive.files.get(
        { fileId: file.id, alt: "media", supportsAllDrives: true },
        { responseType: "stream", headers },
      );
      return response.data as Readable;
    } catch (error) {
      if (isNotFound(error)) {
        throw new StorageNotFoundError(normalized);
      }
      throw new StorageError(`Failed to read "${normalized}" from Drive`, { cause: error });
    }
  }

  async stat(key: StorageKey): Promise<StorageObject | null> {
    const normalized = normalizeKey(key);
    const file = await this.#resolveFile(normalized);
    return file ? toStorageObject(normalized, file) : null;
  }

  /**
   * Drive cannot mint time-limited URLs. The only link that works for an
   * unauthenticated client requires granting `anyone with the link` read access,
   * which is permanent until revoked — hence the opt-in and the null expiry.
   */
  async signedUrl(key: StorageKey, _options: SignedUrlOptions = {}): Promise<SignedUrl> {
    const normalized = normalizeKey(key);
    if (!this.#allowPublicLinks) {
      throw new StorageError(
        `Refusing to create a public link for "${normalized}". Google Drive links cannot expire, ` +
          `so enable allowPublicLinks (DRIVE_ALLOW_PUBLIC_LINKS=true) only if a permanent ` +
          `anyone-with-the-link URL is acceptable; otherwise proxy the bytes through your API using get().`,
      );
    }

    const file = await this.#resolveFile(normalized);
    if (!file?.id) {
      throw new StorageNotFoundError(normalized);
    }

    await this.#drive.permissions.create({
      fileId: file.id,
      requestBody: { role: "reader", type: "anyone" },
      supportsAllDrives: true,
    });

    const refreshed = (await this.#drive.files.get({
      fileId: file.id,
      fields: "webContentLink",
      supportsAllDrives: true,
    })) as { data: DriveFile };

    const url = refreshed.data.webContentLink;
    if (!url) {
      throw new StorageError(`Drive did not return a download link for "${normalized}"`);
    }
    return { url, expiresAt: null };
  }

  async list(prefix: StorageKey): Promise<StorageObject[]> {
    const normalized = normalizeKey(prefix);
    const folderId = await this.#resolveFolder(splitKey(normalized), false);
    if (folderId === null) {
      return [];
    }

    const results: StorageObject[] = [];
    let pageToken: string | undefined;
    do {
      const response: { data: DriveFileList & { nextPageToken?: string | null } } = await this.#drive.files.list({
        q: `${quote(folderId)} in parents and trashed = false`,
        fields: "nextPageToken, files(id,name,mimeType,size,modifiedTime)",
        pageSize: 100,
        ...(pageToken ? { pageToken } : {}),
        ...this.#driveScope,
      });
      for (const file of response.data.files ?? []) {
        if (file.name) {
          results.push(toStorageObject(`${normalized}/${file.name}`, file));
        }
      }
      pageToken = response.data.nextPageToken ?? undefined;
    } while (pageToken);

    return results;
  }

  async delete(key: StorageKey): Promise<void> {
    const normalized = normalizeKey(key);
    const file = await this.#resolveFile(normalized);
    if (!file?.id) {
      return;
    }
    try {
      await this.#drive.files.delete({ fileId: file.id, supportsAllDrives: true });
    } catch (error) {
      if (!isNotFound(error)) {
        throw new StorageError(`Failed to delete "${normalized}" from Drive`, { cause: error });
      }
    }
  }

  async deletePrefix(prefix: StorageKey): Promise<void> {
    const normalized = normalizeKey(prefix);
    const segments = splitKey(normalized);
    const folderId = await this.#resolveFolder(segments, false);
    if (folderId === null) {
      return;
    }
    try {
      // Trashing the folder takes its whole subtree with it, so there is no
      // need to walk children individually.
      await this.#drive.files.delete({ fileId: folderId, supportsAllDrives: true });
    } catch (error) {
      if (!isNotFound(error)) {
        throw new StorageError(`Failed to delete prefix "${normalized}" from Drive`, { cause: error });
      }
    }
    for (const cached of this.#folderIds.keys()) {
      if (cached === normalized || cached.startsWith(`${normalized}/`)) {
        this.#folderIds.delete(cached);
      }
    }
  }
}
