/**
 * Transcription backed by Deepgram's pre-recorded API.
 *
 * Request and response shapes follow Deepgram's documented contract:
 * `POST https://api.deepgram.com/v1/listen` with `Authorization: Token <key>`,
 * the audio Content-Type, and the raw file as the body. Responses carry
 * `metadata.duration` and `results.channels[].alternatives[]`, plus
 * `results.utterances[]` when `utterances=true`.
 *
 * The transport is injectable so the response mapping — the part that actually
 * breaks — is unit-tested without a key or a network.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import {
  type Transcriber,
  type Transcript,
  type TranscriptSegment,
  type TranscriptWord,
  type TranscribeOptions,
  TranscriptionError,
  joinSegments,
} from "./types.ts";

const DEFAULT_BASE_URL = "https://api.deepgram.com/v1/listen";
const DEFAULT_MODEL = "nova-3";

/** Content types for the containers ingest can hand us. */
const AUDIO_CONTENT_TYPES: Record<string, string> = {
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
};

interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;
  end?: number;
}

interface DeepgramAlternative {
  transcript?: string;
  words?: DeepgramWord[];
}

interface DeepgramUtterance {
  id?: string;
  start?: number;
  end?: number;
  transcript?: string;
  words?: DeepgramWord[];
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: { alternatives?: DeepgramAlternative[]; detected_language?: string }[];
    utterances?: DeepgramUtterance[];
  };
}

export interface DeepgramTranscriberOptions {
  /** Defaults to `DEEPGRAM_API_KEY`. */
  apiKey?: string;
  model?: string;
  baseUrl?: string;
  /** Injectable for tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

function mapWords(words: DeepgramWord[] | undefined): TranscriptWord[] {
  return (words ?? [])
    .filter((word) => typeof word.start === "number" && typeof word.end === "number")
    .map((word) => ({
      // `punctuated_word` is the display form; `word` is the raw token.
      text: word.punctuated_word ?? word.word ?? "",
      start: word.start as number,
      end: word.end as number,
    }));
}

export class DeepgramTranscriber implements Transcriber {
  readonly name = "deepgram";

  readonly #apiKey: string;
  readonly #model: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: DeepgramTranscriberOptions = {}) {
    const apiKey = options.apiKey ?? process.env["DEEPGRAM_API_KEY"];
    if (!apiKey) {
      throw new TranscriptionError(
        "DeepgramTranscriber needs an API key. Set DEEPGRAM_API_KEY or pass apiKey.",
      );
    }
    this.#apiKey = apiKey;
    this.#model = options.model ?? process.env["DEEPGRAM_MODEL"] ?? DEFAULT_MODEL;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
  }

  #url(options: TranscribeOptions): string {
    const url = new URL(this.#baseUrl);
    url.searchParams.set("model", this.#model);
    url.searchParams.set("smart_format", "true");
    url.searchParams.set("punctuate", "true");
    // Utterances give sentence-level spans with timings, which is what clip
    // selection needs — a single blob of text has no cut points.
    url.searchParams.set("utterances", "true");
    if (options.language) {
      url.searchParams.set("language", options.language);
    } else {
      url.searchParams.set("detect_language", "true");
    }
    return url.toString();
  }

  async transcribe(audioPath: string, options: TranscribeOptions = {}): Promise<Transcript> {
    const { size } = await stat(audioPath);
    const contentType = AUDIO_CONTENT_TYPES[path.extname(audioPath).toLowerCase()] ?? "audio/wav";

    let response: Response;
    try {
      response = await this.#fetch(this.#url(options), {
        method: "POST",
        headers: {
          Authorization: `Token ${this.#apiKey}`,
          "Content-Type": contentType,
          // Set explicitly because the body is a stream: an hour of 16 kHz mono
          // PCM is ~115 MB, which should not be buffered just to be counted.
          "Content-Length": String(size),
        },
        body: Readable.toWeb(createReadStream(audioPath)) as ReadableStream,
        // Required by fetch when the body is a stream rather than a buffer.
        duplex: "half",
      } as RequestInit);
    } catch (error) {
      throw new TranscriptionError(`Could not reach Deepgram: ${(error as Error).message}`, {
        cause: error,
      });
    }

    if (!response.ok) {
      const detail = (await response.text().catch(() => "")).slice(0, 500);
      throw new TranscriptionError(`Deepgram returned ${response.status}: ${detail}`);
    }

    let payload: DeepgramResponse;
    try {
      payload = (await response.json()) as DeepgramResponse;
    } catch (error) {
      throw new TranscriptionError("Deepgram returned a body that is not JSON", { cause: error });
    }

    return this.#toTranscript(payload, audioPath);
  }

  #toTranscript(payload: DeepgramResponse, audioPath: string): Transcript {
    const channel = payload.results?.channels?.[0];
    const alternative = channel?.alternatives?.[0];
    if (!alternative) {
      throw new TranscriptionError(`Deepgram returned no transcription for "${audioPath}"`);
    }

    const utterances = payload.results?.utterances ?? [];
    const segments: TranscriptSegment[] =
      utterances.length > 0
        ? utterances.map((utterance, index) => {
            const words = mapWords(utterance.words);
            return {
              id: utterance.id ?? `seg-${String(index + 1).padStart(3, "0")}`,
              // Utterance timings are authoritative; fall back to the word span
              // only when a boundary is missing.
              start: utterance.start ?? words[0]?.start ?? 0,
              end: utterance.end ?? words.at(-1)?.end ?? 0,
              text: (utterance.transcript ?? "").trim(),
              ...(words.length > 0 ? { words } : {}),
            };
          })
        : (() => {
            // Without utterances there are no sentence boundaries, so the whole
            // transcript becomes one segment spanning the word timings.
            const words = mapWords(alternative.words);
            if (words.length === 0 && !alternative.transcript) return [];
            return [
              {
                id: "seg-001",
                start: words[0]?.start ?? 0,
                end: words.at(-1)?.end ?? payload.metadata?.duration ?? 0,
                text: (alternative.transcript ?? "").trim(),
                ...(words.length > 0 ? { words } : {}),
              },
            ];
          })();

    const duration = payload.metadata?.duration;
    if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
      throw new TranscriptionError("Deepgram response carried no usable audio duration");
    }

    return {
      language: channel?.detected_language ?? null,
      duration,
      segments,
      text: alternative.transcript?.trim() || joinSegments(segments),
      provider: this.name,
    };
  }
}
