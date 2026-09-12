import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_OUTPUT, type OutputSpec } from "../../plan/types.ts";
import { buildClipArgs, buildVerticalFilter } from "../filters.ts";

const SPEC: OutputSpec = DEFAULT_OUTPUT;

describe("buildVerticalFilter", () => {
  it("defaults to a centred crop", () => {
    const filter = buildVerticalFilter(undefined, SPEC);

    assert.match(filter, /^crop=/u);
    assert.ok(filter.includes("*0.5"), "expected a centred crop");
    assert.ok(filter.includes("scale=1080:1920"));
    assert.ok(filter.endsWith("setsar=1"));
  });

  it("branches on whether the source is wider than the target", () => {
    // One formula cannot serve both: a 16:9 source needs full height and reduced
    // width, a 9:20 source the reverse. A single formula would ask ffmpeg for a
    // crop window larger than the source.
    const filter = buildVerticalFilter({ mode: "crop" }, SPEC);

    assert.ok(filter.includes("if(gt(iw/ih"), "expected an aspect-ratio branch");
    assert.ok(filter.includes("ih*0.5625"), "expected the target aspect ratio");
  });

  it("places the crop window using centerX", () => {
    assert.ok(buildVerticalFilter({ mode: "crop", centerX: 0 }, SPEC).includes("*0"));
    assert.ok(buildVerticalFilter({ mode: "crop", centerX: 1 }, SPEC).includes("*1"));
    assert.ok(buildVerticalFilter({ mode: "crop", centerX: 0.25 }, SPEC).includes("*0.25"));
  });

  it("escapes commas inside the crop expressions", () => {
    // An unescaped comma would end the crop filter and start a new one.
    const filter = buildVerticalFilter({ mode: "crop" }, SPEC);
    const cropSegment = filter.slice(0, filter.indexOf(",scale="));

    assert.ok(!/[^\\],/u.test(cropSegment), `unescaped comma in: ${cropSegment}`);
  });

  it("scales and letterboxes in pad mode", () => {
    const filter = buildVerticalFilter({ mode: "pad" }, SPEC);

    assert.ok(filter.includes("force_original_aspect_ratio=decrease"));
    assert.ok(filter.includes("pad=1080:1920"));
    assert.ok(!filter.includes("crop="), "pad mode must not crop");
  });

  it("follows a custom output size", () => {
    const filter = buildVerticalFilter({ mode: "pad" }, { ...SPEC, width: 540, height: 960 });

    assert.ok(filter.includes("scale=540:960"));
    assert.ok(filter.includes("pad=540:960"));
  });
});

describe("buildClipArgs", () => {
  const args = buildClipArgs({
    inputPath: "/tmp/source.mp4",
    outputPath: "/tmp/out.mp4",
    start: 12.5,
    duration: 8,
    framing: { mode: "crop" },
    spec: SPEC,
  });

  it("seeks before the input so ffmpeg does not decode the discarded head", () => {
    assert.ok(args.indexOf("-ss") < args.indexOf("-i"), "-ss must precede -i");
    assert.equal(args[args.indexOf("-ss") + 1], "12.5");
    assert.equal(args[args.indexOf("-t") + 1], "8");
  });

  it("requests a pixel format phones and browsers can decode", () => {
    assert.equal(args[args.indexOf("-pix_fmt") + 1], "yuv420p");
  });

  it("puts the moov atom at the front for progressive playback", () => {
    assert.equal(args[args.indexOf("-movflags") + 1], "+faststart");
  });

  it("ends with the output path", () => {
    assert.equal(args.at(-1), "/tmp/out.mp4");
  });

  it("passes paths as discrete arguments, never as shell text", () => {
    const quoted = buildClipArgs({
      inputPath: "/tmp/my video; rm -rf /.mp4",
      outputPath: "/tmp/out.mp4",
      start: 0,
      duration: 1,
      framing: undefined,
      spec: SPEC,
    });

    assert.ok(quoted.includes("/tmp/my video; rm -rf /.mp4"), "path must survive intact as one argv entry");
  });
});
