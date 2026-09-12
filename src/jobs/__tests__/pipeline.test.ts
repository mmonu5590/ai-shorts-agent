import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { after, before, describe, it } from "node:test";
import { createTestVideo } from "../../media/__tests__/fixtures.ts";
import { ffmpegAvailable } from "../../media/ffmpeg.ts";
import { HeuristicClipSelector } from "../../select/index.ts";
import { LocalStorage, jobKeys } from "../../storage/index.ts";
import { StubTranscriber } from "../../transcribe/index.ts";
import { InMemoryJobStore, captionsEnabled, runJob } from "../index.ts";

const hasFfmpeg = await ffmpegAvailable();

describe("runJob", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  let dir: string;
  let storage: LocalStorage;
  let source: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "pipeline-test-"));
    storage = new LocalStorage({ rootDir: path.join(dir, "storage") });
    source = path.join(dir, "source.mp4");
    await createTestVideo(source, { durationSeconds: 12, width: 640, height: 360 });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function deps() {
    return {
      storage,
      store: new InMemoryJobStore(),
      transcriber: new StubTranscriber({ segmentSeconds: 3 }),
      selector: new HeuristicClipSelector({ targetDurationSeconds: 5 }),
    };
  }

  it("carries a job from upload to rendered Shorts", async () => {
    const shared = deps();
    await shared.store.create({ id: "job-p1", filename: "input.mp4", ownerId: "tester" });

    const job = await runJob({
      jobId: "job-p1",
      filename: "input.mp4",
      source: createReadStream(source),
      ...shared,
    });

    assert.equal(job.status, "complete", job.error ?? "");
    assert.ok(job.metadata, "metadata should be recorded");
    assert.ok(job.plan && job.plan.clips.length > 0, "a plan should be recorded");
    assert.ok(job.shorts && job.shorts.length > 0, "shorts should be recorded");
    assert.deepEqual(job.progress, { completed: job.shorts?.length, total: job.shorts?.length });
  });

  it("leaves every stage's output in the job prefix", async () => {
    const shared = deps();
    await shared.store.create({ id: "job-p2", filename: "input.mp4", ownerId: "tester" });

    await runJob({ jobId: "job-p2", filename: "input.mp4", source: createReadStream(source), ...shared });

    for (const key of [
      jobKeys.source("job-p2", "mp4"),
      jobKeys.audio("job-p2"),
      jobKeys.metadata("job-p2"),
      jobKeys.transcript("job-p2"),
      jobKeys.editPlan("job-p2"),
    ]) {
      const stored = await storage.stat(key);
      assert.ok(stored && stored.size !== null && stored.size > 0, `${key} should exist`);
    }
    assert.ok((await storage.list(jobKeys.shorts("job-p2"))).length > 0);
  });

  it("records a failure on the job instead of throwing", async () => {
    // A background caller has nowhere to catch, so runJob must never reject.
    const shared = deps();
    await shared.store.create({ id: "job-p3", filename: "notes.mp4", ownerId: "tester" });

    const job = await runJob({
      jobId: "job-p3",
      filename: "notes.mp4",
      source: Readable.from([Buffer.from("not a video")]),
      ...shared,
    });

    assert.equal(job.status, "failed");
    assert.ok(job.error && job.error.length > 0, "a failure message should be recorded");
  });

  it("rejects an unsupported container at the ingest stage", async () => {
    const shared = deps();
    await shared.store.create({ id: "job-p4", filename: "clip.avi", ownerId: "tester" });

    const job = await runJob({
      jobId: "job-p4",
      filename: "clip.avi",
      source: createReadStream(source),
      ...shared,
    });

    assert.equal(job.status, "failed");
    assert.match(job.error ?? "", /Unsupported file type/u);
  });
});

describe("captionsEnabled", () => {
  it("never captions stub output under auto", () => {
    // Burning "[untranscribed audio 0.0s-15.0s]" across every Short reads as a
    // bug to a viewer; no captions is the better failure.
    assert.equal(captionsEnabled("auto", "stub"), false);
  });

  it("captions real transcripts under auto", () => {
    assert.equal(captionsEnabled("auto", "deepgram"), true);
  });

  it("honours an explicit choice over the stub heuristic", () => {
    assert.equal(captionsEnabled("on", "stub"), true);
    assert.equal(captionsEnabled("off", "deepgram"), false);
  });
});
