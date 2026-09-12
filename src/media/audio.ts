/**
 * Audio extraction for the transcription stage.
 */

import { ffmpegBinary, run } from "./ffmpeg.ts";
import { UnsupportedMediaError } from "./types.ts";

export interface ExtractAudioOptions {
  /**
   * Output sample rate. Defaults to 16 kHz, which is what speech-recognition
   * models expect; higher rates cost bytes without improving transcription.
   */
  sampleRate?: number;
  /** Output channel count. Defaults to mono, for the same reason. */
  channels?: number;
}

/**
 * Decodes the audio track of `inputPath` to a PCM WAV at `outputPath`.
 *
 * @throws {UnsupportedMediaError} when the input has no audio track — callers
 * should check {@link VideoMetadata.audio} first and surface this to the user,
 * since a silent video cannot be transcribed or clip-selected.
 */
export async function extractAudio(
  inputPath: string,
  outputPath: string,
  options: ExtractAudioOptions = {},
): Promise<void> {
  const sampleRate = options.sampleRate ?? 16_000;
  const channels = options.channels ?? 1;

  try {
    await run(ffmpegBinary(), [
      "-nostdin",
      "-y",
      "-i",
      inputPath,
      // Drop every non-audio stream; without this, cover art becomes a video
      // stream in the output and ffmpeg fails on a WAV container.
      "-vn",
      "-map",
      "0:a:0",
      "-acodec",
      "pcm_s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      String(channels),
      outputPath,
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Stream map .* matches no streams|does not contain any stream/u.test(message)) {
      throw new UnsupportedMediaError(`"${inputPath}" has no audio track to extract`);
    }
    throw error;
  }
}
