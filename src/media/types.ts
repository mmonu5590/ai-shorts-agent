/**
 * Media inspection types. The pipeline plans edits against these numbers, so a
 * missing duration or resolution is an error rather than a defaulted zero.
 */

/** Container formats accepted for upload, mapped to their canonical extension. */
export const SUPPORTED_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "mkv"] as const;

export type SupportedExtension = (typeof SUPPORTED_EXTENSIONS)[number];

export interface VideoStreamInfo {
  codec: string;
  width: number;
  height: number;
  /** Frames per second, resolved from ffprobe's rational `r_frame_rate`. */
  frameRate: number;
}

export interface AudioStreamInfo {
  codec: string;
  channels: number;
  sampleRate: number;
}

export interface VideoMetadata {
  /** Duration in seconds. */
  duration: number;
  sizeBytes: number;
  formatName: string;
  video: VideoStreamInfo;
  /** Null when the container carries no audio track. */
  audio: AudioStreamInfo | null;
}

export class MediaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MediaError";
  }
}

/** Raised when the ffmpeg/ffprobe binaries are missing from PATH. */
export class FfmpegUnavailableError extends MediaError {
  readonly binary: string;

  constructor(binary: string) {
    super(
      `${binary} was not found. Install ffmpeg and ensure it is on PATH, or set ` +
        `${binary === "ffprobe" ? "FFPROBE_PATH" : "FFMPEG_PATH"} to its location.`,
    );
    this.name = "FfmpegUnavailableError";
    this.binary = binary;
  }
}

/** Raised when a file is not usable as pipeline input. */
export class UnsupportedMediaError extends MediaError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMediaError";
  }
}
