import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InProcessJobQueue } from "../queue.ts";

/** A task that resolves only when told to, so overlap is observable. */
function controllable() {
  let release!: () => void;
  const started = { value: false };
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const task = async () => {
    started.value = true;
    await gate;
  };
  return { task, release, started };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("InProcessJobQueue", () => {
  it("rejects a nonsensical concurrency rather than silently coercing it", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      assert.throws(() => new InProcessJobQueue({ concurrency: bad }), RangeError);
    }
  });

  it("runs at most `concurrency` tasks at once", async () => {
    const queue = new InProcessJobQueue({ concurrency: 2 });
    const a = controllable();
    const b = controllable();
    const c = controllable();

    await queue.enqueue(a.task);
    await queue.enqueue(b.task);
    await queue.enqueue(c.task);
    await tick();

    assert.equal(queue.running, 2);
    assert.equal(queue.waiting, 1);
    assert.equal(c.started.value, false, "the third task must wait its turn");

    a.release();
    await tick();
    assert.equal(c.started.value, true, "finishing one task should admit the next");

    b.release();
    c.release();
    await queue.drain();
  });

  it("defaults to one at a time, because rendering saturates a machine", async () => {
    const queue = new InProcessJobQueue();
    const a = controllable();
    const b = controllable();

    await queue.enqueue(a.task);
    await queue.enqueue(b.task);
    await tick();

    assert.equal(queue.running, 1);
    assert.equal(b.started.value, false);

    a.release();
    b.release();
    await queue.drain();
  });

  it("preserves submission order", async () => {
    const queue = new InProcessJobQueue({ concurrency: 1 });
    const order: number[] = [];

    for (const index of [1, 2, 3, 4]) {
      await queue.enqueue(async () => {
        order.push(index);
      });
    }
    await queue.drain();

    assert.deepEqual(order, [1, 2, 3, 4]);
  });

  it("keeps draining after a task rejects, and does not leak the rejection", async () => {
    const errors: unknown[] = [];
    const queue = new InProcessJobQueue({ concurrency: 1, onError: (error) => errors.push(error) });
    const ran: string[] = [];

    await queue.enqueue(async () => {
      throw new Error("boom");
    });
    await queue.enqueue(async () => {
      ran.push("after");
    });
    await queue.drain();

    assert.deepEqual(ran, ["after"], "a failure must not stall the queue");
    assert.equal(errors.length, 1);
    assert.match((errors[0] as Error).message, /boom/u);
  });

  it("reports a synchronous throw through onError rather than to the caller", async () => {
    const errors: unknown[] = [];
    const queue = new InProcessJobQueue({ onError: (error) => errors.push(error) });

    await assert.doesNotReject(() =>
      queue.enqueue((() => {
        throw new Error("sync");
      }) as () => Promise<unknown>),
    );
    await queue.drain();

    assert.equal(errors.length, 1);
  });

  it("drain resolves immediately when there is nothing to wait for", async () => {
    await assert.doesNotReject(() => new InProcessJobQueue().drain());
  });

  it("drain waits for work queued behind the limit, not just what is running", async () => {
    const queue = new InProcessJobQueue({ concurrency: 1 });
    const finished: number[] = [];

    for (const index of [1, 2, 3]) {
      await queue.enqueue(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        finished.push(index);
      });
    }
    await queue.drain();

    assert.deepEqual(finished, [1, 2, 3]);
    assert.equal(queue.running, 0);
    assert.equal(queue.waiting, 0);
  });
});
