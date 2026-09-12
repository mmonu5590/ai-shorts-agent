/**
 * Rendering: the deterministic half of the pipeline.
 *
 * A model proposes an edit plan; this module executes it. Nothing here makes
 * creative decisions — every frame of the output follows from the validated
 * plan and the output spec, so the same plan and source always render the same
 * Shorts.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { ffmpegBinary, run } from "../media/ffmpeg.ts";
import { probeVideo } from "../media/probe.ts";
import { type Clip, type EditPlan, type OutputSpec, DEFAULT_OUTPUT } from "../plan/types.ts";
import { type StorageAdapter, jobKeys } from "../storage/index.ts";
import type { Transcript } from "../transcribe/types.ts";
import {
  type CaptionStyle,
  type CueOptions,
  DEFAULT_CAPTION_STYLE,
  buildSubtitlesFilter,
  clipCues,
  toSrt,
} from "./captions.ts";
import { type AudioProcessing, DEFAULT_AUDIO } from "./audio.ts";
import type { FrameAnalyzer } from "./autoframe.ts";
import { buildClipArgs } from "./filters.ts";

export * from "./audio.ts";
export * from "./autoframe.ts";
export * from "./captions.ts";
export { buildClipArgs, buildVerticalFilter } from "./filters.ts";

/** Raised when ffmpeg reported success but produced nothing usable. */
export class RenderError extends Error {
  readonly clipId: string;

  constructor(clipId: string, message: string, options?: { cause?: unknown }) {
    super(`Clip "${clipId}": ${message}`, options);
    this.name = "RenderError";
    this.clipId = clipId;
  }
}

export interface RenderClipOptions {
  inputPath: string;
  outputPath: string;
  clip: Clip;
  spec?: OutputSpec;
  /** Path to an SRT file to burn into the frame. */
  subtitlesPath?: string;
  captionStyle?: CaptionStyle;
  /** Audio conditioning. Defaults to {@link DEFAULT_AUDIO}; pass null to skip. */
  audio?: AudioProcessing | null;
}

/** Renders one clip from a local source file to a local output file. */
export async function renderClip(options: RenderClipOptions): Promise<void> {
  const spec = options.spec ?? DEFAULT_OUTPUT;
  const { clip } = options;

  const overlayFilter = options.subtitlesPath
    ? buildSubtitlesFilter(
        options.subtitlesPath,
        options.captionStyle ?? DEFAULT_CAPTION_STYLE,
        spec.height,
      )
    : undefined;

  await run(
    ffmpegBinary(),
    buildClipArgs({
      inputPath: options.inputPath,
      outputPath: options.outputPath,
      start: clip.start,
      duration: clip.end - clip.start,
      framing: clip.framing,
      spec,
      overlayFilter,
      audio: options.audio === null ? undefined : (options.audio ?? DEFAULT_AUDIO),
    }),
  );

  // A zero exit status is not proof of a usable clip. Seeking past the end of
  // the source makes ffmpeg write a valid container with no frames in it and
  // exit 0, which would otherwise be stored and served as a broken Short.
  let rendered;
  try {
    rendered = await probeVideo(options.outputPath);
  } catch (error) {
    throw new RenderError(
      clip.id,
      "ffmpeg reported success but produced no readable video",
      { cause: error },
    );
  }
  if (rendered.duration <= 0) {
    throw new RenderError(clip.id, "rendered output has zero duration");
  }
}

export interface RenderedShort {
  clipId: string;
  key: string;
  index: number;
  durationSeconds: number;
  sizeBytes: number;
}

export interface CaptionSettings {
  enabled: boolean;
  style?: CaptionStyle;
  cues?: CueOptions;
}

export interface RenderPlanOptions {
  plan: EditPlan;
  storage: StorageAdapter;
  /** Storage key of the source video, as returned by ingest. */
  sourceKey: string;
  spec?: OutputSpec;
  workDir?: string;
  /** Called after each clip, for job progress reporting. */
  onProgress?: (completed: number, total: number) => void;
  /** Source of caption text. Captions are skipped without it. */
  transcript?: Transcript;
  captions?: CaptionSettings;
  /** Audio conditioning for every clip. Pass null to leave audio untouched. */
  audio?: AudioProcessing | null;
  /**
   * Chooses the crop window per clip, overriding the plan's `centerX`.
   *
   * The plan's value is the selector's guess from a transcript; the analyzer
   * looks at the actual picture, so when both are present the picture wins.
   * Only applies to crop framing — `pad` keeps the whole frame anyway.
   */
  autoFrame?: FrameAnalyzer | null;
}

export interface RenderPlanResult {
  jobId: string;
  shorts: RenderedShort[];
}

/**
 * Renders every clip in `plan` and stores the results under the job's prefix.
 *
 * The source is pulled to local disk once and reused for all clips: ffmpeg needs
 * a seekable input, and re-fetching a multi-gigabyte video from Drive for each
 * clip would dominate the render time.
 */
export async function renderPlan(options: RenderPlanOptions): Promise<RenderPlanResult> {
  const { plan, storage, sourceKey } = options;
  const spec = options.spec ?? DEFAULT_OUTPUT;

  const stagingRoot = await mkdtemp(path.join(options.workDir ?? tmpdir(), `render-${plan.jobId}-`));
  const localSource = path.join(stagingRoot, `source${path.extname(sourceKey)}`);

  try {
    await pipeline(await storage.get(sourceKey), createWriteStream(localSource));

    const captionsOn = Boolean(options.captions?.enabled && options.transcript);

    const targetAspect = spec.width / spec.height;

    const shorts: RenderedShort[] = [];
    for (const [index, rawClip] of plan.clips.entries()) {
      const outputPath = path.join(stagingRoot, `clip-${index + 1}.mp4`);

      let clip = rawClip;
      if (options.autoFrame && (clip.framing?.mode ?? "crop") === "crop") {
        const centerX = await options.autoFrame.analyze(localSource, clip, targetAspect);
        // null means the analyzer found nothing to go on, so the plan's value
        // stands rather than being replaced by a fabricated one.
        if (centerX !== null) {
          clip = { ...clip, framing: { mode: "crop", centerX } };
        }
      }

      // An empty SRT makes libass draw nothing but still costs a filter pass,
      // so the filter is only added when there is something to show.
      let subtitlesPath: string | undefined;
      if (captionsOn) {
        const srt = toSrt(clipCues(options.transcript as Transcript, clip, options.captions?.cues ?? {}));
        if (srt.length > 0) {
          subtitlesPath = path.join(stagingRoot, `clip-${index + 1}.srt`);
          await writeFile(subtitlesPath, srt, "utf8");
        }
      }

      await renderClip({
        inputPath: localSource,
        outputPath,
        clip,
        spec,
        ...(subtitlesPath ? { subtitlesPath } : {}),
        ...(options.captions?.style ? { captionStyle: options.captions.style } : {}),
        ...(options.audio === undefined ? {} : { audio: options.audio }),
      });

      const key = jobKeys.short(plan.jobId, index + 1);
      const { size } = await stat(outputPath);
      await storage.put(key, createReadStream(outputPath), {
        contentType: "video/mp4",
        contentLength: size,
      });

      shorts.push({
        clipId: clip.id,
        key,
        index: index + 1,
        durationSeconds: clip.end - clip.start,
        sizeBytes: size,
      });

      // Remove each rendered clip once stored; a 20-clip plan would otherwise
      // hold every output on disk at once alongside the source.
      await rm(outputPath, { force: true });
      options.onProgress?.(index + 1, plan.clips.length);
    }

    return { jobId: plan.jobId, shorts };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
