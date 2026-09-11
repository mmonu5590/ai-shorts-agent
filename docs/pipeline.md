# The pipeline

```
upload → ingest → transcribe → select → render → Shorts
          │         │            │        │
          │         │            │        └─ jobs/<id>/shorts/clip-NN.mp4
          │         │            └────────── jobs/<id>/edit-plan.json
          │         └─────────────────────── jobs/<id>/transcript.json
          └───────────────────────────────── jobs/<id>/source.<ext>, audio.wav, metadata.json
```

Every stage writes its output to storage before the next begins, so a job's
prefix is a complete record of what happened and a failed job can be inspected
at the stage it reached.

## Running it

```bash
npm install
cp .env.example .env
npm run dev          # http://localhost:3000
```

Out of the box this uses local-filesystem storage, the stub transcriber, and
the heuristic selector — no credentials, no network. Upload a video from the
web client and you get rendered Shorts back.

## Stages

| Stage | Module | Needs credentials |
| --- | --- | --- |
| Ingest | `src/ingest` | No (ffmpeg) |
| Transcribe | `src/transcribe` | Depends on provider |
| Select | `src/select` | Only for `claude` |
| Render | `src/render` | No (ffmpeg) |

### Transcription

`Transcriber` is the provider-neutral interface; `Transcript` is the shape the
rest of the pipeline sees. Only `StubTranscriber` ships today — it measures the
audio and emits evenly spaced placeholder segments.

**That is deliberately useless for real clip selection.** It exists so the
wiring can run and be tested without a provider. Real selection needs a real
ASR provider: implement `Transcriber` against its API and add a case to
`createTranscriber`. Nothing downstream changes.

### Clip selection

| Selector | `CLIP_SELECTOR` | Behaviour |
| --- | --- | --- |
| Heuristic | `heuristic` (default) | Spreads clips evenly, snapping boundaries onto transcript segment edges so cuts land between utterances. Makes no editorial claim. No credentials. |
| Claude | `claude` | Reads the timestamped transcript and picks self-contained moments with titles and crop framing. |

The Claude selector uses `claude-opus-5` with adaptive thinking and constrains
the response with a schema. **The schema guarantees well-formed JSON, not
sensible timestamps** — so the result still goes through `validateEditPlan`,
which checks it against the duration ingest measured. See
[docs/editing.md](editing.md).

Credentials come from the Anthropic SDK's normal resolution: `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN`, or an `ant auth login` profile.

## Jobs

`Job` carries the status, and the statuses *are* the stages — `queued`,
`ingesting`, `transcribing`, `selecting`, `rendering`, `complete`, `failed` —
so a client can show progress without knowing anything else.

`runJob` **never throws**. Its caller is a fire-and-forget background task with
nowhere to catch, so a failure is recorded on the job as `status: "failed"` with
a message instead of taking the process down.

`InMemoryJobStore` is adequate for a single-process prototype and nothing more:
restarting the server loses every job. Swapping in Redis or Postgres means
implementing `JobStore`.

## HTTP API

| Route | Purpose |
| --- | --- |
| `GET /` | The mobile web client |
| `POST /api/jobs?filename=<name>` | Upload a video; returns `202` and a job |
| `GET /api/jobs` | All jobs, newest first |
| `GET /api/jobs/:id` | One job's status |
| `GET /api/jobs/:id/shorts/:n` | Stream a rendered Short (supports `Range`) |

### The upload must be read before the response is sent

`POST /api/jobs` stages the upload to disk and only then returns `202`.

Responding first does not work. Once the response ends, Node drains and
discards the unread request body to free the socket for keep-alive, and the
pipeline — which has not attached to the stream yet, being on a later tick —
receives an empty upload. The failure is silent and looks like a corrupt file.

Staging first also makes `202 Accepted` truthful: the bytes really have been
accepted by the time the client sees it.

### Range requests

`GET /api/jobs/:id/shorts/:n` honours `Range`, including suffix ranges
(`bytes=-200`), and answers `206` with a `Content-Range`. Mobile players seek by
issuing range requests; without this they refetch whole files.

## Web client

`public/index.html` is a single dependency-free page: choose a video, upload,
watch the stages advance, play the Shorts inline. It polls once a second —
the pipeline reports at stage granularity, so a socket would add complexity for
latency nobody can see.
