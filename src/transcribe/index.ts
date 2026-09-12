/**
 * Transcriber wiring.
 */

import { DeepgramTranscriber } from "./deepgram.ts";
import { StubTranscriber } from "./stub.ts";
import type { Transcriber } from "./types.ts";

export * from "./types.ts";
export { DeepgramTranscriber } from "./deepgram.ts";
export { StubTranscriber } from "./stub.ts";

/**
 * Selects a transcriber from `TRANSCRIBER`.
 *
 * `stub` needs nothing and transcribes nothing — it exists so the pipeline
 * runs end to end without a provider. `deepgram` is the real one.
 *
 * Adding another provider means implementing {@link Transcriber} against its
 * API and adding a case here; nothing downstream changes, because the rest of
 * the pipeline only knows {@link Transcript}.
 */
export function createTranscriber(): Transcriber {
  const driver = process.env["TRANSCRIBER"] ?? "stub";
  switch (driver) {
    case "stub":
      return new StubTranscriber();
    case "deepgram":
      return new DeepgramTranscriber();
    default:
      throw new Error(`Unknown TRANSCRIBER "${driver}" (expected "stub" or "deepgram")`);
  }
}
