import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createTestVideo } from "../../media/__tests__/fixtures.ts";
import { extractAudio } from "../../media/audio.ts";
import { ffmpegAvailable } from "../../media/ffmpeg.ts";
import { StubTranscriber } from "../stub.ts";
import { joinSegments } from "../types.ts";

const hasFfmpeg = await ffmpegAvailable();

describe("StubTranscriber", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  let dir: string;
  let audio: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "stub-transcribe-"));
    const video = path.join(dir, "source.mp4");
    audio = path.join(dir, "audio.wav");
    await createTestVideo(video, { durationSeconds: 10 });
    await extractAudio(video, audio);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("covers the whole audio with contiguous segments", async () => {
    const transcript = await new StubTranscriber({ segmentSeconds: 3 }).transcribe(audio);

    assert.ok(transcript.duration > 9 && transcript.duration < 11);
    assert.ok(transcript.segments.length >= 3);
    assert.equal(transcript.segments[0]?.start, 0);
    assert.ok(
      Math.abs((transcript.segments.at(-1)?.end ?? 0) - transcript.duration) < 0.01,
      "last segment should reach the end",
    );

    for (let index = 1; index < transcript.segments.length; index += 1) {
      assert.equal(transcript.segments[index]?.start, transcript.segments[index - 1]?.end);
    }
  });

  it("labels itself so stored transcripts record their provenance", async () => {
    const transcript = await new StubTranscriber().transcribe(audio);

    assert.equal(transcript.provider, "stub");
    assert.equal(transcript.language, null);
    assert.ok(transcript.text.includes("untranscribed"), "placeholder text must be self-describing");
  });

  it("fails loudly on a file with no readable duration", async () => {
    const { writeFile } = await import("node:fs/promises");
    const bogus = path.join(dir, "bogus.wav");
    await writeFile(bogus, "not audio");

    await assert.rejects(() => new StubTranscriber().transcribe(bogus));
  });
});

describe("joinSegments", () => {
  it("joins non-empty segment text with single spaces", () => {
    assert.equal(
      joinSegments([
        { id: "a", start: 0, end: 1, text: " hello " },
        { id: "b", start: 1, end: 2, text: "" },
        { id: "c", start: 2, end: 3, text: "world" },
      ]),
      "hello world",
    );
  });
});
