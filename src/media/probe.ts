/**
 * Video inspection via ffprobe.
 */

import { ffprobeBinary, run } from "./ffmpeg.ts";
import {
  type AudioStreamInfo,
  type VideoMetadata,
  type VideoStreamInfo,
  MediaError,
  UnsupportedMediaError,
} from "./types.ts";

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  channels?: number;
  sample_rate?: string;
}

interface FfprobeOutput {
  format?: { duration?: string; size?: string; format_name?: string };
  streams?: FfprobeStream[];
}

/** Resolves ffprobe's rational frame rate (`"30000/1001"`) to a number. */
function parseFrameRate(rational: string | undefined): number {
  if (!rational) return 0;
  const [numerator, denominator] = rational.split("/");
  const top = Number(numerator);
  const bottom = denominator === undefined ? 1 : Number(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return 0;
  return top / bottom;
}

/**
 * Reads container and stream metadata from `filePath`.
 *
 * ffprobe needs a seekable file: an MP4 written with its moov atom at the end
 * cannot be inspected from a pipe, so callers stage uploads on disk first.
 *
 * @throws {UnsupportedMediaError} when the file has no video stream or no
 * usable duration — both make the file unplannable for clip selection.
 */
export async function probeVideo(filePath: string): Promise<VideoMetadata> {
  const { stdout } = await run(ffprobeBinary(), [
    "-v",
    "error",
    "-print_format",
    "json",
    "-show_format",
    "-show_streams",
    filePath,
  ]);

  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(stdout) as FfprobeOutput;
  } catch (error) {
    throw new MediaError(`ffprobe returned output that is not JSON for "${filePath}"`, { cause: error });
  }

  const streams = parsed.streams ?? [];
  const videoStream = streams.find(
    // Cover art in an audio container is reported as a video stream, so require
    // real dimensions rather than trusting codec_type alone.
    (stream) => stream.codec_type === "video" && (stream.width ?? 0) > 0 && (stream.height ?? 0) > 0,
  );
  if (!videoStream) {
    throw new UnsupportedMediaError(`"${filePath}" contains no video stream`);
  }

  const duration = Number(parsed.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new UnsupportedMediaError(
      `"${filePath}" has no usable duration; the file may be truncated or still uploading`,
    );
  }

  const video: VideoStreamInfo = {
    codec: videoStream.codec_name ?? "unknown",
    width: videoStream.width as number,
    height: videoStream.height as number,
    frameRate: parseFrameRate(videoStream.r_frame_rate),
  };

  const audioStream = streams.find((stream) => stream.codec_type === "audio");
  const audio: AudioStreamInfo | null = audioStream
    ? {
        codec: audioStream.codec_name ?? "unknown",
        channels: audioStream.channels ?? 0,
        sampleRate: Number(audioStream.sample_rate ?? 0),
      }
    : null;

  return {
    duration,
    sizeBytes: Number(parsed.format?.size ?? 0),
    formatName: parsed.format?.format_name ?? "unknown",
    video,
    audio,
  };
}
