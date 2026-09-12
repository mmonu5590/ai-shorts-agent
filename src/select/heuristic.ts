/**
 * A selector that needs no model.
 *
 * It spreads clips evenly across the source, snapping each boundary to the
 * nearest transcript segment edge so cuts land between utterances rather than
 * mid-word. That is not editorial judgement — it makes no claim about which
 * moments are good — but it produces a valid, renderable plan with no provider,
 * which makes it the default for local development and the fallback when a
 * model is unavailable.
 */

import { type EditPlan, DEFAULT_CONSTRAINTS } from "../plan/types.ts";
import { validateEditPlan } from "../plan/validate.ts";
import type { TranscriptSegment } from "../transcribe/types.ts";
import { type ClipSelector, type SelectionInput } from "./types.ts";

/** Nearest segment boundary to `time`, or `time` itself when none is closer. */
function snapToBoundary(time: number, segments: TranscriptSegment[], maxShift: number): number {
  let best = time;
  let bestDistance = maxShift;
  for (const segment of segments) {
    for (const boundary of [segment.start, segment.end]) {
      const distance = Math.abs(boundary - time);
      if (distance < bestDistance) {
        best = boundary;
        bestDistance = distance;
      }
    }
  }
  return best;
}

export interface HeuristicSelectorOptions {
  /** Preferred clip length before snapping, in seconds. */
  targetDurationSeconds?: number;
}

export class HeuristicClipSelector implements ClipSelector {
  readonly name = "heuristic";
  readonly #targetDuration: number;

  constructor(options: HeuristicSelectorOptions = {}) {
    this.#targetDuration = options.targetDurationSeconds ?? 30;
  }

  async select(input: SelectionInput): Promise<EditPlan> {
    const constraints = { ...DEFAULT_CONSTRAINTS, ...input.constraints };
    const duration = input.sourceDuration;
    const target = Math.min(this.#targetDuration, constraints.maxDurationSeconds);

    // Fit as many whole clips as the source allows, capped by the request and
    // the constraint ceiling.
    const fitted = Math.max(1, Math.floor(duration / target));
    const count = Math.min(fitted, input.targetClipCount ?? fitted, constraints.maxClips);
    const stride = duration / count;

    const clips = [];
    for (let index = 0; index < count; index += 1) {
      const rawStart = index * stride;
      const rawEnd = Math.min(rawStart + Math.min(target, stride), duration);
      // Never let snapping push a boundary more than a fifth of the clip.
      const slack = (rawEnd - rawStart) / 5;
      const start = index === 0 ? 0 : snapToBoundary(rawStart, input.transcript.segments, slack);
      const end = snapToBoundary(rawEnd, input.transcript.segments, slack);

      if (end - start < constraints.minDurationSeconds) continue;
      clips.push({
        id: `clip-${String(index + 1).padStart(2, "0")}`,
        start,
        end,
        reason: "Evenly spaced selection (no model)",
      });
    }

    return validateEditPlan(
      { version: 1, jobId: input.jobId, clips },
      { sourceDuration: duration, jobId: input.jobId, ...(input.constraints ? { constraints: input.constraints } : {}) },
    );
  }
}
