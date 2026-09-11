/**
 * Job state.
 *
 * A job is the unit the API and the web client talk about: one uploaded video
 * moving through the pipeline. The status values are the pipeline stages, so a
 * client can show where a job is without knowing anything else about it.
 */

import type { VideoMetadata } from "../media/types.ts";
import type { EditPlan } from "../plan/types.ts";
import type { RenderedShort } from "../render/index.ts";

export const JOB_STATUSES = [
  "queued",
  "ingesting",
  "transcribing",
  "selecting",
  "rendering",
  "complete",
  "failed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/** Statuses from which a job will not move again. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ["complete", "failed"];

export interface JobProgress {
  completed: number;
  total: number;
}

export interface Job {
  id: string;
  status: JobStatus;
  filename: string;
  createdAt: string;
  updatedAt: string;
  metadata?: VideoMetadata;
  plan?: EditPlan;
  shorts?: RenderedShort[];
  progress?: JobProgress;
  /** Message shown to the user when `status` is `failed`. */
  error?: string;
}

export interface JobStore {
  create(job: Pick<Job, "id" | "filename">): Promise<Job>;
  get(id: string): Promise<Job | null>;
  update(id: string, patch: Partial<Omit<Job, "id" | "createdAt">>): Promise<Job>;
  list(): Promise<Job[]>;
}

export class JobNotFoundError extends Error {
  constructor(id: string) {
    super(`No job with id "${id}"`);
    this.name = "JobNotFoundError";
  }
}

/**
 * Jobs held in process memory.
 *
 * Adequate for a single-process prototype and nothing more: restarting the
 * server loses every job. Swapping in Redis or Postgres means implementing
 * {@link JobStore}; nothing else changes.
 */
export class InMemoryJobStore implements JobStore {
  readonly #jobs = new Map<string, Job>();

  async create(job: Pick<Job, "id" | "filename">): Promise<Job> {
    const now = new Date().toISOString();
    const created: Job = { ...job, status: "queued", createdAt: now, updatedAt: now };
    this.#jobs.set(created.id, created);
    return created;
  }

  async get(id: string): Promise<Job | null> {
    return this.#jobs.get(id) ?? null;
  }

  async update(id: string, patch: Partial<Omit<Job, "id" | "createdAt">>): Promise<Job> {
    const existing = this.#jobs.get(id);
    if (!existing) {
      throw new JobNotFoundError(id);
    }
    const updated: Job = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    this.#jobs.set(id, updated);
    return updated;
  }

  async list(): Promise<Job[]> {
    return [...this.#jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
