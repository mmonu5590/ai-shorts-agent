/**
 * Clip-selector wiring.
 */

import { ClaudeClipSelector } from "./claude.ts";
import { HeuristicClipSelector } from "./heuristic.ts";
import type { ClipSelector } from "./types.ts";

export * from "./types.ts";
export { ClaudeClipSelector } from "./claude.ts";
export { HeuristicClipSelector } from "./heuristic.ts";

/**
 * Selects a clip selector from `CLIP_SELECTOR`.
 *
 * Defaults to `heuristic`, which needs no credentials — the pipeline runs out
 * of the box and you opt in to a model.
 */
export function createClipSelector(): ClipSelector {
  const driver = process.env["CLIP_SELECTOR"] ?? "heuristic";
  switch (driver) {
    case "claude":
      return new ClaudeClipSelector();
    case "heuristic":
      return new HeuristicClipSelector();
    default:
      throw new Error(`Unknown CLIP_SELECTOR "${driver}" (expected "heuristic" or "claude")`);
  }
}
