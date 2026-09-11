import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ffmpegAvailable } from "../ffmpeg.ts";
import { probeVideo } from "../probe.ts";
import { UnsupportedMediaError } from "../types.ts";
import { createTestVideo } from "./fixtures.ts";

const hasFfmpeg = await ffmpegAvailable();

describe("probeVideo", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "probe-test-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads duration, dimensions, frame rate, and codecs", async () => {
    const file = path.join(dir, "sample.mp4");
    await createTestVideo(file, { durationSeconds: 2, width: 640, height: 360, frameRate: 25 });

    const metadata = await probeVideo(file);

    assert.ok(Math.abs(metadata.duration - 2) < 0.5, `unexpected duration ${metadata.duration}`);
    assert.equal(metadata.video.width, 640);
    assert.equal(metadata.video.height, 360);
    assert.equal(metadata.video.frameRate, 25);
    assert.equal(metadata.video.codec, "h264");
    assert.ok(metadata.sizeBytes > 0);
  });

  it("reports the audio stream when one is present", async () => {
    const file = path.join(dir, "with-audio.mp4");
    await createTestVideo(file, { withAudio: true });

    const metadata = await probeVideo(file);

    assert.ok(metadata.audio, "expected an audio stream");
    assert.equal(metadata.audio?.codec, "aac");
  });

  it("reports null audio for a silent video", async () => {
    const file = path.join(dir, "silent.mp4");
    await createTestVideo(file, { withAudio: false });

    assert.equal((await probeVideo(file)).audio, null);
  });

  it("rejects a file that is not media", async () => {
    const file = path.join(dir, "notes.txt");
    await writeFile(file, "this is not a video");

    await assert.rejects(() => probeVideo(file));
  });

  it("rejects a truncated file with no usable duration", async () => {
    const source = path.join(dir, "full.mp4");
    const truncated = path.join(dir, "truncated.mp4");
    await createTestVideo(source);
    // First 512 bytes: enough to look like an MP4, not enough to have a moov atom.
    const { readFile, writeFile: write } = await import("node:fs/promises");
    await write(truncated, (await readFile(source)).subarray(0, 512));

    await assert.rejects(() => probeVideo(truncated));
  });
});

describe("probeVideo error types", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  it("raises UnsupportedMediaError for an audio-only file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "probe-audio-"));
    try {
      const file = path.join(dir, "tone.wav");
      const { run } = await import("../ffmpeg.ts");
      const { ffmpegBinary } = await import("../ffmpeg.ts");
      await run(ffmpegBinary(), ["-nostdin", "-y", "-f", "lavfi", "-i", "sine=duration=1", file]);

      await assert.rejects(() => probeVideo(file), UnsupportedMediaError);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
