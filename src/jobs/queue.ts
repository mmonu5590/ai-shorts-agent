/**
 * A bound on how much work runs at once.
 *
 * Rendering is CPU-bound: each clip is an ffmpeg encode, and ffmpeg will
 * happily use every core it is given. Starting a pipeline run per upload the
 * moment it arrives means ten uploads become ten concurrent encodes competing
 * for the same cores, and every one of them finishes later than if they had
 * been run in sequence.
 *
 * {@link InProcessJobQueue} is the single-process implementation. A Redis-backed
 * one — which is what survives a restart and spans workers — implements the
 * same interface.
 */

export type QueuedTask = () => Promise<unknown>;

export interface JobQueue {
  readonly name: string;
  /** Accepts work and returns once it has been recorded, not once it has run. */
  enqueue(task: QueuedTask): Promise<void>;
  /** Tasks started but not yet finished. */
  readonly running: number;
  /** Tasks accepted but not yet started. */
  readonly waiting: number;
  /** Resolves when everything accepted so far has finished. */
  drain(): Promise<void>;
}

export interface InProcessJobQueueOptions {
  /** Tasks allowed to run at once. Defaults to 1 — rendering saturates a box. */
  concurrency?: number;
  /** Called when a task rejects. Defaults to reporting on stderr. */
  onError?: (error: unknown) => void;
}

export class InProcessJobQueue implements JobQueue {
  readonly name = "in-process";

  readonly #concurrency: number;
  readonly #onError: (error: unknown) => void;
  readonly #pending: QueuedTask[] = [];
  readonly #idleWaiters: (() => void)[] = [];
  #running = 0;

  constructor(options: InProcessJobQueueOptions = {}) {
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new RangeError(`Queue concurrency must be a positive integer, got ${concurrency}`);
    }
    this.#concurrency = concurrency;
    this.#onError =
      options.onError ??
      ((error) => {
        console.error("Queued job failed:", error);
      });
  }

  get running(): number {
    return this.#running;
  }

  get waiting(): number {
    return this.#pending.length;
  }

  async enqueue(task: QueuedTask): Promise<void> {
    this.#pending.push(task);
    this.#pump();
  }

  drain(): Promise<void> {
    if (this.#running === 0 && this.#pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  /** Starts as much pending work as the concurrency limit allows. */
  #pump(): void {
    while (this.#running < this.#concurrency && this.#pending.length > 0) {
      const task = this.#pending.shift() as QueuedTask;
      this.#running += 1;

      // A rejecting task must not stall the queue or reach the event loop as an
      // unhandled rejection, so it is caught here and reported.
      void Promise.resolve()
        .then(task)
        .catch(this.#onError)
        .finally(() => {
          this.#running -= 1;
          this.#pump();
          if (this.#running === 0 && this.#pending.length === 0) {
            for (const resolve of this.#idleWaiters.splice(0)) resolve();
          }
        });
    }
  }
}
