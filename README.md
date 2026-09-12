# AI Shorts Agent — V1

Mobile-friendly AI video repurposing prototype.

## Pipeline

Upload long video → extract audio → transcription adapter → AI clip selection adapter → FFmpeg vertical rendering → output Shorts.

The AI produces an edit plan; FFmpeg performs deterministic rendering.

## V1 Features

- Upload MP4/MOV/M4V/WebM/MKV
- Video metadata extraction
- Audio extraction
- Provider-neutral transcription interface
- Provider-neutral LLM clip-selection interface
- Provider-neutral storage interface (local filesystem or Google Drive)
- Transcription via Deepgram, or a credential-free stub
- Ingest stage: upload validation, ffprobe metadata, audio extraction
- Validated edit plan schema (the AI/FFmpeg contract)
- Deterministic 9:16 rendering with crop or pad framing
- Burned-in captions from the transcript
- Job orchestration with per-stage status
- HTTP API with range-request playback
- Mobile web starter
- 9:16 rendering
- API job status
- Mobile web starter

## Production Roadmap

Add real transcription/LLM/TTS providers, Redis queue, Supabase auth/database, face tracking, captions, audio isolation, AI narration, B-roll, billing and publishing.

Docs: [the pipeline](docs/pipeline.md), [storage](docs/storage.md),
[ingest](docs/ingest.md), [edit plans and rendering](docs/editing.md).

## Important Notes

- Users must have rights/permission to use uploaded content
- V1 does not clone voices
- V1 does not remove third-party watermarks

## Getting Started

```bash
npm install
cp .env.example .env
npm run dev          # http://localhost:3000
```

Out of the box: local-filesystem storage, the stub transcriber, and the
heuristic selector — no credentials and no network. Upload a video from the web
client and rendered Shorts come back. See [docs/pipeline.md](docs/pipeline.md)
to plug in real providers.

Storage defaults to the local filesystem, so nothing else is needed to run the
test suite. To use Google Drive as the backing store, follow
[docs/storage.md](docs/storage.md).

### ffmpeg

The ingest and rendering stages shell out to `ffmpeg` and `ffprobe`:

```bash
sudo apt-get install ffmpeg   # Debian/Ubuntu
brew install ffmpeg           # macOS
```

Tests that need them skip when they are absent, so `npm test` passes either way
— it just covers less. CI installs ffmpeg.

### Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Run the server with reload |
| `npm start` | Run the built server |
| `npm test` | Run the test suite |
| `npm run typecheck` | Typecheck without emitting |
| `npm run build` | Compile to `dist/` |

## Contributing

*(Contribution guidelines coming soon)*

## License

*(License selection pending)*
