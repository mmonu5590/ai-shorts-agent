/**
 * Filesystem implementation of {@link StorageAdapter}.
 *
 * Used for local development and as the reference the Drive adapter is expected
 * to behave like. Keys map directly onto paths beneath `rootDir`; `splitKey`
 * has already rejected anything that could escape it.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat as fsStat } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import {
  type GetOptions,
  type PutOptions,
  type SignedUrl,
  type SignedUrlOptions,
  type StorageAdapter,
  type StorageKey,
  type StorageObject,
  StorageError,
  StorageNotFoundError,
  normalizeKey,
  splitKey,
} from "./types.ts";

export interface LocalStorageOptions {
  rootDir: string;
}

export class LocalStorage implements StorageAdapter {
  readonly name = "local";
  readonly #rootDir: string;

  constructor(options: LocalStorageOptions) {
    this.#rootDir = path.resolve(options.rootDir);
  }

  #pathFor(key: StorageKey): string {
    return path.join(this.#rootDir, ...splitKey(key));
  }

  async #toObject(key: string, absolutePath: string): Promise<StorageObject> {
    const stats = await fsStat(absolutePath);
    return {
      key,
      size: stats.size,
      contentType: null,
      modifiedAt: stats.mtime,
      nativeId: absolutePath,
    };
  }

  async put(key: StorageKey, body: Readable, _options: PutOptions = {}): Promise<StorageObject> {
    const normalized = normalizeKey(key);
    const absolutePath = this.#pathFor(normalized);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await pipeline(body, createWriteStream(absolutePath));
    return this.#toObject(normalized, absolutePath);
  }

  async get(key: StorageKey, options: GetOptions = {}): Promise<Readable> {
    const normalized = normalizeKey(key);
    const absolutePath = this.#pathFor(normalized);
    if (!(await this.stat(normalized))) {
      throw new StorageNotFoundError(normalized);
    }
    return options.range
      ? createReadStream(absolutePath, {
          start: options.range.start,
          ...(options.range.end === undefined ? {} : { end: options.range.end }),
        })
      : createReadStream(absolutePath);
  }

  async stat(key: StorageKey): Promise<StorageObject | null> {
    const normalized = normalizeKey(key);
    const absolutePath = this.#pathFor(normalized);
    try {
      const stats = await fsStat(absolutePath);
      if (!stats.isFile()) {
        return null;
      }
      return this.#toObject(normalized, absolutePath);
    } catch {
      return null;
    }
  }

  async signedUrl(key: StorageKey, _options: SignedUrlOptions = {}): Promise<SignedUrl> {
    throw new StorageError(
      `LocalStorage cannot mint URLs for "${normalizeKey(key)}"; serve the bytes from your API using get()`,
    );
  }

  async list(prefix: StorageKey): Promise<StorageObject[]> {
    const normalized = normalizeKey(prefix);
    const absolutePath = this.#pathFor(normalized);
    let entries;
    try {
      entries = await readdir(absolutePath, { withFileTypes: true });
    } catch {
      return [];
    }
    const objects: StorageObject[] = [];
    for (const entry of entries) {
      if (entry.isFile()) {
        objects.push(await this.#toObject(`${normalized}/${entry.name}`, path.join(absolutePath, entry.name)));
      }
    }
    return objects;
  }

  async delete(key: StorageKey): Promise<void> {
    await rm(this.#pathFor(normalizeKey(key)), { force: true });
  }

  async deletePrefix(prefix: StorageKey): Promise<void> {
    await rm(this.#pathFor(normalizeKey(prefix)), { force: true, recursive: true });
  }
}
