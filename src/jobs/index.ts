export * from "./types.ts";
export { runJob, captionsEnabled, type CaptionMode, type RunJobOptions } from "./pipeline.ts";

/** Job IDs are URL path segments and storage prefixes, so keep them simple. */
export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
