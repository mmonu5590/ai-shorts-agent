import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EditPlanError } from "../../plan/types.ts";
import type { Transcript } from "../../transcribe/types.ts";
import { ClaudeClipSelector } from "../claude.ts";
import { ClipSelectionError } from "../types.ts";

const TRANSCRIPT: Transcript = {
  language: "en",
  duration: 120,
  provider: "test",
  text: "hello",
  segments: [{ id: "s1", start: 0, end: 120, text: "hello" }],
};

/** Minimal stand-in for the Anthropic client's `messages.parse`. */
function fakeClient(response: unknown) {
  return { messages: { parse: async () => response } } as never;
}

function select(response: unknown) {
  return new ClaudeClipSelector({ client: fakeClient(response) }).select({
    jobId: "job-1",
    transcript: TRANSCRIPT,
    sourceDuration: 120,
  });
}

describe("ClaudeClipSelector", () => {
  it("turns a well-formed model response into a validated plan", async () => {
    const plan = await select({
      stop_reason: "end_turn",
      parsed_output: {
        clips: [
          {
            id: "clip-01",
            start: 10,
            end: 40,
            title: "The good part",
            reason: "Self-contained answer",
            framing: { mode: "crop", centerX: 0.5 },
          },
        ],
      },
    });

    assert.equal(plan.clips.length, 1);
    assert.equal(plan.clips[0]?.title, "The good part");
    assert.equal(plan.clips[0]?.framing?.centerX, 0.5);
  });

  it("rejects model timestamps that run past the real duration", async () => {
    // The schema guarantees numbers, not sensible ones; only ingest knows the
    // true length, so validation is what catches this.
    await assert.rejects(
      () =>
        select({
          stop_reason: "end_turn",
          parsed_output: {
            clips: [
              {
                id: "clip-01",
                start: 10,
                end: 900,
                title: "t",
                reason: "r",
                framing: { mode: "crop", centerX: 0.5 },
              },
            ],
          },
        }),
      EditPlanError,
    );
  });

  it("raises a clear error when the model declines", async () => {
    await assert.rejects(
      () => select({ stop_reason: "refusal", stop_details: { category: "cyber" }, parsed_output: null }),
      (error: unknown) =>
        error instanceof ClipSelectionError && /declined to select clips \(cyber\)/u.test(error.message),
    );
  });

  it("raises when the response carries no parsed output", async () => {
    await assert.rejects(
      () => select({ stop_reason: "end_turn", parsed_output: null }),
      (error: unknown) => error instanceof ClipSelectionError && /no parseable selection/u.test(error.message),
    );
  });

  it("wraps transport failures rather than leaking them", async () => {
    const client = {
      messages: {
        parse: async () => {
          throw new Error("socket hang up");
        },
      },
    } as never;

    await assert.rejects(
      () =>
        new ClaudeClipSelector({ client }).select({
          jobId: "job-1",
          transcript: TRANSCRIPT,
          sourceDuration: 120,
        }),
      ClipSelectionError,
    );
  });
});
