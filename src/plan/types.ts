/**
 * The edit plan: the contract between the AI half of the pipeline and the
 * deterministic half.
 *
 * A language model proposes an edit plan; ffmpeg executes it. Nothing in this
 * file is trusted on arrival — see `validate.ts`, which is the boundary where
 * model output becomes a usable plan.
 */

/** Bumped when the shape changes incompatibly, so stored plans stay readable. */
export const EDIT_PLAN_VERSION = 1;

/**
 * How a clip is fitted into a vertical frame.
 *
 * - `crop` takes a 9:16 window out of the source, discarding the sides. It
 *   fills the frame, which is what viewers expect from a Short.
 * - `pad` scales the whole frame to fit and fills the remainder with black.
 *   Nothing is lost, but the result is letterboxed.
 */
export type FramingMode = "crop" | "pad";

export interface Framing {
  mode: FramingMode;
  /**
   * Horizontal centre of the crop window, from 0 (hard left) to 1 (hard right).
   * Defaults to 0.5. Ignored in `pad` mode.
   *
   * This is the hook face tracking will drive later; for now a model can aim it
   * at whoever is speaking.
   */
  centerX?: number;
}

export interface Clip {
  /** Stable identifier, unique within the plan. */
  id: string;
  /** Start offset in the source, in seconds. */
  start: number;
  /** End offset in the source, in seconds. Exclusive of nothing — just the cut point. */
  end: number;
  /** Suggested title for the Short. */
  title?: string;
  /** Why the model chose this range. Carried through for review and debugging. */
  reason?: string;
  framing?: Framing;
}

export interface EditPlan {
  version: typeof EDIT_PLAN_VERSION;
  jobId: string;
  /** Duration of the source the plan was built against, for validation. */
  sourceDuration: number;
  clips: Clip[];
}

export interface OutputSpec {
  width: number;
  height: number;
  frameRate: number;
  /** libx264 CRF. Lower is better quality and larger. */
  crf: number;
  preset: string;
  audioBitrate: string;
}

/** 1080x1920 at 30 fps — the standard vertical Short. */
export const DEFAULT_OUTPUT: OutputSpec = {
  width: 1080,
  height: 1920,
  frameRate: 30,
  crf: 23,
  preset: "veryfast",
  audioBitrate: "128k",
};

export const DEFAULT_FRAMING: Required<Framing> = { mode: "crop", centerX: 0.5 };

/** Bounds a clip must satisfy to be renderable as a Short. */
export interface ClipConstraints {
  minDurationSeconds: number;
  maxDurationSeconds: number;
  maxClips: number;
}

export const DEFAULT_CONSTRAINTS: ClipConstraints = {
  minDurationSeconds: 3,
  maxDurationSeconds: 90,
  maxClips: 20,
};

export class EditPlanError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid edit plan:\n  - ${issues.join("\n  - ")}`);
    this.name = "EditPlanError";
    this.issues = issues;
  }
}
