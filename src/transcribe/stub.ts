/**
 * A transcriber that invents nothing and requires no provider.
 *
 * It measures the audio and emits evenly spaced placeholder segments. That is
 * useless for real clip selection, which is the point: it lets the pipeline run
 * end to end — ingest, select, render — without credentials, so the wiring can
 * be tested on its own. Selecting real clips needs a real provider.
 */

import { probeVideo } from "../media/probe.ts";
import { ffprobeBinary, run } from "../media/ffmpeg.ts";
import {
  type Transcriber,
  type Transcript,
  type TranscriptSegment,
  TranscriptionError,
  joinSegments,
} from "./types.ts";

export interface StubTranscriberOptions {
  /** Length of each placeholder segment, in seconds. */
  segmentSeconds?: number;
}

/** Reads a duration from any media file, including audio-only ones. */
async function audioDuration(filePath: string): Promise<number> {
  const { stdout } = await run(ffprobeBinary(), [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    filePath,
  ]);
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new TranscriptionError(`Could not read a duration from "${filePath}"`);
  }
  return duration;
}

export class StubTranscriber implements Transcriber {
  readonly name = "stub";
  readonly #segmentSeconds: number;

  constructor(options: StubTranscriberOptions = {}) {
    this.#segmentSeconds = options.segmentSeconds ?? 15;
  }

  async transcribe(audioPath: string): Promise<Transcript> {
    const duration = await audioDuration(audioPath).catch(async (error: unknown) => {
      // Fall back to the video prober for containers ffprobe reports differently.
      try {
        return (await probeVideo(audioPath)).duration;
      } catch {
        throw error;
      }
    });

    const segments: TranscriptSegment[] = [];
    for (let start = 0, index = 0; start < duration; start += this.#segmentSeconds, index += 1) {
      const end = Math.min(start + this.#segmentSeconds, duration);
      segments.push({
        id: `seg-${String(index + 1).padStart(3, "0")}`,
        start,
        end,
        text: `[untranscribed audio ${start.toFixed(1)}s-${end.toFixed(1)}s]`,
      });
    }

    return {
      language: null,
      duration,
      segments,
      text: joinSegments(segments),
      provider: this.name,
    };
  }
}
