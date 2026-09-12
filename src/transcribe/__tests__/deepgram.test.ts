import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { DeepgramTranscriber } from "../deepgram.ts";
import { TranscriptionError } from "../types.ts";

/** A Deepgram response with utterances, as the documented shape. */
const WITH_UTTERANCES = {
  metadata: { duration: 42.5 },
  results: {
    channels: [
      {
        detected_language: "en",
        alternatives: [
          {
            transcript: "Hello there. This is the good part.",
            words: [{ word: "hello", punctuated_word: "Hello", start: 0.1, end: 0.4 }],
          },
        ],
      },
    ],
    utterances: [
      {
        id: "utt-1",
        start: 0.1,
        end: 1.2,
        transcript: "  Hello there.  ",
        words: [
          { word: "hello", punctuated_word: "Hello", start: 0.1, end: 0.4 },
          { word: "there", punctuated_word: "there.", start: 0.5, end: 1.2 },
        ],
      },
      {
        id: "utt-2",
        start: 2.0,
        end: 4.4,
        transcript: "This is the good part.",
        words: [{ word: "this", start: 2.0, end: 2.3 }],
      },
    ],
  },
};

/** Records the request the transcriber issued, for assertions. */
interface Capture {
  url?: string | undefined;
  init?: RequestInit | undefined;
}

/** Builds a transcriber whose transport returns `body` with `status`. */
function transcriberFor(
  body: unknown,
  options: { status?: number; text?: string; capture?: Capture } = {},
) {
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (options.capture) {
      options.capture.url = String(url);
      options.capture.init = init;
    }
    return {
      ok: (options.status ?? 200) < 400,
      status: options.status ?? 200,
      json: async () => {
        if (options.text !== undefined) throw new Error("not json");
        return body;
      },
      text: async () => options.text ?? JSON.stringify(body),
    } as Response;
  }) as unknown as typeof fetch;

  return new DeepgramTranscriber({ apiKey: "test-key", fetchImpl });
}

describe("DeepgramTranscriber", () => {
  let audio: string;
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "deepgram-test-"));
    audio = path.join(dir, "audio.wav");
    await writeFile(audio, Buffer.alloc(2048));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("requires an API key", () => {
    assert.throws(() => new DeepgramTranscriber({ apiKey: "" }), TranscriptionError);
  });

  it("maps utterances into timed segments", async () => {
    const transcript = await transcriberFor(WITH_UTTERANCES).transcribe(audio);

    assert.equal(transcript.provider, "deepgram");
    assert.equal(transcript.duration, 42.5);
    assert.equal(transcript.language, "en");
    assert.equal(transcript.segments.length, 2);

    const [first, second] = transcript.segments;
    assert.equal(first?.id, "utt-1");
    assert.equal(first?.start, 0.1);
    assert.equal(first?.end, 1.2);
    assert.equal(first?.text, "Hello there.", "segment text should be trimmed");
    assert.equal(second?.id, "utt-2");
  });

  it("prefers punctuated_word for word text, falling back to the raw token", async () => {
    const transcript = await transcriberFor(WITH_UTTERANCES).transcribe(audio);

    assert.deepEqual(
      transcript.segments[0]?.words?.map((word) => word.text),
      ["Hello", "there."],
    );
    assert.equal(transcript.segments[1]?.words?.[0]?.text, "this");
  });

  it("drops words with no timings rather than emitting NaN spans", async () => {
    const payload = structuredClone(WITH_UTTERANCES);
    payload.results.utterances[0]!.words.push({ word: "ghost" } as never);

    const transcript = await transcriberFor(payload).transcribe(audio);

    assert.equal(transcript.segments[0]?.words?.length, 2);
  });

  it("falls back to one segment when the response carries no utterances", async () => {
    const payload = {
      metadata: { duration: 10 },
      results: {
        channels: [
          {
            alternatives: [
              {
                transcript: "One long blob.",
                words: [
                  { word: "one", start: 0.5, end: 0.9 },
                  { word: "blob", start: 3.0, end: 3.6 },
                ],
              },
            ],
          },
        ],
      },
    };

    const transcript = await transcriberFor(payload).transcribe(audio);

    assert.equal(transcript.segments.length, 1);
    assert.equal(transcript.segments[0]?.start, 0.5);
    assert.equal(transcript.segments[0]?.end, 3.6, "should span the word timings");
    assert.equal(transcript.language, null, "no detected_language means null, not a guess");
  });

  it("sends the documented request: token auth, audio content type, utterances on", async () => {
    const capture: Capture = {};
    await transcriberFor(WITH_UTTERANCES, { capture }).transcribe(audio);

    const url = new URL(capture.url as string);
    assert.equal(url.origin + url.pathname, "https://api.deepgram.com/v1/listen");
    assert.equal(url.searchParams.get("utterances"), "true");
    assert.equal(url.searchParams.get("model"), "nova-3");
    assert.equal(url.searchParams.get("detect_language"), "true");

    const headers = capture.init?.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Token test-key");
    assert.equal(headers["Content-Type"], "audio/wav");
    assert.equal(headers["Content-Length"], "2048", "length must come from stat, not a buffer");
    assert.equal(capture.init?.method, "POST");
  });

  it("asks for a specific language instead of detection when one is given", async () => {
    const capture: Capture = {};
    await transcriberFor(WITH_UTTERANCES, { capture }).transcribe(audio, { language: "es" });

    const url = new URL(capture.url as string);
    assert.equal(url.searchParams.get("language"), "es");
    assert.equal(url.searchParams.get("detect_language"), null);
  });

  it("surfaces the status and body when Deepgram rejects the request", async () => {
    await assert.rejects(
      () => transcriberFor({}, { status: 401, text: "invalid credentials" }).transcribe(audio),
      (error: unknown) =>
        error instanceof TranscriptionError && /401.*invalid credentials/su.test(error.message),
    );
  });

  it("raises when the body is not JSON", async () => {
    await assert.rejects(
      () => transcriberFor(null, { text: "<html>gateway</html>" }).transcribe(audio),
      (error: unknown) => error instanceof TranscriptionError && /not JSON/u.test(error.message),
    );
  });

  it("raises when the response carries no alternatives", async () => {
    await assert.rejects(
      () => transcriberFor({ metadata: { duration: 5 }, results: { channels: [] } }).transcribe(audio),
      (error: unknown) => error instanceof TranscriptionError && /no transcription/u.test(error.message),
    );
  });

  it("raises when the response carries no usable duration", async () => {
    const payload = structuredClone(WITH_UTTERANCES) as Record<string, unknown>;
    payload["metadata"] = { duration: 0 };

    await assert.rejects(
      () => transcriberFor(payload).transcribe(audio),
      (error: unknown) => error instanceof TranscriptionError && /duration/u.test(error.message),
    );
  });

  it("wraps a transport failure rather than leaking it", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await assert.rejects(
      () => new DeepgramTranscriber({ apiKey: "k", fetchImpl }).transcribe(audio),
      (error: unknown) =>
        error instanceof TranscriptionError && /Could not reach Deepgram/u.test(error.message),
    );
  });
});
