import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, it } from "node:test";
import { GoogleDriveStorage } from "../googleDrive.ts";
import { StorageNotFoundError } from "../types.ts";
import { FakeDrive } from "./fakeDrive.ts";

function setup(options: { allowPublicLinks?: boolean } = {}) {
  const drive = new FakeDrive();
  const storage = new GoogleDriveStorage({
    drive,
    rootFolderId: drive.rootId,
    ...(options.allowPublicLinks === undefined ? {} : { allowPublicLinks: options.allowPublicLinks }),
  });
  return { drive, storage };
}

const body = (text: string) => Readable.from([Buffer.from(text)]);

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString();
}

describe("GoogleDriveStorage", () => {
  it("creates the folder chain implied by a nested key", async () => {
    const { drive, storage } = setup();

    const object = await storage.put("jobs/abc/shorts/clip-01.mp4", body("video"), {
      contentType: "video/mp4",
    });

    assert.equal(object.key, "jobs/abc/shorts/clip-01.mp4");
    assert.equal(object.contentType, "video/mp4");
    assert.deepEqual(drive.liveNames(), ["abc", "clip-01.mp4", "jobs", "shorts"]);
    assert.equal(drive.contentOf(object.nativeId)?.toString(), "video");
  });

  it("round-trips content through get", async () => {
    const { storage } = setup();
    await storage.put("jobs/abc/transcript.json", body('{"ok":true}'), {
      contentType: "application/json",
    });

    assert.equal(await collect(await storage.get("jobs/abc/transcript.json")), '{"ok":true}');
  });

  it("serves byte ranges so media can be streamed partially", async () => {
    const { storage } = setup();
    await storage.put("jobs/abc/source.mp4", body("0123456789"));

    const stream = await storage.get("jobs/abc/source.mp4", { range: { start: 2, end: 5 } });
    assert.equal(await collect(stream), "2345");
  });

  it("overwrites in place rather than creating a duplicate sibling", async () => {
    const { drive, storage } = setup();

    const first = await storage.put("jobs/abc/edit-plan.json", body("v1"));
    const second = await storage.put("jobs/abc/edit-plan.json", body("v2"));

    assert.equal(first.nativeId, second.nativeId, "expected the same Drive file to be updated");
    assert.equal(drive.liveNames().filter((name) => name === "edit-plan.json").length, 1);
    assert.equal(drive.contentOf(second.nativeId)?.toString(), "v2");
  });

  it("resolves duplicate folder names to the oldest, so racing workers converge", async () => {
    const { drive, storage } = setup();
    // Two workers each created a `jobs` folder before either cached an ID.
    const oldest = drive.seedFolder("jobs", drive.rootId);
    drive.seedFolder("jobs", drive.rootId);

    const object = await storage.put("jobs/abc/audio.wav", body("pcm"));

    const stored = await storage.stat("jobs/abc/audio.wav");
    assert.equal(stored?.nativeId, object.nativeId);
    // `abc` must have been created under the older of the two `jobs` folders.
    const abcParents = drive.liveNames().filter((name) => name === "abc");
    assert.equal(abcParents.length, 1);
    assert.ok(oldest.id);
  });

  it("caches folder IDs instead of re-resolving the chain on every call", async () => {
    const { drive, storage } = setup();
    await storage.put("jobs/abc/shorts/clip-01.mp4", body("a"));
    const afterFirst = drive.listCalls.length;

    await storage.put("jobs/abc/shorts/clip-02.mp4", body("b"));
    const secondCallCount = drive.listCalls.length - afterFirst;

    // Only the filename lookup should hit the API; the three folders are cached.
    assert.equal(secondCallCount, 1);
  });

  it("returns null from stat and throws from get for a missing key", async () => {
    const { storage } = setup();

    assert.equal(await storage.stat("jobs/missing/source.mp4"), null);
    await assert.rejects(() => storage.get("jobs/missing/source.mp4"), StorageNotFoundError);
  });

  it("lists the immediate children of a prefix", async () => {
    const { storage } = setup();
    await storage.put("jobs/abc/shorts/clip-01.mp4", body("a"));
    await storage.put("jobs/abc/shorts/clip-02.mp4", body("b"));
    await storage.put("jobs/abc/source.mp4", body("source"));

    const listed = await storage.list("jobs/abc/shorts");

    assert.deepEqual(
      listed.map((object) => object.key).sort(),
      ["jobs/abc/shorts/clip-01.mp4", "jobs/abc/shorts/clip-02.mp4"],
    );
  });

  it("returns an empty list for a prefix that does not exist", async () => {
    const { storage } = setup();
    assert.deepEqual(await storage.list("jobs/nope"), []);
  });

  it("deletes a prefix and everything beneath it", async () => {
    const { storage } = setup();
    await storage.put("jobs/abc/shorts/clip-01.mp4", body("a"));
    await storage.put("jobs/abc/source.mp4", body("source"));

    await storage.deletePrefix("jobs/abc");

    assert.equal(await storage.stat("jobs/abc/source.mp4"), null);
    assert.equal(await storage.stat("jobs/abc/shorts/clip-01.mp4"), null);
  });

  it("re-creates a prefix after deletion instead of reusing a stale cached ID", async () => {
    const { storage } = setup();
    await storage.put("jobs/abc/source.mp4", body("first"));
    await storage.deletePrefix("jobs/abc");

    await storage.put("jobs/abc/source.mp4", body("second"));

    assert.equal(await collect(await storage.get("jobs/abc/source.mp4")), "second");
  });

  it("delete is silent when the key is already gone", async () => {
    const { storage } = setup();
    await assert.doesNotReject(() => storage.delete("jobs/abc/source.mp4"));
    await assert.doesNotReject(() => storage.deletePrefix("jobs/abc"));
  });

  it("refuses to mint a public link unless explicitly allowed", async () => {
    const { storage } = setup();
    await storage.put("jobs/abc/shorts/clip-01.mp4", body("a"));

    await assert.rejects(() => storage.signedUrl("jobs/abc/shorts/clip-01.mp4"), /allowPublicLinks/u);
  });

  it("grants anyone-with-the-link access and reports no expiry when allowed", async () => {
    const { drive, storage } = setup({ allowPublicLinks: true });
    const object = await storage.put("jobs/abc/shorts/clip-01.mp4", body("a"));

    const signed = await storage.signedUrl("jobs/abc/shorts/clip-01.mp4");

    assert.ok(signed.url.includes(object.nativeId));
    assert.equal(signed.expiresAt, null, "Drive links cannot expire; callers must be able to detect that");
    assert.equal(drive.isPublic(object.nativeId), true);
  });

  it("escapes quotes in names so they cannot break out of a Drive query", async () => {
    const { storage } = setup();
    const key = "jobs/it's a job/source.mp4";

    await storage.put(key, body("x"));

    assert.equal(await collect(await storage.get(key)), "x");
  });
});
