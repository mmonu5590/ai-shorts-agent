import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { createTestVideo } from "../../media/__tests__/fixtures.ts";
import { ffmpegAvailable, ffmpegBinary, run } from "../../media/ffmpeg.ts";
import { type OutputSpec, DEFAULT_OUTPUT } from "../../plan/types.ts";
import type { Transcript } from "../../transcribe/types.ts";
import {
  DEFAULT_CAPTION_STYLE,
  buildSubtitlesFilter,
  clipCues,
  escapeFilterPath,
  toSrt,
} from "../captions.ts";
import { renderClip } from "../index.ts";

const hasFfmpeg = await ffmpegAvailable();
const SPEC: OutputSpec = { ...DEFAULT_OUTPUT, width: 270, height: 480, preset: "ultrafast" };

function transcriptWithWords(): Transcript {
  return {
    language: "en",
    duration: 20,
    provider: "test",
    text: "",
    segments: [
      {
        id: "s1",
        start: 0,
        end: 10,
        text: "one two three four five six seven eight",
        words: Array.from({ length: 8 }, (_, index) => ({
          text: ["one", "two", "three", "four", "five", "six", "seven", "eight"][index] as string,
          start: index,
          end: index + 0.9,
        })),
      },
    ],
  };
}

describe("clipCues", () => {
  it("groups words into short cues and rebases them to clip time", () => {
    const cues = clipCues(transcriptWithWords(), { id: "c", start: 2, end: 8 }, { maxWordsPerCue: 2 });

    assert.ok(cues.length >= 2);
    assert.equal(cues[0]?.start, 0, "the first cue starts at clip-relative zero");
    assert.ok(cues.every((cue) => cue.start >= 0 && cue.end <= 6), "cues stay inside the clip");
    assert.equal(cues[0]?.text, "three four");
  });

  it("breaks a cue on duration even when the word count is under the limit", () => {
    const transcript: Transcript = {
      ...transcriptWithWords(),
      segments: [
        {
          id: "s1",
          start: 0,
          end: 10,
          text: "slow words",
          words: [
            { text: "slow", start: 0, end: 3.5 },
            { text: "words", start: 3.6, end: 7 },
          ],
        },
      ],
    };

    const cues = clipCues(transcript, { id: "c", start: 0, end: 10 }, { maxWordsPerCue: 10, maxCueSeconds: 3 });

    assert.equal(cues.length, 2, "a long word span should not share a cue");
  });

  it("trims a cue that straddles the clip boundary instead of dropping it", () => {
    const transcript: Transcript = {
      ...transcriptWithWords(),
      segments: [{ id: "s1", start: 0, end: 10, text: "spanning", words: [{ text: "spanning", start: 4, end: 9 }] }],
    };

    const cues = clipCues(transcript, { id: "c", start: 5, end: 7 });

    assert.equal(cues.length, 1);
    assert.equal(cues[0]?.start, 0);
    assert.equal(cues[0]?.end, 2, "the tail past the clip end is trimmed");
  });

  it("excludes cues entirely outside the clip", () => {
    const cues = clipCues(transcriptWithWords(), { id: "c", start: 15, end: 19 });
    assert.deepEqual(cues, []);
  });

  it("falls back to whole segments when the transcript has no word timings", () => {
    const transcript: Transcript = {
      language: null,
      duration: 20,
      provider: "test",
      text: "",
      segments: [
        { id: "s1", start: 0, end: 5, text: "first thing" },
        { id: "s2", start: 5, end: 10, text: "second thing" },
      ],
    };

    const cues = clipCues(transcript, { id: "c", start: 0, end: 10 });

    assert.deepEqual(cues.map((cue) => cue.text), ["first thing", "second thing"]);
  });
});

describe("toSrt", () => {
  it("writes SRT timecodes with comma milliseconds", () => {
    const srt = toSrt([{ start: 0, end: 1.5, text: "hello" }, { start: 61.25, end: 3723.004, text: "later" }]);

    assert.match(srt, /^1\n00:00:00,000 --> 00:00:01,500\nhello\n\n/u);
    assert.match(srt, /2\n00:01:01,250 --> 01:02:03,004\nlater\n$/u);
  });

  it("returns an empty string for no cues, so the filter can be skipped", () => {
    assert.equal(toSrt([]), "");
  });
});

