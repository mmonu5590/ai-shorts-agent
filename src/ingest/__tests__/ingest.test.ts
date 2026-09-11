import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { createTestVideo } from "../../media/__tests__/fixtures.ts";
import { ffmpegAvailable } from "../../media/ffmpeg.ts";
import { UnsupportedMediaError } from "../../media/types.ts";
import { LocalStorage } from "../../storage/index.ts";
import { ingestVideo, resolveExtension } from "../index.ts";

const hasFfmpeg = await ffmpegAvailable();

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

describe("resolveExtension", () => {
  for (const name of ["clip.mp4", "CLIP.MP4", "a.b.c.mov", "video.webm", "film.mkv", "short.m4v"]) {
    it(`accepts ${name}`, () => {
      assert.ok(resolveExtension(name));
    });
  }

  for (const name of ["clip.avi", "clip.txt", "clip", "clip.mp4.exe"]) {
    it(`rejects ${name}`, () => {
      assert.throws(() => resolveExtension(name), UnsupportedMediaError);
    });
  }
});

describe("ingestVideo", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  let dir: string;
  let storageDir: string;
  let storage: LocalStorage;
  let sourceVideo: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "ingest-test-"));
    storageDir = path.join(dir, "storage");
    storage = new LocalStorage({ rootDir: storageDir });
    sourceVideo = path.join(dir, "input.mp4");
    await createTestVideo(sourceVideo, { durationSeconds: 2, width: 640, height: 360 });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stores source, audio, and metadata under the job prefix", async () => {
    const result = await ingestVideo({
      jobId: "job-001",
      filename: "My Holiday Video.mp4",
      source: createReadStream(sourceVideo),
      storage,
    });

    assert.deepEqual(result.keys, {
      source: "jobs/job-001/source.mp4",
      audio: "jobs/job-001/audio.wav",
      metadata: "jobs/job-001/metadata.json",
    });
    assert.equal(result.metadata.video.width, 640);
    assert.ok(result.metadata.audio, "expected an audio stream");

    for (const key of Object.values(result.keys)) {
      const stored = await storage.stat(key);
      assert.ok(stored && stored.size !== null && stored.size > 0, `${key} should be stored and non-empty`);
    }
  });

  it("writes metadata as readable JSON so later stages need not re-probe", async () => {
    const result = await ingestVideo({
      jobId: "job-002",
      filename: "input.mp4",
      source: createReadStream(sourceVideo),
      storage,
    });

    const parsed = JSON.parse((await collect(await storage.get(result.keys.metadata))).toString()) as {
      jobId: string;
      extension: string;
      duration: number;
    };
    assert.equal(parsed.jobId, "job-002");
    assert.equal(parsed.extension, "mp4");
    assert.ok(parsed.duration > 0);
  });

  it("produces audio that is actually decodable", async () => {
    const result = await ingestVideo({
      jobId: "job-003",
      filename: "input.mp4",
      source: createReadStream(sourceVideo),
      storage,
    });

    const wav = await collect(await storage.get(result.keys.audio));
    assert.equal(wav.subarray(0, 4).toString(), "RIFF");
    assert.equal(wav.subarray(8, 12).toString(), "WAVE");
  });

  it("takes the extension from the filename, not from a caller-supplied path", async () => {
    const result = await ingestVideo({
      jobId: "job-004",
      filename: "../../etc/passwd.mov",
      source: createReadStream(sourceVideo),
      storage,
    });

    assert.equal(result.keys.source, "jobs/job-004/source.mov");
  });

  it("rejects an unsupported container", async () => {
    await assert.rejects(
      () =>
        ingestVideo({
          jobId: "job-bad",
          filename: "clip.avi",
          source: createReadStream(sourceVideo),
          storage,
        }),
      UnsupportedMediaError,
    );
  });

  it("rejects a job ID that would reshape the storage prefix", async () => {
    for (const jobId of ["../escape", "a/b", "", "x".repeat(65)]) {
      await assert.rejects(
        () =>
          ingestVideo({ jobId, filename: "clip.mp4", source: createReadStream(sourceVideo), storage }),
        UnsupportedMediaError,
        `expected "${jobId}" to be rejected`,
      );
    }
  });

  it("rejects an empty upload", async () => {
    await assert.rejects(
      () =>
        ingestVideo({
          jobId: "job-empty",
          filename: "clip.mp4",
          source: Readable.from([]),
          storage,
        }),
      UnsupportedMediaError,
    );
  });

  it("rejects a file that is not video", async () => {
    const notVideo = path.join(dir, "notes.mp4");
    await writeFile(notVideo, "definitely not a video");

    await assert.rejects(() =>
      ingestVideo({
        jobId: "job-notvideo",
        filename: "notes.mp4",
        source: createReadStream(notVideo),
        storage,
      }),
    );
  });

  it("rejects a silent video, which cannot be transcribed", async () => {
    const silent = path.join(dir, "silent.mp4");
    await createTestVideo(silent, { withAudio: false });

    await assert.rejects(
      () =>
        ingestVideo({
          jobId: "job-silent",
          filename: "silent.mp4",
          source: createReadStream(silent),
          storage,
        }),
      UnsupportedMediaError,
    );
  });

  it("enforces the duration limit before transcoding", async () => {
    await assert.rejects(
      () =>
        ingestVideo({
          jobId: "job-long",
          filename: "input.mp4",
          source: createReadStream(sourceVideo),
          storage,
          maxDurationSeconds: 1,
        }),
      /exceeds the 1s limit/u,
    );
  });

  it("removes staged files even when a step fails", async () => {
    const workDir = await mkdtemp(path.join(dir, "work-"));

    await assert.rejects(() =>
      ingestVideo({
        jobId: "job-cleanup",
        filename: "notes.mp4",
        source: Readable.from([Buffer.from("not a video")]),
        storage,
        workDir,
      }),
    );

    assert.deepEqual(await readdir(workDir), [], "staging directory should be empty after a failure");
  });
});
