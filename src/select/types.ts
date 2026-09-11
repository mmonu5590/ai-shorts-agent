/**
 * Provider-neutral clip selection.
 *
 * A selector reads a transcript and proposes which ranges of the source become
 * Shorts. Every selector returns a plan that has already been through
 * `validateEditPlan`, so downstream stages never see unvalidated model output.
 */

import type { EditPlan, ClipConstraints } from "../plan/types.ts";
import type { Transcript } from "../transcribe/types.ts";

export interface SelectionInput {
  jobId: string;
  transcript: Transcript;
  /** Authoritative duration from ingest. */
  sourceDuration: number;
  /** How many clips to aim for. Selectors may return fewer. */
  targetClipCount?: number;
  constraints?: Partial<ClipConstraints>;
}

export interface ClipSelector {
  readonly name: string;
  select(input: SelectionInput): Promise<EditPlan>;
}

export class ClipSelectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ClipSelectionError";
  }
}
