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
- 9:16 rendering
- API job status
- Mobile web starter

## Production Roadmap

Add real transcription/LLM/TTS providers, Redis queue, Supabase auth/database, face tracking, captions, audio isolation, AI narration, B-roll, billing and publishing.

Storage is already provider-neutral; see [docs/storage.md](docs/storage.md).

## Important Notes

- Users must have rights/permission to use uploaded content
- V1 does not clone voices
- V1 does not remove third-party watermarks

## Getting Started

```bash
npm install
cp .env.example .env
npm test
```

Storage defaults to the local filesystem, so nothing else is needed to run the
test suite. To use Google Drive as the backing store, follow
[docs/storage.md](docs/storage.md).

### Scripts

| Command | Purpose |
| --- | --- |
| `npm test` | Run the test suite |
| `npm run typecheck` | Typecheck without emitting |
| `npm run build` | Compile to `dist/` |

## Contributing

*(Contribution guidelines coming soon)*

## License

*(License selection pending)*
