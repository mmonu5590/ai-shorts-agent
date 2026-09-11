import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createTestVideo } from "../../media/__tests__/fixtures.ts";
import { ffmpegAvailable } from "../../media/ffmpeg.ts";
import { probeVideo } from "../../media/probe.ts";
import { type EditPlan, type OutputSpec, DEFAULT_OUTPUT, EDIT_PLAN_VERSION } from "../../plan/types.ts";
import { LocalStorage } from "../../storage/index.ts";
import { RenderError, renderClip, renderPlan } from "../index.ts";

const hasFfmpeg = await ffmpegAvailable();

/** Small output so the suite stays fast; the code path is identical at 1080p. */
const SPEC: OutputSpec = { ...DEFAULT_OUTPUT, width: 270, height: 480, preset: "ultrafast" };

describe("renderClip", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  let dir: string;
  let source: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "render-test-"));
    source = path.join(dir, "source.mp4");
    await createTestVideo(source, { durationSeconds: 6, width: 640, height: 360 });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("renders a vertical clip of the requested range", async () => {
    const output = path.join(dir, "crop.mp4");

    await renderClip({
      inputPath: source,
      outputPath: output,
      clip: { id: "c1", start: 1, end: 4 },
      spec: SPEC,
    });

    const metadata = await probeVideo(output);
    assert.equal(metadata.video.width, 270);
    assert.equal(metadata.video.height, 480);
    assert.ok(Math.abs(metadata.duration - 3) < 0.4, `unexpected duration ${metadata.duration}`);
    assert.ok(metadata.audio, "audio should be carried through");
  });

  it("fills the frame in crop mode and in pad mode alike", async () => {
    const cropped = path.join(dir, "mode-crop.mp4");
    const padded = path.join(dir, "mode-pad.mp4");
    const clip = { id: "c1", start: 0, end: 3 };

    await renderClip({ inputPath: source, outputPath: cropped, spec: SPEC, clip: { ...clip, framing: { mode: "crop" } } });
    await renderClip({ inputPath: source, outputPath: padded, spec: SPEC, clip: { ...clip, framing: { mode: "pad" } } });

    for (const file of [cropped, padded]) {
      const metadata = await probeVideo(file);
      assert.equal(metadata.video.width, 270, `${file} width`);
      assert.equal(metadata.video.height, 480, `${file} height`);
    }
  });

  it("renders a source that is already taller than the target aspect", async () => {
    // The branch in the crop expression exists for this case; without it ffmpeg
    // is asked for a crop window wider than the source and fails.
    const tall = path.join(dir, "tall.mp4");
    const output = path.join(dir, "tall-out.mp4");
    await createTestVideo(tall, { durationSeconds: 3, width: 240, height: 640 });

    await renderClip({
      inputPath: tall,
      outputPath: output,
      clip: { id: "c1", start: 0, end: 2, framing: { mode: "crop" } },
      spec: SPEC,
    });

    const metadata = await probeVideo(output);
    assert.equal(metadata.video.width, 270);
    assert.equal(metadata.video.height, 480);
  });

  it("honours centerX at both extremes", async () => {
    for (const centerX of [0, 1]) {
      const output = path.join(dir, `center-${centerX}.mp4`);
      await renderClip({
        inputPath: source,
        outputPath: output,
        clip: { id: "c1", start: 0, end: 2, framing: { mode: "crop", centerX } },
        spec: SPEC,
      });
      assert.equal((await probeVideo(output)).video.width, 270);
    }
  });
});

describe("renderPlan", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  let dir: string;
  let storage: LocalStorage;
  let sourceKey: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "render-plan-"));
    storage = new LocalStorage({ rootDir: path.join(dir, "storage") });

    const source = path.join(dir, "source.mp4");
    await createTestVideo(source, { durationSeconds: 8, width: 640, height: 360 });
    sourceKey = "jobs/job-r1/source.mp4";
    const { createReadStream } = await import("node:fs");
    await storage.put(sourceKey, createReadStream(source), { contentType: "video/mp4" });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const plan: EditPlan = {
    version: EDIT_PLAN_VERSION,
    jobId: "job-r1",
    sourceDuration: 8,
    clips: [
      { id: "a", start: 0, end: 3, framing: { mode: "crop", centerX: 0.5 } },
      { id: "b", start: 4, end: 7, framing: { mode: "pad" } },
    ],
  };

  it("renders every clip and stores them under the job prefix", async () => {
    const result = await renderPlan({ plan, storage, sourceKey, spec: SPEC });

    assert.equal(result.jobId, "job-r1");
    assert.deepEqual(
      result.shorts.map((short) => short.key),
      ["jobs/job-r1/shorts/clip-01.mp4", "jobs/job-r1/shorts/clip-02.mp4"],
    );
    assert.deepEqual(
      result.shorts.map((short) => short.clipId),
      ["a", "b"],
    );

    for (const short of result.shorts) {
      const stored = await storage.stat(short.key);
      assert.ok(stored && stored.size !== null && stored.size > 0, `${short.key} should be non-empty`);
      assert.equal(stored?.size, short.sizeBytes);
    }
  });

  it("reports progress once per clip", async () => {
    const seen: string[] = [];

    await renderPlan({
      plan,
      storage,
      sourceKey,
      spec: SPEC,
      onProgress: (completed, total) => seen.push(`${completed}/${total}`),
    });

    assert.deepEqual(seen, ["1/2", "2/2"]);
  });

  it("rejects a clip that ffmpeg 'succeeds' at but renders empty", async () => {
    // Seeking past the end of the source makes ffmpeg write a valid container
    // with no frames and exit 0. Without a post-render check this would be
    // stored and served as a broken Short.
    const brokenPlan: EditPlan = { ...plan, clips: [{ id: "bad", start: 50, end: 55 }] };

    await assert.rejects(
      () => renderPlan({ plan: brokenPlan, storage, sourceKey, spec: SPEC }),
      RenderError,
    );
  });

  it("does not store a Short for a clip that failed verification", async () => {
    const brokenPlan: EditPlan = { ...plan, jobId: "job-r2", clips: [{ id: "bad", start: 50, end: 55 }] };

    await assert.rejects(() => renderPlan({ plan: brokenPlan, storage, sourceKey, spec: SPEC }));

    assert.deepEqual(await storage.list("jobs/job-r2/shorts"), []);
  });

  it("cleans up staging even when a clip fails to render", async () => {
    const workDir = await mkdtemp(path.join(dir, "work-"));
    const brokenPlan: EditPlan = { ...plan, clips: [{ id: "bad", start: 50, end: 55 }] };

    await assert.rejects(() => renderPlan({ plan: brokenPlan, storage, sourceKey, spec: SPEC, workDir }));

    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(workDir), [], "staging directory should be empty after a failure");
  });
});
