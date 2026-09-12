/**
 * HTTP API.
 *
 * Deliberately built on `node:http` with no framework: the surface is four
 * routes, and the interesting parts — streaming an upload straight into the
 * pipeline, and serving rendered Shorts with range requests — are the same
 * either way.
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { newJobId, runJob, type CaptionMode, type JobStore } from "../jobs/index.ts";
import { resolveExtension } from "../ingest/index.ts";
import type { ClipSelector } from "../select/index.ts";
import type { StorageAdapter } from "../storage/index.ts";
import { jobKeys } from "../storage/index.ts";
import type { Transcriber } from "../transcribe/index.ts";

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export interface ApiDependencies {
  storage: StorageAdapter;
  store: JobStore;
  transcriber: Transcriber;
  selector: ClipSelector;
  targetClipCount?: number;
  maxDurationSeconds?: number;
  captionMode?: CaptionMode;
  autoFrame?: boolean;
}

function sendJson(response: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** Parses an HTTP Range header. Returns null for absent or unsupported forms. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return null;

  // A suffix range ("bytes=-500") asks for the last N bytes.
  if (rawStart === "") {
    const length = Number(rawEnd);
    if (!Number.isFinite(length) || length <= 0) return null;
    return { start: Math.max(0, size - length), end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd === "" ? size - 1 : Number(rawEnd);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

async function handleCreateJob(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  url: URL,
  deps: ApiDependencies,
): Promise<void> {
  const filename = url.searchParams.get("filename");
  if (!filename) {
    sendJson(response, 400, { error: "Missing ?filename= on the upload" });
    return;
  }

  try {
    resolveExtension(filename);
  } catch (error) {
    sendJson(response, 415, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  // The upload must be fully received before the response is sent. Ending the
  // response first lets Node drain and discard the unread request body to free
  // the socket for keep-alive, and the pipeline then sees an empty upload.
  // Staging here also means a 202 honestly says the bytes were accepted.
  const staging = await mkdtemp(path.join(tmpdir(), "upload-"));
  const uploadPath = path.join(staging, `upload${path.extname(filename)}`);
  try {
    await pipeline(request, createWriteStream(uploadPath));
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    sendJson(response, 400, {
      error: `Upload did not complete: ${error instanceof Error ? error.message : String(error)}`,
    });
    return;
  }

  const jobId = newJobId();
  const job = await deps.store.create({ id: jobId, filename });

  // The pipeline is not awaited: the client gets a job ID immediately and polls
  // for status. runJob records its own failures, so nothing can reject here.
  void runJob({
    jobId,
    filename,
    source: createReadStream(uploadPath),
    storage: deps.storage,
    store: deps.store,
    transcriber: deps.transcriber,
    selector: deps.selector,
    ...(deps.targetClipCount === undefined ? {} : { targetClipCount: deps.targetClipCount }),
    ...(deps.maxDurationSeconds === undefined ? {} : { maxDurationSeconds: deps.maxDurationSeconds }),
    ...(deps.captionMode === undefined ? {} : { captionMode: deps.captionMode }),
    ...(deps.autoFrame === undefined ? {} : { autoFrame: deps.autoFrame }),
  }).finally(() => rm(staging, { recursive: true, force: true }));

  sendJson(response, 202, job);
}

async function handleShort(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  jobId: string,
  index: number,
  deps: ApiDependencies,
): Promise<void> {
  const key = jobKeys.short(jobId, index);
  const stored = await deps.storage.stat(key);
  if (!stored) {
    sendJson(response, 404, { error: `No rendered Short ${index} for job ${jobId}` });
    return;
  }

  const size = stored.size ?? 0;
  const range = size > 0 ? parseRange(request.headers.range, size) : null;

  if (range) {
    response.writeHead(206, {
      "content-type": "video/mp4",
      "content-length": range.end - range.start + 1,
      "content-range": `bytes ${range.start}-${range.end}/${size}`,
      "accept-ranges": "bytes",
    });
    const stream = await deps.storage.get(key, { range: { start: range.start, end: range.end } });
    stream.pipe(response);
    return;
  }

  response.writeHead(200, {
    "content-type": "video/mp4",
    ...(size > 0 ? { "content-length": size } : {}),
    "accept-ranges": "bytes",
  });
  (await deps.storage.get(key)).pipe(response);
}

function serveIndex(response: http.ServerResponse): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  createReadStream(path.join(PUBLIC_DIR, "index.html")).pipe(response);
}

export function createApiServer(deps: ApiDependencies): http.Server {
  return http.createServer((request, response) => {
    void (async () => {
      try {
        // Parsed inside the boundary: a Host header the URL parser rejects
        // would otherwise reject outside any catch, and an unhandled rejection
        // in this fire-and-forget handler takes the process down.
        const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
        const segments = url.pathname.split("/").filter(Boolean);

        if (request.method === "GET" && segments.length === 0) {
          serveIndex(response);
          return;
        }

        if (segments[0] === "api" && segments[1] === "jobs") {
          if (request.method === "POST" && segments.length === 2) {
            await handleCreateJob(request, response, url, deps);
            return;
          }
          if (request.method === "GET" && segments.length === 2) {
            sendJson(response, 200, { jobs: await deps.store.list() });
            return;
          }

          const jobId = segments[2];
          if (jobId !== undefined && !JOB_ID_PATTERN.test(jobId)) {
            sendJson(response, 400, { error: "Malformed job id" });
            return;
          }

          if (request.method === "GET" && segments.length === 3 && jobId) {
            const job = await deps.store.get(jobId);
            if (!job) {
              sendJson(response, 404, { error: `No job with id "${jobId}"` });
              return;
            }
            sendJson(response, 200, job);
            return;
          }

          if (request.method === "GET" && segments.length === 5 && jobId && segments[3] === "shorts") {
            const index = Number(segments[4]);
            if (!Number.isInteger(index) || index < 1) {
              sendJson(response, 400, { error: "Short index must be a positive integer" });
              return;
            }
            await handleShort(request, response, jobId, index, deps);
            return;
          }
        }

        sendJson(response, 404, { error: "Not found" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!response.headersSent) {
          sendJson(response, 500, { error: message });
        } else {
          response.end();
        }
      }
    })();
  });
}
