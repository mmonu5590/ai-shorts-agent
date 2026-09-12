/**
 * Clip selection backed by Claude.
 *
 * The model reads the timestamped transcript and proposes ranges. Its output is
 * constrained by a schema on the way out and re-validated by
 * `validateEditPlan` on the way in — the schema guarantees well-formed JSON,
 * not sensible timestamps, and only ingest knows how long the video actually
 * is.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { type EditPlan, DEFAULT_CONSTRAINTS } from "../plan/types.ts";
import { validateEditPlan } from "../plan/validate.ts";
import type { Transcript } from "../transcribe/types.ts";
import { type ClipSelector, type SelectionInput, ClipSelectionError } from "./types.ts";

const MODEL = "claude-opus-5";

const ClipSchema = z.object({
  id: z.string().describe("Short identifier, e.g. clip-01"),
  start: z.number().describe("Start time in seconds from the beginning of the video"),
  end: z.number().describe("End time in seconds from the beginning of the video"),
  title: z.string().describe("A title for the Short, under 60 characters"),
  reason: z.string().describe("Why this moment works as a standalone Short"),
  framing: z.object({
    mode: z.enum(["crop", "pad"]).describe("crop fills the vertical frame; pad letterboxes"),
    centerX: z
      .number()
      .describe("Horizontal centre of the crop, 0 is hard left and 1 is hard right"),
  }),
});

const SelectionSchema = z.object({
  clips: z.array(ClipSchema),
});

const SYSTEM_PROMPT = `You select moments from a long video to publish as vertical short-form clips.

You are given a timestamped transcript. Choose moments that work on their own:
a complete thought with a hook near the start, understandable to someone who has
not seen the rest of the video. Prefer a clean start on a sentence boundary.

Rules you must follow:
- Every timestamp is in seconds and must fall inside the video's duration.
- end must be greater than start.
- Do not propose overlapping clips.
- Return the clips in the order they appear in the video.
- If fewer good moments exist than requested, return fewer. Do not pad the list
  with weak material.`;

function formatTranscript(transcript: Transcript): string {
  return transcript.segments
    .map((segment) => `[${segment.start.toFixed(1)}-${segment.end.toFixed(1)}] ${segment.text}`)
    .join("\n");
}

export interface ClaudeClipSelectorOptions {
  /** Injectable for testing; defaults to a client resolved from the environment. */
  client?: Anthropic;
  model?: string;
}

export class ClaudeClipSelector implements ClipSelector {
  readonly name = "claude";
  readonly #client: Anthropic;
  readonly #model: string;

  constructor(options: ClaudeClipSelectorOptions = {}) {
    // A bare client resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an
    // `ant auth login` profile, in that order.
    this.#client = options.client ?? new Anthropic();
    this.#model = options.model ?? MODEL;
  }

  async select(input: SelectionInput): Promise<EditPlan> {
    const constraints = { ...DEFAULT_CONSTRAINTS, ...input.constraints };
    const wanted = input.targetClipCount ?? 3;

    const userPrompt = [
      `Video duration: ${input.sourceDuration.toFixed(1)} seconds.`,
      `Select up to ${Math.min(wanted, constraints.maxClips)} clips.`,
      `Each clip must be between ${constraints.minDurationSeconds} and ${constraints.maxDurationSeconds} seconds long.`,
      "",
      "Transcript:",
      formatTranscript(input.transcript),
    ].join("\n");

    let response;
    try {
      response = await this.#client.messages.parse({
        model: this.#model,
        max_tokens: 16000,
        thinking: { type: "adaptive" },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userPrompt }],
        output_config: { format: zodOutputFormat(SelectionSchema) },
      });
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError) {
        throw new ClipSelectionError(
          "Claude rejected the credentials. Set ANTHROPIC_API_KEY, or run `ant auth login`.",
          { cause: error },
        );
      }
      if (error instanceof Anthropic.RateLimitError) {
        throw new ClipSelectionError("Claude rate limit reached; retry later.", { cause: error });
      }
      throw new ClipSelectionError("Claude request failed", { cause: error });
    }

    // A refusal is an HTTP 200 with no usable content, so check before reading.
    if (response.stop_reason === "refusal") {
      throw new ClipSelectionError(
        `Claude declined to select clips (${response.stop_details?.category ?? "unspecified"})`,
      );
    }
    if (!response.parsed_output) {
      throw new ClipSelectionError("Claude returned no parseable selection");
    }

    return validateEditPlan(
      { version: 1, jobId: input.jobId, clips: response.parsed_output.clips },
      {
        sourceDuration: input.sourceDuration,
        jobId: input.jobId,
        ...(input.constraints ? { constraints: input.constraints } : {}),
      },
    );
  }
}
