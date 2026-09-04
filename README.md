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
- 9:16 rendering
- API job status
- Mobile web starter

## Production Roadmap

Add real transcription/LLM/TTS providers, Redis queue, R2 storage, Supabase auth/database, face tracking, captions, audio isolation, AI narration, B-roll, billing and publishing.

## Important Notes

- Users must have rights/permission to use uploaded content
- V1 does not clone voices
- V1 does not remove third-party watermarks

## Getting Started

*(Project setup instructions coming soon)*

## Contributing

*(Contribution guidelines coming soon)*

## License

*(License selection pending)*
