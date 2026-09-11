import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { LocalStorage } from "../local.ts";
import { StorageNotFoundError } from "../types.ts";

const body = (text: string) => Readable.from([Buffer.from(text)]);

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

describe("LocalStorage", () => {
  let rootDir: string;
  let storage: LocalStorage;

  before(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "ai-shorts-storage-"));
    storage = new LocalStorage({ rootDir });
  });

  after(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("round-trips content and creates parent directories", async () => {
    await storage.put("jobs/abc/shorts/clip-01.mp4", body("video"));
    assert.equal(await collect(await storage.get("jobs/abc/shorts/clip-01.mp4")), "video");
  });

  it("serves byte ranges", async () => {
    await storage.put("jobs/abc/source.mp4", body("0123456789"));
    assert.equal(await collect(await storage.get("jobs/abc/source.mp4", { range: { start: 2, end: 5 } })), "2345");
  });

  it("reports stat for present and absent keys", async () => {
    await storage.put("jobs/abc/audio.wav", body("pcm"));
    assert.equal((await storage.stat("jobs/abc/audio.wav"))?.size, 3);
    assert.equal(await storage.stat("jobs/abc/nope.wav"), null);
  });

  it("throws StorageNotFoundError for a missing key", async () => {
    await assert.rejects(() => storage.get("jobs/abc/missing.mp4"), StorageNotFoundError);
  });

  it("lists only files, not subdirectories", async () => {
    await storage.put("jobs/list/a.txt", body("a"));
    await storage.put("jobs/list/nested/b.txt", body("b"));

    assert.deepEqual((await storage.list("jobs/list")).map((o) => o.key), ["jobs/list/a.txt"]);
  });

  it("deletes a prefix recursively", async () => {
    await storage.put("jobs/gone/a.txt", body("a"));
    await storage.deletePrefix("jobs/gone");
    assert.deepEqual(await storage.list("jobs/gone"), []);
  });

  it("rejects keys that try to escape the root", async () => {
    await assert.rejects(() => storage.stat("../../etc/passwd"));
  });
});
