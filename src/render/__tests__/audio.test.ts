import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { ffmpegAvailable, ffmpegBinary, run } from "../../media/ffmpeg.ts";
import { type OutputSpec, DEFAULT_OUTPUT } from "../../plan/types.ts";
import { DEFAULT_AUDIO, buildAudioFilter } from "../audio.ts";
import { renderClip } from "../index.ts";

const hasFfmpeg = await ffmpegAvailable();
const SPEC: OutputSpec = { ...DEFAULT_OUTPUT, width: 270, height: 480, preset: "ultrafast" };

describe("buildAudioFilter", () => {
  it("returns undefined when there is nothing to do", () => {
    assert.equal(buildAudioFilter(undefined), undefined);
  });

  it("normalises to the configured target", () => {
    const filter = buildAudioFilter(DEFAULT_AUDIO) as string;
    assert.ok(filter.includes("loudnorm=I=-14:TP=-1.5:LRA=11"), filter);
  });

  it("always resamples after loudnorm", () => {
    // loudnorm emits 192 kHz; AAC tops out at 96 kHz, so the encode would fail.
    assert.ok((buildAudioFilter(DEFAULT_AUDIO) as string).endsWith("aresample=48000"));
  });

  it("denoises before normalising, not after", () => {
    // Measuring loudness over the noise floor makes normalisation undershoot.
    const filter = buildAudioFilter({ ...DEFAULT_AUDIO, denoise: true }) as string;
    assert.ok(filter.indexOf("afftdn") < filter.indexOf("loudnorm"), filter);
    assert.ok(filter.includes("afftdn=nr=12"));
  });

  it("omits the denoiser when it is off", () => {
    assert.ok(!(buildAudioFilter(DEFAULT_AUDIO) as string).includes("afftdn"));
  });
});

/**
 * Integrated loudness in LUFS, from ffmpeg's EBU R128 meter.
 *
 * The meter prints a running `I:` on every progress line, and the first of
 * those reads -70.0 before it has measured anything. Matching the first `I:`
 * in stderr therefore reports silence for every file — so this reads the
 * `Integrated loudness:` summary block that the filter prints at the end.
 */
async function integratedLufs(videoPath: string): Promise<number> {
  const { stderr } = await run(ffmpegBinary(), [
    "-nostdin", "-i", videoPath, "-af", "ebur128", "-f", "null", "-",
  ]);
  const match = /Integrated loudness:\s*\n\s*I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/u.exec(stderr);
  assert.ok(match, `no integrated loudness summary in ffmpeg output:\n${stderr.slice(-800)}`);
  return Number(match[1]);
}

describe("loudness normalisation", { skip: hasFfmpeg ? false : "ffmpeg not installed" }, () => {
  let dir: string;
  let quiet: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "audio-render-"));
    quiet = path.join(dir, "quiet.mp4");
    // A deliberately quiet source, ~20 dB under where a Short should land.
    await run(ffmpegBinary(), [
      "-nostdin", "-y",
      "-f", "lavfi", "-i", "testsrc=duration=5:size=320x240:rate=30",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=5",
      "-filter:a", "volume=-30dB",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", quiet,
    ]);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("pulls a quiet source up toward the target", async () => {
    const clip = { id: "c1", start: 0, end: 4 };
    const untouched = path.join(dir, "untouched.mp4");
    const normalised = path.join(dir, "normalised.mp4");

    await renderClip({ inputPath: quiet, outputPath: untouched, clip, spec: SPEC, audio: null });
    await renderClip({ inputPath: quiet, outputPath: normalised, clip, spec: SPEC });

    const before = await integratedLufs(untouched);
    const after = await integratedLufs(normalised);

    assert.ok(before < -40, `source should start quiet, measured ${before} LUFS`);
    assert.ok(
      Math.abs(after - DEFAULT_AUDIO.targetLufs) < Math.abs(before - DEFAULT_AUDIO.targetLufs),
      `normalising should move ${before} LUFS toward ${DEFAULT_AUDIO.targetLufs}, got ${after}`,
    );
    assert.ok(after > before + 10, `expected a large gain, went ${before} -> ${after} LUFS`);
    assert.ok(
      Math.abs(after - DEFAULT_AUDIO.targetLufs) < 1.5,
      `expected to land near ${DEFAULT_AUDIO.targetLufs} LUFS, got ${after}`,
    );
  });

  it("produces audio AAC can actually carry after loudnorm's internal 192 kHz", async () => {
    const output = path.join(dir, "encoded.mp4");
    await renderClip({
      inputPath: quiet,
      outputPath: output,
      clip: { id: "c", start: 0, end: 3 },
      spec: SPEC,
    });

    const { probeVideo } = await import("../../media/probe.ts");
    const metadata = await probeVideo(output);
    assert.equal(metadata.audio?.codec, "aac");
    assert.equal(metadata.audio?.sampleRate, 48_000);
  });

  it("leaves audio untouched when normalisation is off", async () => {
    const output = path.join(dir, "raw.mp4");
    await renderClip({
      inputPath: quiet,
      outputPath: output,
      clip: { id: "c", start: 0, end: 3 },
      spec: SPEC,
      audio: null,
    });

    assert.ok((await integratedLufs(output)) < -40);
  });
});
