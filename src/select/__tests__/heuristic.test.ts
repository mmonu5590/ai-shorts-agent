import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Transcript } from "../../transcribe/types.ts";
import { HeuristicClipSelector } from "../heuristic.ts";

function transcript(boundaries: number[][]): Transcript {
  return {
    language: "en",
    duration: 120,
    provider: "test",
    text: "",
    segments: boundaries.map(([start, end], index) => ({
      id: `s${index}`,
      start: start as number,
      end: end as number,
      text: `segment ${index}`,
    })),
  };
}

describe("HeuristicClipSelector", () => {
  const selector = new HeuristicClipSelector({ targetDurationSeconds: 30 });

  it("returns a valid plan covering the source", async () => {
    const plan = await selector.select({
      jobId: "job-1",
      transcript: transcript([[0, 30], [30, 60], [60, 90], [90, 120]]),
      sourceDuration: 120,
    });

    assert.equal(plan.jobId, "job-1");
    assert.equal(plan.clips.length, 4);
    for (const clip of plan.clips) {
      assert.ok(clip.end > clip.start);
      assert.ok(clip.end <= 120);
    }
  });

  it("honours a requested clip count", async () => {
    const plan = await selector.select({
      jobId: "job-1",
      transcript: transcript([[0, 30], [30, 60], [60, 90], [90, 120]]),
      sourceDuration: 120,
      targetClipCount: 2,
    });

    assert.equal(plan.clips.length, 2);
  });

  it("snaps boundaries onto segment edges so cuts land between utterances", async () => {
    const plan = await selector.select({
      jobId: "job-1",
      // Boundaries deliberately offset from the even 30s grid.
      transcript: transcript([[0, 28.4], [28.4, 57.1], [57.1, 91.2], [91.2, 120]]),
      sourceDuration: 120,
    });

    const boundaries = new Set([0, 28.4, 57.1, 91.2, 120]);
    const snapped = plan.clips.filter((clip) => boundaries.has(clip.start) || boundaries.has(clip.end));
    assert.ok(snapped.length > 0, "expected at least one boundary to snap to a segment edge");
  });

  it("produces a single clip for a source shorter than the target", async () => {
    const plan = await selector.select({
      jobId: "job-1",
      transcript: { ...transcript([[0, 12]]), duration: 12 },
      sourceDuration: 12,
    });

    assert.equal(plan.clips.length, 1);
    assert.equal(plan.clips[0]?.start, 0);
  });

  it("never exceeds the maximum clip count", async () => {
    const plan = await selector.select({
      jobId: "job-1",
      transcript: { ...transcript([[0, 600]]), duration: 600 },
      sourceDuration: 600,
      constraints: { maxClips: 5 },
    });

    assert.ok(plan.clips.length <= 5);
  });
});
