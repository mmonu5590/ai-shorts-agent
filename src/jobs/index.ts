export * from "./types.ts";
export { runJob, captionsEnabled, type CaptionMode, type RunJobOptions } from "./pipeline.ts";
export * from "./queue.ts";

import { randomUUID } from "node:crypto";

/**
 * Job IDs are URL path segments and storage prefixes, so they stay simple.
 *
 * They are also the only thing standing between a caller and someone else's
 * rendered video until real authorization exists, so they come from a CSPRNG
 * rather than a timestamp plus `Math.random` — the latter is both predictable
 * from its prefix and recoverable from a couple of observed values.
 */
export function newJobId(): string {
  return `job-${randomUUID()}`;
}
