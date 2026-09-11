/**
 * Provider-neutral transcription interface.
 *
 * Transcription is where the pipeline stops being deterministic. Every provider
 * returns a different shape, so this is the shape the rest of the pipeline sees;
 * adapters translate into it.
 */

export interface TranscriptWord {
  text: string;
  /** Seconds from the start of the audio. */
  start: number;
  end: number;
}

export interface TranscriptSegment {
  id: string;
  start: number;
  end: number;
  text: string;
  /** Word-level timings, when the provider supplies them. */
  words?: TranscriptWord[];
}

export interface Transcript {
  /** BCP-47 language tag, or null when the provider does not detect one. */
  language: string | null;
  /** Total audio duration in seconds. */
  duration: number;
  segments: TranscriptSegment[];
  /** The full text, for providers and prompts that want it in one piece. */
  text: string;
  /** Name of the adapter that produced this, for provenance in stored output. */
  provider: string;
}

export interface TranscribeOptions {
  /** BCP-47 hint. Providers that auto-detect may ignore it. */
  language?: string;
}

export interface Transcriber {
  readonly name: string;
  /** Transcribes a local audio file — ingest has already written one. */
  transcribe(audioPath: string, options?: TranscribeOptions): Promise<Transcript>;
}

export class TranscriptionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TranscriptionError";
  }
}

/** Concatenates segment text the way most providers present a full transcript. */
export function joinSegments(segments: TranscriptSegment[]): string {
  return segments
    .map((segment) => segment.text.trim())
    .filter((text) => text.length > 0)
    .join(" ");
}
