/**
 * Ingest: the first pipeline stage.
 *
 * Takes an uploaded video stream and leaves the job's storage prefix populated
 * with the source file, its metadata, and decoded audio ready for
 * transcription.
 *
 * The upload is staged on local disk before anything else happens. ffprobe and
 * ffmpeg both need a seekable input — an MP4 whose moov atom sits at the end of
 * the file cannot be read from a pipe — so streaming straight from the request
 * into ffmpeg is not an option.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { extractAudio } from "../media/audio.ts";
import { probeVideo } from "../media/probe.ts";
import {
  type SupportedExtension,
  type VideoMetadata,
  SUPPORTED_EXTENSIONS,
  UnsupportedMediaError,
} from "../media/types.ts";
import { type StorageAdapter, jobKeys } from "../storage/index.ts";

/** Container MIME types, so stored objects are not all octet-stream. */
const CONTENT_TYPES: Record<SupportedExtension, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  m4v: "video/x-m4v",
  webm: "video/webm",
  mkv: "video/x-matroska",
};

const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export interface IngestOptions {
  /** Identifies the job and names its storage prefix. */
  jobId: string;
  /** Original upload filename; only its extension is trusted. */
  filename: string;
  source: Readable;
  storage: StorageAdapter;
  /** Parent directory for staging. Defaults to the OS temp directory. */
  workDir?: string;
  /** Rejects longer inputs before any transcoding work is done. */
  maxDurationSeconds?: number;
}

export interface IngestResult {
  jobId: string;
  metadata: VideoMetadata;
  keys: {
    source: string;
    audio: string;
    metadata: string;
  };
}

/**
 * Extracts a supported extension from an upload filename.
 *
 * The filename is attacker-controlled, so only the extension is read from it —
 * it never contributes to a storage key or a filesystem path.
 */
export function resolveExtension(filename: string): SupportedExtension {
  const extension = path.extname(filename).replace(/^\./u, "").toLowerCase();
  if (!(SUPPORTED_EXTENSIONS as readonly string[]).includes(extension)) {
    throw new UnsupportedMediaError(
      `Unsupported file type "${extension || filename}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}`,
    );
  }
  return extension as SupportedExtension;
}

/**
 * Runs ingest for one job.
 *
 * Staged files are removed even when a step throws, so a failed upload cannot
 * leave a multi-gigabyte temp file behind.
 */
export async function ingestVideo(options: IngestOptions): Promise<IngestResult> {
  const { jobId, filename, source, storage } = options;

  if (!JOB_ID_PATTERN.test(jobId)) {
    throw new UnsupportedMediaError(
      `Invalid job ID "${jobId}"; expected 1-64 characters from [A-Za-z0-9_-]`,
    );
  }
  const extension = resolveExtension(filename);

  const stagingRoot = await mkdtemp(path.join(options.workDir ?? tmpdir(), `ingest-${jobId}-`));
  const stagedVideo = path.join(stagingRoot, `source.${extension}`);
  const stagedAudio = path.join(stagingRoot, "audio.wav");

  try {
    await pipeline(source, createWriteStream(stagedVideo));

    const { size } = await stat(stagedVideo);
    if (size === 0) {
      throw new UnsupportedMediaError("Uploaded file is empty");
    }

    const metadata = await probeVideo(stagedVideo);

    const limit = options.maxDurationSeconds;
    if (limit !== undefined && metadata.duration > limit) {
      throw new UnsupportedMediaError(
        `Video is ${metadata.duration.toFixed(1)}s, which exceeds the ${limit}s limit`,
      );
    }
    if (!metadata.audio) {
      throw new UnsupportedMediaError(
        "Video has no audio track, so it cannot be transcribed or clip-selected",
      );
    }

    await extractAudio(stagedVideo, stagedAudio);

    const keys = {
      source: jobKeys.source(jobId, extension),
      audio: jobKeys.audio(jobId),
      metadata: jobKeys.metadata(jobId),
    };

    await storage.put(keys.source, createReadStream(stagedVideo), {
      contentType: CONTENT_TYPES[extension],
      contentLength: size,
    });
    await storage.put(keys.audio, createReadStream(stagedAudio), { contentType: "audio/wav" });
    await storage.put(
      keys.metadata,
      // Stored alongside the media so later stages read metadata without
      // re-probing a file that may live in Drive.
      Readable.from([Buffer.from(JSON.stringify({ jobId, extension, ...metadata }, null, 2))]),
      { contentType: "application/json" },
    );

    return { jobId, metadata, keys };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
