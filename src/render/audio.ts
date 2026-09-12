/**
 * Audio conditioning for rendered Shorts.
 *
 * Source videos arrive at wildly different levels — a phone recording and a
 * studio podcast are 20 dB apart — and a Short that plays quiet next to the one
 * before it gets skipped. Platforms normalise on ingest anyway, so publishing
 * at their target means the picture the viewer hears is the one that was mixed,
 * not whatever the platform's own gain reduction leaves behind.
 */

export interface AudioProcessing {
  /** Integrated loudness target, LUFS. */
  targetLufs: number;
  /** Ceiling for true peaks, dBTP. Left of 0 so inter-sample peaks do not clip. */
  truePeakDb: number;
  /** Target loudness range, LU. */
  loudnessRange: number;
  /** Spectral denoise before normalising. */
  denoise: boolean;
  /** Noise reduction when `denoise` is on, dB. ffmpeg's afftdn accepts 0.01-97. */
  denoiseDb: number;
  /** Output sample rate. loudnorm runs at 192 kHz internally and must be resampled. */
  sampleRate: number;
}

/**
 * -14 LUFS is what the major short-form platforms normalise toward, so
 * delivering at it means their gain stage is close to a no-op.
 */
export const DEFAULT_AUDIO: AudioProcessing = {
  targetLufs: -14,
  truePeakDb: -1.5,
  loudnessRange: 11,
  denoise: false,
  denoiseDb: 12,
  sampleRate: 48_000,
};

/** Formats a number for a filter argument, refusing anything not finite. */
function num(value: number, field: string): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`Audio ${field} must be a finite number, got ${String(value)}`);
  }
  return Number(value.toFixed(4)).toString();
}

/**
 * Builds the `-af` chain, or undefined when there is nothing to do.
 *
 * Denoise runs first: measuring loudness before removing the noise floor lets
 * hiss pull the measurement up, and normalisation then under-shoots the target
 * by however loud the noise was.
 */
export function buildAudioFilter(audio: AudioProcessing | undefined): string | undefined {
  if (!audio) return undefined;

  // Every value is coerced rather than interpolated raw: these fields are
  // configuration today, but a filter graph is not a place to find out that
  // one of them later became a request parameter.
  const parts: string[] = [];
  if (audio.denoise) {
    parts.push(`afftdn=nr=${num(audio.denoiseDb, "denoiseDb")}`);
  }
  parts.push(
    `loudnorm=I=${num(audio.targetLufs, "targetLufs")}` +
      `:TP=${num(audio.truePeakDb, "truePeakDb")}` +
      `:LRA=${num(audio.loudnessRange, "loudnessRange")}`,
  );
  // loudnorm resamples to 192 kHz internally and emits at that rate. AAC tops
  // out at 96 kHz, so without this the encode fails on the way out.
  parts.push(`aresample=${num(audio.sampleRate, "sampleRate")}`);
  return parts.join(",");
}