describe("escapeFilterPath", () => {
  it("escapes the characters that would break a filter graph", () => {
    assert.equal(escapeFilterPath("/tmp/a:b/c'd\\e.srt"), "/tmp/a\\:b/c\\'d\\\\e.srt");
  });

  it("leaves an ordinary path untouched", () => {
    assert.equal(escapeFilterPath("/tmp/clip-1.srt"), "/tmp/clip-1.srt");
  });
});

describe("buildSubtitlesFilter", () => {
  const filter = buildSubtitlesFilter("/tmp/c.srt", DEFAULT_CAPTION_STYLE, 1920);

  it("points libass at the file and the real frame size", () => {
    assert.ok(filter.startsWith("subtitles=filename='/tmp/c.srt'"));
    assert.ok(filter.includes("original_size=1080x1920"));
  });

  it("scales the font against the ASS canvas, not the pixel height", () => {
    // 0.055 * 288 ≈ 16 — a pixel value here would render microscopically.
    assert.ok(filter.includes("FontSize=16"), filter);
  });

  it("bottom-centres the captions", () => {
    assert.ok(filter.includes("Alignment=2"));
    assert.ok(filter.includes("MarginV=35"));
  });

  it("omits FontName by default so libass uses an installed font", () => {
    assert.ok(!filter.includes("FontName="));
    assert.ok(buildSubtitlesFilter("/t.srt", { ...DEFAULT_CAPTION_STYLE, fontName: "X" }, 1920).includes("FontName=X"));
  });
});

/** Decodes one frame at `atSeconds` as 8-bit grayscale pixels. */
async function grayFrame(videoPath: string, atSeconds: number, outPath: string): Promise<Buffer> {
  await run(ffmpegBinary(), [
    "-nostdin", "-y", "-ss", String(atSeconds), "-i", videoPath,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", outPath,
  ]);
  return readFile(outPath);
}

describe("burned-in captions", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  let dir: string;
  let source: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "captions-render-"));
    source = path.join(dir, "source.mp4");
    await createTestVideo(source, { durationSeconds: 6, width: 640, height: 360 });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("changes pixels in the caption band and nowhere above it", async () => {
    const clip = { id: "c1", start: 0, end: 4 };
    const srtPath = path.join(dir, "c1.srt");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(srtPath, toSrt([{ start: 0, end: 4, text: "BURNED IN CAPTION" }]), "utf8");

    const plain = path.join(dir, "plain.mp4");
    const captioned = path.join(dir, "captioned.mp4");
    await renderClip({ inputPath: source, outputPath: plain, clip, spec: SPEC });
    await renderClip({ inputPath: source, outputPath: captioned, clip, spec: SPEC, subtitlesPath: srtPath });

    const plainFrame = await grayFrame(plain, 1, path.join(dir, "plain.raw"));
    const captionedFrame = await grayFrame(captioned, 1, path.join(dir, "captioned.raw"));

    const { width, height } = SPEC;
    assert.equal(plainFrame.length, width * height, "expected a full grayscale frame");
    assert.equal(captionedFrame.length, plainFrame.length);

    let differingInBand = 0;
    let differingAbove = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const index = y * width + x;
        if (plainFrame[index] === captionedFrame[index]) continue;
        // The band is the bottom third; captions sit at MarginV above the edge.
        if (y > height * 0.66) differingInBand += 1;
        else if (y < height * 0.5) differingAbove += 1;
      }
    }

    assert.ok(
      differingInBand > 300,
      `expected the caption band to change; only ${differingInBand} pixels differed`,
    );
    assert.equal(differingAbove, 0, "captions must not disturb the upper half of the frame");
  });

  it("renders a path containing a colon, which would otherwise break the filter graph", async () => {
    const trickyDir = path.join(dir, "a:b");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(trickyDir, { recursive: true });
    const srtPath = path.join(trickyDir, "c.srt");
    await writeFile(srtPath, toSrt([{ start: 0, end: 2, text: "colon path" }]), "utf8");

    const output = path.join(dir, "tricky.mp4");
    await renderClip({
      inputPath: source,
      outputPath: output,
      clip: { id: "c", start: 0, end: 3 },
      spec: SPEC,
      subtitlesPath: srtPath,
    });

    const { probeVideo } = await import("../../media/probe.ts");
    assert.equal((await probeVideo(output)).video.width, 270);
  });
});
