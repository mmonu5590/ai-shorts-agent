/**
 * Generates real media files with ffmpeg.
 *
 * The ingest stage is mostly a contract with ffmpeg, so the tests exercise the
 * actual binaries rather than a mock — a stubbed ffprobe would assert only that
 * the parser matches the stub.
 */

import { ffmpegBinary, run } from "../ffmpeg.ts";

export interface FixtureOptions {
  durationSeconds?: number;
  width?: number;
  height?: number;
  frameRate?: number;
  withAudio?: boolean;
}

/** Writes a synthetic test video to `outputPath`. */
export async function createTestVideo(outputPath: string, options: FixtureOptions = {}): Promise<void> {
  const duration = options.durationSeconds ?? 1;
  const width = options.width ?? 320;
  const height = options.height ?? 240;
  const frameRate = options.frameRate ?? 30;
  const withAudio = options.withAudio ?? true;

  const args = [
    "-nostdin",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=duration=${duration}:size=${width}x${height}:rate=${frameRate}`,
  ];
  if (withAudio) {
    args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${duration}`);
  }
  args.push("-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p");
  if (withAudio) {
    args.push("-c:a", "aac", "-shortest");
  }
  args.push(outputPath);

  await run(ffmpegBinary(), args);
}
