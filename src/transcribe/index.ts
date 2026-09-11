/**
 * Transcriber wiring.
 */

import { StubTranscriber } from "./stub.ts";
import type { Transcriber } from "./types.ts";

export * from "./types.ts";
export { StubTranscriber } from "./stub.ts";

/**
 * Selects a transcriber from `TRANSCRIBER`.
 *
 * Only the stub ships today. Adding a real provider means implementing
 * {@link Transcriber} against its API and adding a case here — nothing
 * downstream changes, because the rest of the pipeline only knows
 * {@link Transcript}.
 */
export function createTranscriber(): Transcriber {
  const driver = process.env["TRANSCRIBER"] ?? "stub";
  switch (driver) {
    case "stub":
      return new StubTranscriber();
    default:
      throw new Error(`Unknown TRANSCRIBER "${driver}" (expected "stub")`);
  }
}
