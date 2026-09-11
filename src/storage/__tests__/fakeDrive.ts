/**
 * In-memory stand-in for the Drive v3 API.
 *
 * Reproduces the two behaviours the adapter is built around: files are addressed
 * by opaque ID rather than path, and sibling names are allowed to collide.
 */

import { Readable } from "node:stream";
import type { DriveClientLike } from "../googleDrive.ts";

interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  content: Buffer;
  createdTime: string;
  modifiedTime: string;
  trashed: boolean;
  anyoneReader: boolean;
}

const FOLDER_MIME = "application/vnd.google-apps.folder";

async function drain(body: unknown): Promise<Buffer> {
  if (body instanceof Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk as Buffer));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.from(String(body ?? ""));
}

/** Parses only the `q` shapes the adapter emits. */
function parseQuery(q: string): { parent?: string; name?: string; folderOnly: boolean } {
  const parent = /'((?:[^'\\]|\\.)*)' in parents/u.exec(q)?.[1];
  const name = /name = '((?:[^'\\]|\\.)*)'/u.exec(q)?.[1];
  const unescape = (value: string) => value.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  return {
    ...(parent === undefined ? {} : { parent: unescape(parent) }),
    ...(name === undefined ? {} : { name: unescape(name) }),
    folderOnly: q.includes(FOLDER_MIME),
  };
}

export class FakeDrive implements DriveClientLike {
  readonly files: DriveClientLike["files"];
  readonly permissions: DriveClientLike["permissions"];

  #store = new Map<string, FakeFile>();
  #nextId = 1;
  #clock = 0;
  /** Every `files.list` query, so tests can assert on caching behaviour. */
  listCalls: string[] = [];

  readonly rootId: string;

  constructor(rootId = "root-folder") {
    this.rootId = rootId;
    this.files = {
      list: this.#list.bind(this),
      get: this.#get.bind(this),
      create: this.#create.bind(this),
      update: this.#update.bind(this),
      delete: this.#delete.bind(this),
    };
    this.permissions = { create: this.#createPermission.bind(this) };
  }

  #timestamp(): string {
    this.#clock += 1000;
    return new Date(this.#clock).toISOString();
  }

  /** Inserts a file directly, bypassing the API — for arranging test fixtures. */
  seed(file: Partial<FakeFile> & { name: string; parents: string[] }): FakeFile {
    const timestamp = this.#timestamp();
    const record: FakeFile = {
      id: `file-${this.#nextId++}`,
      mimeType: "application/octet-stream",
      content: Buffer.alloc(0),
      createdTime: timestamp,
      modifiedTime: timestamp,
      trashed: false,
      anyoneReader: false,
      ...file,
    };
    this.#store.set(record.id, record);
    return record;
  }

  seedFolder(name: string, parentId: string): FakeFile {
    return this.seed({ name, parents: [parentId], mimeType: FOLDER_MIME });
  }

  contentOf(id: string): Buffer | undefined {
    return this.#store.get(id)?.content;
  }

  isPublic(id: string): boolean {
    return this.#store.get(id)?.anyoneReader ?? false;
  }

  liveNames(): string[] {
    return [...this.#store.values()].filter((f) => !f.trashed).map((f) => f.name).sort();
  }

  #serialize(file: FakeFile) {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: String(file.content.length),
      createdTime: file.createdTime,
      modifiedTime: file.modifiedTime,
      webContentLink: file.anyoneReader ? `https://drive.example/uc?id=${file.id}&export=download` : null,
    };
  }

  async #list(params: Record<string, unknown>) {
    const q = String(params["q"] ?? "");
    this.listCalls.push(q);
    const { parent, name, folderOnly } = parseQuery(q);

    let matches = [...this.#store.values()].filter((file) => !file.trashed);
    if (parent !== undefined) matches = matches.filter((file) => file.parents.includes(parent));
    if (name !== undefined) matches = matches.filter((file) => file.name === name);
    if (folderOnly) matches = matches.filter((file) => file.mimeType === FOLDER_MIME);

    if (String(params["orderBy"] ?? "") === "createdTime") {
      matches.sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.id.localeCompare(b.id));
    }
    const pageSize = Number(params["pageSize"] ?? 100);
    return { data: { files: matches.slice(0, pageSize).map((file) => this.#serialize(file)) } };
  }

  async #get(params: Record<string, unknown>, options: Record<string, unknown> = {}) {
    const file = this.#store.get(String(params["fileId"]));
    if (!file || file.trashed) {
      throw Object.assign(new Error("File not found"), { code: 404 });
    }
    if (params["alt"] !== "media") {
      return { data: this.#serialize(file) };
    }

    let content = file.content;
    const range = (options["headers"] as Record<string, string> | undefined)?.["Range"];
    const parsed = range ? /^bytes=(\d+)-(\d*)$/u.exec(range) : null;
    if (parsed) {
      const start = Number(parsed[1]);
      const end = parsed[2] ? Number(parsed[2]) + 1 : content.length;
      content = content.subarray(start, end);
    }
    return { data: Readable.from([content]) };
  }

  async #create(params: Record<string, unknown>) {
    const requestBody = (params["requestBody"] ?? {}) as { name?: string; mimeType?: string; parents?: string[] };
    const media = params["media"] as { mimeType?: string; body?: unknown } | undefined;
    const file = this.seed({
      name: requestBody.name ?? "untitled",
      parents: requestBody.parents ?? [],
      mimeType: requestBody.mimeType ?? media?.mimeType ?? "application/octet-stream",
      content: media ? await drain(media.body) : Buffer.alloc(0),
    });
    return { data: this.#serialize(file) };
  }

  async #update(params: Record<string, unknown>) {
    const file = this.#store.get(String(params["fileId"]));
    if (!file || file.trashed) {
      throw Object.assign(new Error("File not found"), { code: 404 });
    }
    const media = params["media"] as { mimeType?: string; body?: unknown } | undefined;
    if (media) {
      file.content = await drain(media.body);
      if (media.mimeType) file.mimeType = media.mimeType;
    }
    file.modifiedTime = this.#timestamp();
    return { data: this.#serialize(file) };
  }

  async #delete(params: Record<string, unknown>) {
    const id = String(params["fileId"]);
    const file = this.#store.get(id);
    if (!file || file.trashed) {
      throw Object.assign(new Error("File not found"), { code: 404 });
    }
    // Drive removes a folder's whole subtree; mirror that so deletePrefix is
    // exercised against realistic behaviour.
    const trashSubtree = (parentId: string) => {
      for (const candidate of this.#store.values()) {
        if (candidate.parents.includes(parentId) && !candidate.trashed) {
          candidate.trashed = true;
          trashSubtree(candidate.id);
        }
      }
    };
    file.trashed = true;
    trashSubtree(id);
    return {};
  }

  async #createPermission(params: Record<string, unknown>) {
    const file = this.#store.get(String(params["fileId"]));
    const requestBody = (params["requestBody"] ?? {}) as { type?: string; role?: string };
    if (file && requestBody.type === "anyone") {
      file.anyoneReader = true;
    }
    return {};
  }
}
