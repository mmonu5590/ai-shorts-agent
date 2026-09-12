/**
 * Choosing where the 9:16 crop window sits.
 *
 * A centred crop is right only when the subject is centred. When a speaker
 * stands to one side, or the frame is a two-shot, the default throws away the
 * half that matters. `centerX` already exists on the edit plan as the hook for
 * this; nothing was driving it.
 *
 * {@link MotionFrameAnalyzer} drives it from where the picture actually
 * changes, which needs no model and no dependency. A face detector can be
 * dropped in behind the same interface later — that is the point of the
 * interface.
 */

import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { ffmpegBinary, run } from "../media/ffmpeg.ts";
import type { Clip } from "../plan/types.ts";

export interface FrameAnalyzer {
  readonly name: string;
  /**
   * Horizontal centre for the crop window, 0 to 1, or null when the clip gives
   * no usable signal and the caller should keep whatever it already had.
   */
  analyze(videoPath: string, clip: Clip, targetAspect: number): Promise<number | null>;
}

export interface MotionFrameAnalyzerOptions {
  /** Frames sampled per second of clip. */
  sampleFps?: number;
  /** Width of the downscaled analysis frames, in columns. */
  columns?: number;
  /** Height of the downscaled analysis frames, in rows. */
  rows?: number;
  /** Directory for the sampled frames. Defaults to the video's directory. */
  workDir?: string;
}

/** Column-wise temporal variance: how much each column changes over time. */
export function columnActivity(frames: Buffer[], columns: number, rows: number): number[] {
  if (frames.length < 2) return new Array<number>(columns).fill(0);

  const activity = new Array<number>(columns).fill(0);
  for (let frame = 1; frame < frames.length; frame += 1) {
    const current = frames[frame] as Buffer;
    const previous = frames[frame - 1] as Buffer;
    for (let row = 0; row < rows; row += 1) {
      const offset = row * columns;
      for (let column = 0; column < columns; column += 1) {
        activity[column] =
          (activity[column] as number) +
          Math.abs((current[offset + column] as number) - (previous[offset + column] as number));
      }
    }
  }
  return activity;
}

/**
 * Finds the window of `windowColumns` with the most activity and returns its
 * centre as a 0-1 position, matching how the crop filter reads `centerX`:
 * `x = (iw - cropWidth) * centerX`.
 */
export function bestWindowCenter(activity: number[], windowColumns: number): number | null {
  const columns = activity.length;
  const width = Math.max(1, Math.min(columns, Math.round(windowColumns)));
  if (width >= columns) return null;

  const total = activity.reduce((sum, value) => sum + value, 0);
  // A still frame gives every window the same score; picking a side would be
  // inventing a subject that is not there.
  if (total <= 0) return null;

  let running = 0;
  for (let column = 0; column < width; column += 1) running += activity[column] as number;

  let bestScore = running;
  let bestLeft = 0;
  for (let left = 1; left + width <= columns; left += 1) {
    running += (activity[left + width - 1] as number) - (activity[left - 1] as number);
    if (running > bestScore) {
      bestScore = running;
      bestLeft = left;
    }
  }

  // Every window scoring alike means no usable signal, not a centred subject.
  if (bestScore <= 0) return null;
  return bestLeft / (columns - width);
}

/** Splits a rawvideo gray buffer into equally sized frames. */
export function splitFrames(raw: Buffer, columns: number, rows: number): Buffer[] {
  const frameSize = columns * rows;
  const count = Math.floor(raw.length / frameSize);
  return Array.from({ length: count }, (_, index) =>
    raw.subarray(index * frameSize, (index + 1) * frameSize),
  );
}

export class MotionFrameAnalyzer implements FrameAnalyzer {
  readonly name = "motion";

  readonly #sampleFps: number;
  readonly #columns: number;
  readonly #rows: number;
  readonly #workDir: string | undefined;

  constructor(options: MotionFrameAnalyzerOptions = {}) {
    this.#sampleFps = options.sampleFps ?? 4;
    this.#columns = options.columns ?? 64;
    this.#rows = options.rows ?? 36;
    this.#workDir = options.workDir;
  }

  async analyze(videoPath: string, clip: Clip, targetAspect: number): Promise<number | null> {
    const directory = this.#workDir ?? path.dirname(videoPath);
    const rawPath = path.join(directory, `autoframe-${clip.id}.gray`);

    try {
      // Sampled small and in grayscale: this is a question about where motion
      // is, and decoding the clip at full resolution to answer it would cost
      // more than the render.
      await run(ffmpegBinary(), [
        "-nostdin", "-y",
        "-ss", String(clip.start),
        "-i", videoPath,
        "-t", String(clip.end - clip.start),
        "-vf", `fps=${this.#sampleFps},scale=${this.#columns}:${this.#rows}`,
        "-f", "rawvideo", "-pix_fmt", "gray",
        rawPath,
      ]);

      const frames = splitFrames(await readFile(rawPath), this.#columns, this.#rows);
      if (frames.length < 2) return null;

      const activity = columnActivity(frames, this.#columns, this.#rows);

      // Source aspect comes from the sampled frames' own shape only after
      // scaling, so derive the window from the probed source instead.
      const sourceAspect = await this.#sourceAspect(videoPath);
      if (sourceAspect === null || sourceAspect <= targetAspect) return null;

      const windowColumns = this.#columns * (targetAspect / sourceAspect);
      return bestWindowCenter(activity, windowColumns);
    } finally {
      await rm(rawPath, { force: true });
    }
  }

  async #sourceAspect(videoPath: string): Promise<number | null> {
    const { probeVideo } = await import("../media/probe.ts");
    try {
      const { video } = await probeVideo(videoPath);
      return video.height > 0 ? video.width / video.height : null;
    } catch {
      return null;
    }
  }
}
