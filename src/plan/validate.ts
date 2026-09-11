/**
 * The trust boundary for edit plans.
 *
 * An edit plan arrives as whatever a language model emitted. It can be missing
 * fields, carry strings where numbers belong, name ranges past the end of the
 * video, or propose a hundred clips. This module turns that into a typed
 * {@link EditPlan} or refuses it.
 *
 * Every issue is collected rather than thrown at the first one: the whole list
 * is what you feed back to the model on a retry, and fixing one problem at a
 * time wastes a round trip each.
 */

import {
  type Clip,
  type ClipConstraints,
  type EditPlan,
  type Framing,
  type FramingMode,
  DEFAULT_CONSTRAINTS,
  DEFAULT_FRAMING,
  EDIT_PLAN_VERSION,
  EditPlanError,
} from "./types.ts";

/**
 * Tolerance for a clip that runs past the end of the source.
 *
 * Models habitually round the final timestamp up. Within this margin the end is
 * clamped to the source duration; beyond it the clip is rejected, because that
 * is a model that has lost track of the video rather than one that rounded.
 */
const END_OVERSHOOT_TOLERANCE_SECONDS = 0.5;

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const CLIP_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const FRAMING_MODES: readonly FramingMode[] = ["crop", "pad"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Accepts only real finite numbers — not strings, NaN, or Infinity. */
function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validateFraming(raw: unknown, clipLabel: string, issues: string[]): Framing {
  if (raw === undefined) {
    return { ...DEFAULT_FRAMING };
  }
  if (!isRecord(raw)) {
    issues.push(`${clipLabel}: framing must be an object`);
    return { ...DEFAULT_FRAMING };
  }

  const mode = raw["mode"];
  const resolvedMode: FramingMode = FRAMING_MODES.includes(mode as FramingMode)
    ? (mode as FramingMode)
    : (() => {
        if (mode !== undefined) {
          issues.push(`${clipLabel}: framing.mode must be one of ${FRAMING_MODES.join(", ")}`);
        }
        return DEFAULT_FRAMING.mode;
      })();

  let centerX = DEFAULT_FRAMING.centerX;
  if (raw["centerX"] !== undefined) {
    const parsed = finiteNumber(raw["centerX"]);
    if (parsed === null || parsed < 0 || parsed > 1) {
      issues.push(`${clipLabel}: framing.centerX must be a number between 0 and 1`);
    } else {
      centerX = parsed;
    }
  }

  return { mode: resolvedMode, centerX };
}

function validateClip(
  raw: unknown,
  index: number,
  sourceDuration: number,
  constraints: ClipConstraints,
  issues: string[],
): Clip | null {
  const label = `clips[${index}]`;
  if (!isRecord(raw)) {
    issues.push(`${label}: must be an object`);
    return null;
  }

  const id = raw["id"];
  if (typeof id !== "string" || !CLIP_ID_PATTERN.test(id)) {
    issues.push(`${label}: id must be 1-64 characters from [A-Za-z0-9_-]`);
    return null;
  }

  const start = finiteNumber(raw["start"]);
  const rawEnd = finiteNumber(raw["end"]);
  if (start === null || rawEnd === null) {
    issues.push(`${label}: start and end must be finite numbers in seconds`);
    return null;
  }
  if (start < 0) {
    issues.push(`${label}: start must not be negative`);
    return null;
  }
  if (rawEnd <= start) {
    issues.push(`${label}: end (${rawEnd}) must be greater than start (${start})`);
    return null;
  }
  if (start >= sourceDuration) {
    issues.push(`${label}: start (${start}s) is beyond the source duration (${sourceDuration}s)`);
    return null;
  }

  let end = rawEnd;
  if (end > sourceDuration) {
    if (end - sourceDuration > END_OVERSHOOT_TOLERANCE_SECONDS) {
      issues.push(`${label}: end (${end}s) is beyond the source duration (${sourceDuration}s)`);
      return null;
    }
    end = sourceDuration;
  }

  const duration = end - start;
  if (duration < constraints.minDurationSeconds) {
    issues.push(
      `${label}: duration ${duration.toFixed(2)}s is under the ${constraints.minDurationSeconds}s minimum`,
    );
    return null;
  }
  if (duration > constraints.maxDurationSeconds) {
    issues.push(
      `${label}: duration ${duration.toFixed(2)}s exceeds the ${constraints.maxDurationSeconds}s maximum`,
    );
    return null;
  }

  const framing = validateFraming(raw["framing"], label, issues);
  const title = raw["title"];
  const reason = raw["reason"];

  return {
    id,
    start,
    end,
    framing,
    ...(typeof title === "string" && title.length > 0 ? { title } : {}),
    ...(typeof reason === "string" && reason.length > 0 ? { reason } : {}),
  };
}

export interface ValidateOptions {
  /** Authoritative source duration, from ingest — not from the model. */
  sourceDuration: number;
  /** Expected job ID. A plan naming a different job is rejected. */
  jobId?: string;
  constraints?: Partial<ClipConstraints>;
}

/**
 * Validates arbitrary input as an {@link EditPlan}.
 *
 * @throws {EditPlanError} listing every problem found.
 */
export function validateEditPlan(raw: unknown, options: ValidateOptions): EditPlan {
  const constraints: ClipConstraints = { ...DEFAULT_CONSTRAINTS, ...options.constraints };
  const issues: string[] = [];

  if (!isRecord(raw)) {
    throw new EditPlanError(["plan must be a JSON object"]);
  }

  if (raw["version"] !== EDIT_PLAN_VERSION) {
    issues.push(`version must be ${EDIT_PLAN_VERSION}, got ${JSON.stringify(raw["version"])}`);
  }

  const jobId = raw["jobId"];
  if (typeof jobId !== "string" || !JOB_ID_PATTERN.test(jobId)) {
    issues.push("jobId must be 1-64 characters from [A-Za-z0-9_-]");
  } else if (options.jobId !== undefined && jobId !== options.jobId) {
    issues.push(`jobId "${jobId}" does not match the job being processed ("${options.jobId}")`);
  }

  // The model's own idea of the duration is advisory; ingest's measurement wins.
  const sourceDuration = options.sourceDuration;
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
    throw new EditPlanError([`sourceDuration must be a positive number, got ${sourceDuration}`]);
  }

  const rawClips = raw["clips"];
  if (!Array.isArray(rawClips)) {
    issues.push("clips must be an array");
    throw new EditPlanError(issues);
  }
  if (rawClips.length === 0) {
    issues.push("clips must contain at least one clip");
  }
  if (rawClips.length > constraints.maxClips) {
    issues.push(`clips contains ${rawClips.length} entries, over the ${constraints.maxClips} maximum`);
  }

  const clips: Clip[] = [];
  const seenIds = new Set<string>();
  for (const [index, rawClip] of rawClips.entries()) {
    const clip = validateClip(rawClip, index, sourceDuration, constraints, issues);
    if (!clip) continue;
    if (seenIds.has(clip.id)) {
      issues.push(`clips[${index}]: duplicate id "${clip.id}"`);
      continue;
    }
    seenIds.add(clip.id);
    clips.push(clip);
  }

  if (issues.length > 0) {
    throw new EditPlanError(issues);
  }

  return {
    version: EDIT_PLAN_VERSION,
    jobId: jobId as string,
    sourceDuration,
    clips,
  };
}
