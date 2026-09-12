/**
 * Server entry point.
 */

import { InMemoryJobStore, type CaptionMode } from "../jobs/index.ts";
import { createClipSelector } from "../select/index.ts";
import { createStorage } from "../storage/index.ts";
import { createTranscriber } from "../transcribe/index.ts";
import { createApiServer } from "./server.ts";

export { createApiServer, type ApiDependencies } from "./server.ts";

export function startServer(port = Number(process.env["PORT"] ?? 3000)) {
  const server = createApiServer({
    storage: createStorage(),
    store: new InMemoryJobStore(),
    transcriber: createTranscriber(),
    selector: createClipSelector(),
    ...(process.env["MAX_VIDEO_SECONDS"]
      ? { maxDurationSeconds: Number(process.env["MAX_VIDEO_SECONDS"]) }
      : {}),
    ...(process.env["CAPTIONS"]
      ? { captionMode: process.env["CAPTIONS"] as CaptionMode }
      : {}),
    ...(process.env["AUTO_FRAME"] === "true" ? { autoFrame: true } : {}),
  });

  server.listen(port, () => {
    console.log(`ai-shorts-agent listening on http://localhost:${port}`);
  });
  return server;
}

// Start only when run directly, so importing this module in tests is harmless.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
