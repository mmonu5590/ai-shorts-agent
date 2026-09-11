import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { extractAudio } from "../audio.ts";
import { ffmpegAvailable, ffprobeBinary, run } from "../ffmpeg.ts";
import { UnsupportedMediaError } from "../types.ts";
import { createTestVideo } from "./fixtures.ts";

const hasFfmpeg = await ffmpegAvailable();

describe("extractAudio", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "audio-test-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes 16 kHz mono PCM by default, which is what ASR models expect", async () => {
    const video = path.join(dir, "input.mp4");
    const audio = path.join(dir, "output.wav");
    await createTestVideo(video, { durationSeconds: 1 });

    await extractAudio(video, audio);

    assert.ok((await stat(audio)).size > 0);
    const { stdout } = await run(ffprobeBinary(), [
      "-v", "error", "-print_format", "json", "-show_streams", audio,
    ]);
    const stream = (JSON.parse(stdout) as { streams: { codec_name: string; channels: number; sample_rate: string }[] })
      .streams[0];
    assert.equal(stream?.codec_name, "pcm_s16le");
    assert.equal(stream?.channels, 1);
    assert.equal(stream?.sample_rate, "16000");
  });

  it("honours an explicit sample rate and channel count", async () => {
    const video = path.join(dir, "input2.mp4");
    const audio = path.join(dir, "output2.wav");
    await createTestVideo(video, { durationSeconds: 1 });

    await extractAudio(video, audio, { sampleRate: 44_100, channels: 2 });

    const { stdout } = await run(ffprobeBinary(), [
      "-v", "error", "-print_format", "json", "-show_streams", audio,
    ]);
    const stream = (JSON.parse(stdout) as { streams: { channels: number; sample_rate: string }[] }).streams[0];
    assert.equal(stream?.channels, 2);
    assert.equal(stream?.sample_rate, "44100");
  });

  it("raises UnsupportedMediaError when the input has no audio track", async () => {
    const video = path.join(dir, "silent.mp4");
    const audio = path.join(dir, "silent.wav");
    await createTestVideo(video, { withAudio: false });

    await assert.rejects(() => extractAudio(video, audio), UnsupportedMediaError);
  });
});
