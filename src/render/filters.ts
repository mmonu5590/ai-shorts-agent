/**
 * ffmpeg filter construction for vertical output.
 *
 * Kept separate from process execution so the filter strings can be asserted
 * directly — a wrong crop expression is far easier to see as text than to infer
 * from a rendered frame.
 */

import { type Framing, type OutputSpec, DEFAULT_FRAMING } from "../plan/types.ts";

/** Formats a number for an ffmpeg expression, avoiding exponent notation. */
function num(value: number): string {
  return Number(value.toFixed(6)).toString();
}

/**
 * Builds the video filter chain that turns a source frame into `spec`.
 *
 * `crop` takes the largest window of the target aspect ratio that fits, so the
 * output always fills the frame. The branch matters: cropping a 16:9 source
 * means taking a tall slice (full height, reduced width), while a source that is
 * already taller than 9:16 needs the opposite — full width, reduced height.
 * Using one formula for both produces a crop window larger than the source,
 * which ffmpeg rejects.
 *
 * `pad` scales the whole frame to fit and fills the rest with black, losing
 * nothing but letterboxing the result.
 */
export function buildVerticalFilter(framing: Framing | undefined, spec: OutputSpec): string {
  const mode = framing?.mode ?? DEFAULT_FRAMING.mode;
  const { width, height } = spec;

  if (mode === "pad") {
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      "setsar=1",
    ].join(",");
  }

  const centerX = framing?.centerX ?? DEFAULT_FRAMING.centerX;
  const aspect = num(width / height);
  // `gt(iw/ih,aspect)` asks whether the source is wider than the target.
  const cropWidth = `if(gt(iw/ih\\,${aspect})\\,ih*${aspect}\\,iw)`;
  const cropHeight = `if(gt(iw/ih\\,${aspect})\\,ih\\,iw/${aspect})`;
  const cropX = `(iw-${cropWidth})*${num(centerX)}`;
  const cropY = `(ih-${cropHeight})/2`;

  return [
    `crop=${cropWidth}:${cropHeight}:${cropX}:${cropY}`,
    `scale=${width}:${height}:flags=lanczos`,
    "setsar=1",
  ].join(",");
}

/**
 * Builds the full ffmpeg argument list for one clip.
 *
 * `-ss` precedes `-i` so ffmpeg seeks before decoding rather than decoding and
 * discarding everything up to the cut; because the clip is re-encoded anyway,
 * the seek is still frame-accurate.
 */
export function buildClipArgs(options: {
  inputPath: string;
  outputPath: string;
  start: number;
  duration: number;
  framing: Framing | undefined;
  spec: OutputSpec;
}): string[] {
  const { inputPath, outputPath, start, duration, framing, spec } = options;

  return [
    "-nostdin",
    "-y",
    "-ss",
    num(start),
    "-i",
    inputPath,
    "-t",
    num(duration),
    "-vf",
    buildVerticalFilter(framing, spec),
    "-r",
    String(spec.frameRate),
    "-c:v",
    "libx264",
    "-preset",
    spec.preset,
    "-crf",
    String(spec.crf),
    // Required for playback on phones and in browsers; libx264 would otherwise
    // pick a 4:4:4 or 10-bit profile that many decoders reject.
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    spec.audioBitrate,
    // Moves the moov atom to the front so the file starts playing before it has
    // fully downloaded — the same property whose absence forces ingest to stage
    // uploads on disk.
    "-movflags",
    "+faststart",
    outputPath,
  ];
}
