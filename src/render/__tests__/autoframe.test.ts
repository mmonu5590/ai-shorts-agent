import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ffmpegAvailable, ffmpegBinary, run } from "../../media/ffmpeg.ts";
import { MotionFrameAnalyzer, bestWindowCenter, columnActivity, splitFrames } from "../autoframe.ts";

const hasFfmpeg = await ffmpegAvailable();

describe("columnActivity", () => {
  it("scores only the columns that change between frames", () => {
    const columns = 4;
    const rows = 2;
    // Column 1 flips between frames; the rest hold still.
    const a = Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]);
    const b = Buffer.from([0, 50, 0, 0, 0, 50, 0, 0]);

    const activity = columnActivity([a, b], columns, rows);

    assert.deepEqual(activity, [0, 100, 0, 0]);
  });

  it("returns zeros for a single frame, which carries no motion", () => {
    assert.deepEqual(columnActivity([Buffer.alloc(8)], 4, 2), [0, 0, 0, 0]);
  });
});

describe("bestWindowCenter", () => {
  it("centres the window on the busiest run of columns", () => {
    // Activity concentrated at the far left.
    assert.equal(bestWindowCenter([10, 10, 0, 0, 0, 0], 2), 0);
    // ...and at the far right.
    assert.equal(bestWindowCenter([0, 0, 0, 0, 10, 10], 2), 1);
  });

  it("returns a mid position for centred activity", () => {
    const center = bestWindowCenter([0, 0, 10, 10, 0, 0], 2) as number;
    assert.ok(center > 0.3 && center < 0.7, `expected a central window, got ${center}`);
  });

  it("returns null for a still frame rather than inventing a subject", () => {
    assert.equal(bestWindowCenter([0, 0, 0, 0], 2), null);
  });

  it("returns null when the window covers the whole frame", () => {
    assert.equal(bestWindowCenter([1, 2, 3], 3), null);
  });
});

describe("splitFrames", () => {
  it("splits a raw buffer into equally sized frames and drops a partial tail", () => {
    const frames = splitFrames(Buffer.alloc(4 * 2 * 3 + 1), 4, 2);
    assert.equal(frames.length, 3);
    assert.equal(frames[0]?.length, 8);
  });
});

/** Renders 640x360 with an animated patch at a known horizontal offset. */
async function videoWithMotionAt(outputPath: string, patchX: number): Promise<void> {
  await run(ffmpegBinary(), [
    "-nostdin", "-y",
    "-f", "lavfi", "-i", "color=black:s=640x360:d=4:r=10",
    "-f", "lavfi", "-i", "testsrc=s=120x120:d=4:r=10",
    "-filter_complex", `[0][1]overlay=x=${patchX}:y=120`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    outputPath,
  ]);
}

describe("MotionFrameAnalyzer", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "autoframe-"));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const clip = { id: "c1", start: 0, end: 3 };
  const targetAspect = 9 / 16;

  it("aims the crop at motion on the left", async () => {
    const video = path.join(dir, "left.mp4");
    await videoWithMotionAt(video, 30);

    const centerX = await new MotionFrameAnalyzer({ workDir: dir }).analyze(video, clip, targetAspect);

    assert.ok(centerX !== null, "expected a usable signal");
    assert.ok(centerX < 0.35, `motion is on the left; got centerX ${centerX}`);
  });

  it("aims the crop at motion on the right", async () => {
    const video = path.join(dir, "right.mp4");
    await videoWithMotionAt(video, 490);

    const centerX = await new MotionFrameAnalyzer({ workDir: dir }).analyze(video, clip, targetAspect);

    assert.ok(centerX !== null, "expected a usable signal");
    assert.ok(centerX > 0.65, `motion is on the right; got centerX ${centerX}`);
  });

  it("returns null for a still frame instead of guessing", async () => {
    const still = path.join(dir, "still.mp4");
    await run(ffmpegBinary(), [
      "-nostdin", "-y", "-f", "lavfi", "-i", "color=black:s=640x360:d=3:r=10",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", still,
    ]);

    assert.equal(await new MotionFrameAnalyzer({ workDir: dir }).analyze(still, clip, targetAspect), null);
  });

  it("returns null when the source is already narrower than the target", async () => {
    const tall = path.join(dir, "tall.mp4");
    await run(ffmpegBinary(), [
      "-nostdin", "-y", "-f", "lavfi", "-i", "testsrc=s=240x640:d=3:r=10",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", tall,
    ]);

    // There is no horizontal choice to make; the whole width is already used.
    assert.equal(await new MotionFrameAnalyzer({ workDir: dir }).analyze(tall, clip, targetAspect), null);
  });

  it("leaves no sampled frames behind", async () => {
    const video = path.join(dir, "cleanup.mp4");
    await videoWithMotionAt(video, 30);
    await new MotionFrameAnalyzer({ workDir: dir }).analyze(video, clip, targetAspect);

    const { readdir } = await import("node:fs/promises");
    assert.ok(
      !(await readdir(dir)).some((name) => name.endsWith(".gray")),
      "the raw sample file should be removed",
    );
  });
});
