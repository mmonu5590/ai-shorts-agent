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
