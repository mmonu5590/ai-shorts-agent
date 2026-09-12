import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createTestVideo } from "../../media/__tests__/fixtures.ts";
import { ffmpegAvailable } from "../../media/ffmpeg.ts";
import { InMemoryJobStore, InProcessJobQueue } from "../../jobs/index.ts";
import { HeuristicClipSelector } from "../../select/index.ts";
import { LocalStorage } from "../../storage/index.ts";
import { StubTranscriber } from "../../transcribe/index.ts";
import { createApiServer, parseRange } from "../server.ts";

const hasFfmpeg = await ffmpegAvailable();

describe("parseRange", () => {
  it("parses a closed range", () => {
    assert.deepEqual(parseRange("bytes=0-499", 1000), { start: 0, end: 499 });
  });

  it("parses an open-ended range", () => {
    assert.deepEqual(parseRange("bytes=500-", 1000), { start: 500, end: 999 });
  });

  it("parses a suffix range as the last N bytes", () => {
    assert.deepEqual(parseRange("bytes=-200", 1000), { start: 800, end: 999 });
  });

  it("clamps an end past the file size", () => {
    assert.deepEqual(parseRange("bytes=900-5000", 1000), { start: 900, end: 999 });
  });

  it("returns null for absent, malformed, or unsatisfiable ranges", () => {
    for (const header of [undefined, "", "items=0-10", "bytes=abc-def", "bytes=-", "bytes=900-100", "bytes=2000-"]) {
      assert.equal(parseRange(header, 1000), null, `expected null for ${JSON.stringify(header)}`);
    }
  });
});

describe("API", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  let dir: string;
  let server: ReturnType<typeof createApiServer>;
  let base: string;
  let sourceVideo: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "api-test-"));
    sourceVideo = path.join(dir, "source.mp4");
    await createTestVideo(sourceVideo, { durationSeconds: 12, width: 640, height: 360 });

    server = createApiServer({
      storage: new LocalStorage({ rootDir: path.join(dir, "storage") }),
      store: new InMemoryJobStore(),
      queue: new InProcessJobQueue({ concurrency: 2 }),
      transcriber: new StubTranscriber({ segmentSeconds: 3 }),
      selector: new HeuristicClipSelector({ targetDurationSeconds: 5 }),
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(dir, { recursive: true, force: true });
  });

  /** Uploads a file and polls until the job settles. */
  async function upload(filename: string, body: Buffer) {
    const created = await fetch(`${base}/api/jobs?filename=${encodeURIComponent(filename)}`, {
      method: "POST",
      body,
    });
    const job = (await created.json()) as { id: string };
    assert.equal(created.status, 202);

    for (let attempt = 0; attempt < 120; attempt += 1) {
      const response = await fetch(`${base}/api/jobs/${job.id}`);
      const current = (await response.json()) as { status: string; error?: string; shorts?: unknown[] };
      if (current.status === "complete" || current.status === "failed") return { id: job.id, ...current };
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("job did not settle in time");
  }

  it("serves the web client at the root", async () => {
    const response = await fetch(base);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/u);
    assert.match(await response.text(), /AI Shorts Agent/u);
  });

  it("runs an upload through the pipeline and serves the Shorts", async () => {
    const settled = await upload("holiday.mp4", await readFile(sourceVideo));

    assert.equal(settled.status, "complete", settled.error ?? "");
    assert.ok(settled.shorts && settled.shorts.length > 0);

    const video = await fetch(`${base}/api/jobs/${settled.id}/shorts/1`);
    assert.equal(video.status, 200);
    assert.equal(video.headers.get("content-type"), "video/mp4");
    assert.equal(video.headers.get("accept-ranges"), "bytes");

    const bytes = Buffer.from(await video.arrayBuffer());
    assert.ok(bytes.length > 0);
    // An MP4 written with +faststart carries ftyp in the first box.
    assert.equal(bytes.subarray(4, 8).toString(), "ftyp");
  });

  it("serves a byte range so a phone can seek without refetching", async () => {
    const settled = await upload("ranged.mp4", await readFile(sourceVideo));
    assert.equal(settled.status, "complete", settled.error ?? "");

    const response = await fetch(`${base}/api/jobs/${settled.id}/shorts/1`, {
      headers: { Range: "bytes=0-99" },
    });

    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-length"), "100");
    assert.match(response.headers.get("content-range") ?? "", /^bytes 0-99\/\d+$/u);
    assert.equal((await response.arrayBuffer()).byteLength, 100);
  });

  it("rejects an unsupported container before creating a job", async () => {
    const response = await fetch(`${base}/api/jobs?filename=clip.avi`, {
      method: "POST",
      body: Buffer.from("x"),
    });

    assert.equal(response.status, 415);
    assert.match(((await response.json()) as { error: string }).error, /Unsupported file type/u);
  });

  it("requires a filename on the upload", async () => {
    const response = await fetch(`${base}/api/jobs`, { method: "POST", body: Buffer.from("x") });

    assert.equal(response.status, 400);
  });

  it("404s an unknown job and 400s a malformed id", async () => {
    assert.equal((await fetch(`${base}/api/jobs/job-nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/jobs/..%2f..%2fetc`)).status, 400);
  });

  it("404s a Short that was never rendered", async () => {
    const settled = await upload("missing.mp4", await readFile(sourceVideo));

    assert.equal((await fetch(`${base}/api/jobs/${settled.id}/shorts/99`)).status, 404);
  });

  it("lists jobs newest first", async () => {
    const response = await fetch(`${base}/api/jobs`);
    const { jobs } = (await response.json()) as { jobs: { createdAt: string }[] };

    assert.ok(jobs.length > 0);
    for (let index = 1; index < jobs.length; index += 1) {
      assert.ok(
        (jobs[index - 1]?.createdAt ?? "") >= (jobs[index]?.createdAt ?? ""),
        "jobs should be newest first",
      );
    }
  });
});
