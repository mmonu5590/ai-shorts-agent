# Ingest

Ingest is the first pipeline stage. It takes an uploaded video stream and leaves
the job's storage prefix ready for transcription:

```
jobs/<jobId>/source.<ext>     the uploaded file, as received
jobs/<jobId>/metadata.json    container and stream metadata
jobs/<jobId>/audio.wav        16 kHz mono PCM, the transcription input
```

```ts
import { ingestVideo } from "./src/ingest/index.ts";
import { createStorage } from "./src/storage/index.ts";

const result = await ingestVideo({
  jobId: "job-001",
  filename: upload.originalName,
  source: upload.stream,
  storage: createStorage(),
  maxDurationSeconds: 3600,
});
```

## Requirements

`ffmpeg` and `ffprobe` must be on `PATH`, or located by `FFMPEG_PATH` and
`FFPROBE_PATH`.

```bash
# Debian/Ubuntu
sudo apt-get install ffmpeg
# macOS
brew install ffmpeg
```

Tests that need the binaries skip themselves when they are absent, so
`npm test` still passes without ffmpeg — it just covers less. CI installs it.

## Why the upload is staged on disk

ffprobe and ffmpeg both need a **seekable** input. An MP4 written with its
`moov` atom at the end of the file cannot be inspected from a pipe, and that
layout is what most phones and cameras produce. Streaming an upload directly
into ffmpeg therefore fails on exactly the files this tool exists to handle.

Ingest writes the upload to a temporary directory first, probes and decodes it
there, then uploads the results. The staging directory is removed in a `finally`
block, so a failed upload cannot strand a multi-gigabyte temp file.

## What gets rejected

Ingest fails fast, before any transcoding work, on:

| Condition | Reason |
| --- | --- |
| Extension not in `mp4, mov, m4v, webm, mkv` | Unsupported container |
| Job ID outside `[A-Za-z0-9_-]{1,64}` | It names a storage prefix |
| Empty file | Nothing to process |
| No video stream | Not a video |
| No usable duration | Truncated, or still uploading |
| Longer than `maxDurationSeconds` | Caller-set limit |
| No audio track | Cannot be transcribed or clip-selected |

The silent-video case is worth surfacing to the user explicitly: the file is
perfectly valid, it just cannot go through a transcription-driven pipeline.

## Handling untrusted filenames

The upload filename is attacker-controlled, so only its **extension** is read.
It never contributes to a storage key or a filesystem path — the stored object
is always `source.<ext>` under the job prefix. An upload called
`../../etc/passwd.mov` is stored as `jobs/<jobId>/source.mov`.

ffmpeg and ffprobe are spawned with argument arrays rather than through a shell,
so no filename can become executable text.

## Audio format

Output is 16 kHz mono PCM (`pcm_s16le`) because that is what speech-recognition
models expect; higher sample rates cost bytes without improving transcription.
`extractAudio` takes `sampleRate` and `channels` if a provider needs something
else.
