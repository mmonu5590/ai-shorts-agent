# Edit plans and rendering

The README's architecture — *"the AI produces an edit plan; FFmpeg performs
deterministic rendering"* — is enforced by these two modules. The edit plan is
the only thing that crosses between them.

## The plan

```jsonc
{
  "version": 1,
  "jobId": "job-001",
  "clips": [
    {
      "id": "clip-1",
      "start": 132.5,              // seconds into the source
      "end": 168.0,
      "title": "The part about latency",
      "reason": "Self-contained answer with a clear hook",
      "framing": { "mode": "crop", "centerX": 0.4 }
    }
  ]
}
```

`framing` decides how a 16:9 frame becomes 9:16:

| Mode | Behaviour |
| --- | --- |
| `crop` (default) | Takes a 9:16 window, discarding the sides. Fills the frame. |
| `pad` | Scales the whole frame to fit and letterboxes the rest. Loses nothing. |

`centerX` (0 = hard left, 1 = hard right, default 0.5) positions the crop
window. It is the hook face tracking will drive later; until then a model can
aim it at whoever is speaking.

## Validation is a trust boundary

An edit plan arrives as whatever a language model emitted. `validateEditPlan`
is where that becomes a typed `EditPlan` — or gets refused:

```ts
const plan = validateEditPlan(modelOutput, {
  sourceDuration: metadata.duration,  // from ingest, not from the model
  jobId: "job-001",
});
```

Two properties are worth calling out.

**The source duration comes from ingest, never from the plan.** A model that
believes the video is an hour long cannot thereby cut an hour of clips out of a
two-minute file.

**Every issue is collected, not just the first.** The `EditPlanError` carries
the full list, which is what you feed back to the model on a retry — fixing one
problem per round trip is the slow way to converge.

Rejected: wrong version, malformed or mismatched job ID, non-finite timestamps,
`end` at or before `start`, ranges past the end of the source, clips outside the
duration bounds, duplicate clip IDs, too many clips, unknown framing modes, and
`centerX` outside 0..1.

A clip whose `end` overshoots the source by less than 0.5s is **clamped** rather
than rejected. Models habitually round the last timestamp up; anything further
past the end is a model that has lost track of the video.

## Rendering

```ts
const result = await renderPlan({
  plan,
  storage,
  sourceKey: "jobs/job-001/source.mp4",
  onProgress: (done, total) => console.log(`${done}/${total}`),
});
```

Each clip becomes `jobs/<jobId>/shorts/clip-NN.mp4`. The source is fetched to
local disk once and reused — ffmpeg needs a seekable input, and re-fetching a
multi-gigabyte video from Drive per clip would dominate the render time. Each
rendered clip is deleted once stored, so a 20-clip plan never holds twenty
outputs on disk at once.

### A zero exit status is not success

Seeking past the end of a source makes ffmpeg write a **valid container with no
frames in it and exit 0**. Trusting the exit code would store and serve that as
a Short.

So every rendered clip is probed before it is stored, and a clip with no
readable video or zero duration raises `RenderError`. Validation normally stops
such a plan earlier, but `renderPlan` accepts hand-built plans too, and this is
the layer that has to hold.

### Encoding choices

`-pix_fmt yuv420p` because libx264 would otherwise pick a profile many phone
and browser decoders reject. `-movflags +faststart` moves the moov atom to the
front so playback starts before the download finishes — the same property whose
absence in uploads forces ingest to stage files on disk.

`-ss` precedes `-i` so ffmpeg seeks before decoding instead of decoding and
discarding everything up to the cut. Because the clip is re-encoded anyway, the
seek stays frame-accurate.

## Captions

Most Shorts are watched with the sound off, so the transcript is burned into
the frame rather than left in a JSON file.

```ts
await renderPlan({
  plan,
  storage,
  sourceKey,
  transcript,
  captions: { enabled: true },
});
```

Cues are cut to the clip's range and rebased to clip-relative time. A cue that
straddles a boundary is **trimmed, not dropped** — the words falling inside the
clip are the ones the viewer hears. With word timings, cues are grouped into
short lines (5 words or 3 seconds, whichever comes first); without them, whole
transcript segments become cues, which is coarser but still beats nothing.

### `CAPTIONS=auto` will not caption stub output

`auto` (the default) turns captions on **unless the transcript came from the
stub transcriber**. The stub emits `[untranscribed audio 0.0s-15.0s]`
placeholders; burning those across every Short reads as a bug to a viewer, and
no captions is the better failure. `CAPTIONS=on` and `CAPTIONS=off` override it.

### Two things that break subtitle burn-in quietly

**Filter-graph escaping.** Backslashes, colons and single quotes all terminate
or reinterpret filter arguments, so a staging directory containing a colon
silently builds the wrong graph. `escapeFilterPath` handles it, and a test
renders through a path with a colon in it.

**Font sizing.** libass renders SRT against a virtual canvas 288 units tall, so
the ASS `FontSize` is a fraction of 288, not a pixel count. Passing a pixel
value produces microscopic text. `fontSizeRatio` is expressed as a fraction of
frame height and converted; `original_size` tells libass the real frame so the
margins land correctly.

The subtitles filter runs **after** scaling — libass draws at the final frame
size, and captions applied before the scale would be resampled with the
picture.

### Verifying it actually rendered

ffmpeg accepting a filter is not evidence that anything was drawn. The test
renders the same clip with and without captions, decodes one frame of each as
grayscale, and compares them pixel by pixel: the bottom band must change, and
the upper half must be byte-identical.

## Audio

Source videos arrive at wildly different levels — a phone recording and a
studio podcast sit 20 dB apart — and a Short that plays quiet after a loud one
gets skipped. Every clip is normalised to **-14 LUFS integrated**, which is
what the major short-form platforms normalise toward, so their own gain stage
is close to a no-op and the viewer hears the mix that was made.

```ts
await renderPlan({ plan, storage, sourceKey, audio: { ...DEFAULT_AUDIO, denoise: true } });
await renderPlan({ plan, storage, sourceKey, audio: null }); // leave audio alone
```

Denoise (`afftdn`) runs **before** normalisation. Measuring loudness over the
noise floor lets hiss pull the reading up, and normalisation then undershoots
the target by however loud the noise was. It is off by default, because
spectral denoise on already-clean speech does more harm than good.

### loudnorm emits 192 kHz

`loudnorm` resamples internally and outputs at 192 kHz. AAC tops out at 96 kHz,
so the encode fails on the way out unless the chain ends in `aresample`. It
always does, and a test asserts the rendered file really is 48 kHz AAC.

### Measuring it, and one trap in doing so

The test renders a deliberately quiet source with and without normalisation and
measures both with ffmpeg's EBU R128 meter, asserting the output lands within
1.5 LU of the target.

Reading that meter needs care: `ebur128` prints a running `I:` on **every**
progress line, and the first reads `-70.0` before it has measured anything.
Matching the first `I:` in stderr reports silence for every file — which is
exactly what the first version of this test did, and it would have passed
happily against a filter chain that did nothing. The helper parses the
`Integrated loudness:` summary block the filter prints at the end.
