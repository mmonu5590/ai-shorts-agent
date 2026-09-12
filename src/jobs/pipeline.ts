/**
 * The pipeline runner: ingest, transcribe, select, render.
 *
 * Each stage writes its output to storage before the next begins, so a job's
 * prefix is a complete record of what happened and a failed job can be
 * inspected at the stage it reached.
 */

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { ingestVideo } from "../ingest/index.ts";
import { MotionFrameAnalyzer, renderPlan } from "../render/index.ts";
import { type StorageAdapter, jobKeys } from "../storage/index.ts";
import type { ClipSelector } from "../select/index.ts";
import type { Transcriber } from "../transcribe/index.ts";
import type { Job, JobStore } from "./types.ts";

/**
 * Whether to burn captions into the rendered Shorts.
 *
 * `auto` means yes, unless the transcript came from the stub transcriber —
 * burning "[untranscribed audio 0.0s-15.0s]" across every Short looks like a
 * bug to a viewer and would be worse than no captions at all.
 */
export type CaptionMode = "auto" | "on" | "off";

export function captionsEnabled(mode: CaptionMode, provider: string): boolean {
  if (mode === "off") return false;
  if (mode === "on") return true;
  return provider !== "stub";
}

export interface RunJobOptions {
  jobId: string;
  filename: string;
  source: Readable;
  storage: StorageAdapter;
  store: JobStore;
  transcriber: Transcriber;
  selector: ClipSelector;
  targetClipCount?: number;
  maxDurationSeconds?: number;
  /** Defaults to `auto`. */
  captionMode?: CaptionMode;
  /**
   * Choose the crop window from the picture rather than the plan.
   *
   * Off by default. Motion is good evidence of where the subject is, but not
   * proof: a still speaker in front of a busy background loses to the
   * background. Worth enabling when the footage is mostly static shots.
   */
  autoFrame?: boolean;
}

/** Serialises a value into storage as pretty-printed JSON. */
async function putJson(storage: StorageAdapter, key: string, value: unknown): Promise<void> {
  await storage.put(key, Readable.from([Buffer.from(JSON.stringify(value, null, 2))]), {
    contentType: "application/json",
  });
}

/**
 * Runs a job to completion, recording each stage in the store.
 *
 * Never throws: a failure is recorded on the job as `status: "failed"` with a
 * message, because the caller is usually a fire-and-forget background task and
 * an unhandled rejection there would take the process down.
 */
export async function runJob(options: RunJobOptions): Promise<Job> {
  const { jobId, storage, store, transcriber, selector } = options;

  try {
    await store.update(jobId, { status: "ingesting" });
    const ingested = await ingestVideo({
      jobId,
      filename: options.filename,
      source: options.source,
      storage,
      ...(options.maxDurationSeconds === undefined
        ? {}
        : { maxDurationSeconds: options.maxDurationSeconds }),
    });
    await store.update(jobId, { metadata: ingested.metadata });

    await store.update(jobId, { status: "transcribing" });
    // Transcribers take a local file; ingest put the audio in storage, which
    // may be Drive, so it comes back down to disk for this stage.
    const staging = await mkdtemp(path.join(tmpdir(), `transcribe-${jobId}-`));
    let transcript;
    try {
      const localAudio = path.join(staging, "audio.wav");
      await streamPipeline(await storage.get(ingested.keys.audio), createWriteStream(localAudio));
      transcript = await transcriber.transcribe(localAudio);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    await putJson(storage, jobKeys.transcript(jobId), transcript);

    await store.update(jobId, { status: "selecting" });
    const plan = await selector.select({
      jobId,
      transcript,
      sourceDuration: ingested.metadata.duration,
      ...(options.targetClipCount === undefined ? {} : { targetClipCount: options.targetClipCount }),
    });
    await putJson(storage, jobKeys.editPlan(jobId), plan);
    await store.update(jobId, { plan });

    await store.update(jobId, {
      status: "rendering",
      progress: { completed: 0, total: plan.clips.length },
    });
    const rendered = await renderPlan({
      plan,
      storage,
      sourceKey: ingested.keys.source,
      transcript,
      captions: {
        enabled: captionsEnabled(options.captionMode ?? "auto", transcript.provider),
      },
      ...(options.autoFrame ? { autoFrame: new MotionFrameAnalyzer() } : {}),
      onProgress: (completed, total) => {
        // Fire-and-forget: progress is advisory and must not stall rendering.
        void store.update(jobId, { progress: { completed, total } });
      },
    });

    return await store.update(jobId, {
      status: "complete",
      shorts: rendered.shorts,
      progress: { completed: rendered.shorts.length, total: rendered.shorts.length },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return await store.update(jobId, { status: "failed", error: message });
  }
}
