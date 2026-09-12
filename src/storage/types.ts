/**
 * Provider-neutral storage interface.
 *
 * The pipeline addresses everything by POSIX-style key ("jobs/<id>/source.mp4").
 * Adapters map that key onto whatever their backend actually uses — a filesystem
 * path, an object key, or (for Drive) a chain of folder IDs.
 *
 * Video files are large, so every transfer is a stream. No adapter method may
 * buffer a whole media file in memory.
 */

import type { Readable } from "node:stream";

/** A POSIX-style storage key, e.g. `jobs/abc123/source.mp4`. No leading slash. */
export type StorageKey = string;

export interface StorageObject {
  key: StorageKey;
  /** Size in bytes. Null when the backend does not report one. */
  size: number | null;
  contentType: string | null;
  modifiedAt: Date | null;
  /** Backend-native identifier (Drive file ID, absolute path). Opaque to callers. */
  nativeId: string;
}

export interface PutOptions {
  contentType?: string;
  /** Total byte length when known. Lets Drive pick resumable vs. simple upload. */
  contentLength?: number;
}

export interface GetOptions {
  /** Inclusive byte range, as in HTTP Range. Used to stream partial media. */
  range?: { start: number; end?: number };
}

export interface SignedUrlOptions {
  /** Requested lifetime. Backends that cannot honour it report what they did. */
  expiresInSeconds?: number;
}

export interface SignedUrl {
  url: string;
  /** Null when the link does not expire — check this before handing it to a client. */
  expiresAt: Date | null;
}

export interface StorageAdapter {
  readonly name: string;

  /** Streams `body` to `key`, creating parent folders as needed. Overwrites. */
  put(key: StorageKey, body: Readable, options?: PutOptions): Promise<StorageObject>;

  /** Opens `key` for reading. Throws {@link StorageNotFoundError} if absent. */
  get(key: StorageKey, options?: GetOptions): Promise<Readable>;

  /** Metadata without transferring content. Null when `key` does not exist. */
  stat(key: StorageKey): Promise<StorageObject | null>;

  /** Direct-download URL for a client. Throws if the backend cannot mint one. */
  signedUrl(key: StorageKey, options?: SignedUrlOptions): Promise<SignedUrl>;

  /** Immediate children of `prefix`, non-recursive. */
  list(prefix: StorageKey): Promise<StorageObject[]>;

  /** Removes `key`. Succeeds silently when already absent. */
  delete(key: StorageKey): Promise<void>;

  /** Removes `prefix` and everything under it. Succeeds silently when absent. */
  deletePrefix(prefix: StorageKey): Promise<void>;
}

export class StorageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "StorageError";
  }
}

export class StorageNotFoundError extends StorageError {
  readonly key: StorageKey;

  constructor(key: StorageKey) {
    super(`No storage object at key "${key}"`);
    this.name = "StorageNotFoundError";
    this.key = key;
  }
}

export class StorageConfigError extends StorageError {
  constructor(message: string) {
    super(message);
    this.name = "StorageConfigError";
  }
}

const SEGMENT_PATTERN = /^[^/\\]+$/u;

/**
 * Validates a key and splits it into segments.
 *
 * Rejects absolute keys, empty segments, and `.`/`..` so a caller-supplied key
 * can never escape the configured storage root.
 */
export function splitKey(key: StorageKey): string[] {
  if (typeof key !== "string" || key.length === 0) {
    throw new StorageError("Storage key must be a non-empty string");
  }
  if (key.startsWith("/")) {
    throw new StorageError(`Storage key must be relative, got "${key}"`);
  }
  const segments = key.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new StorageError(`Storage key has no usable segments: "${key}"`);
  }
  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new StorageError(`Storage key may not contain "${segment}": "${key}"`);
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new StorageError(`Illegal segment "${segment}" in key "${key}"`);
    }
  }
  return segments;
}

/** Canonical key form: no leading, trailing, or repeated slashes. */
export function normalizeKey(key: StorageKey): string {
  return splitKey(key).join("/");
}
