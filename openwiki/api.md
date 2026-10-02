# API

Two endpoints, both supporting JSON or SSE mode. Auth: `x-api-key` header must equal
`SERVICE_API_KEY` (checked in `src/routes.ts`; skipped entirely when the key is unset).

## POST /resolve

Body: `{"videoId": "..."}` or `{"url": "https://music.youtube.com/watch?v=..."}`.
Accepted URL forms: `youtube.com`, `music.youtube.com`, `youtu.be`, or a bare 11-char ID.

Success `200`:

```json
{
  "videoId": "RKvRLLQtDbg",
  "title": "Lạc Trôi",
  "artist": "Sơn Tùng M-TP",
  "thumbnail": "https://i.ytimg.com/vi/.../hqdefault.jpg",
  "durationMs": 232888,
  "s3Url": "https://.../songs/RKvRLLQtDbg/<hash>.mp3",
  "waveform": [0.02, 0.11, 0.47, "..."]
}
```

- `waveform`: 200 peaks in 0..1 for drawing the audio waveform in the app.
- Idempotent: existing S3 objects return immediately (see [architecture.md](architecture.md)).

## GET /api/v1/audio-url

Same semantics, parameters via query string: `?videoId=...` or `?url=...`.

## SSE mode (`?sse=1`)

Add `?sse=1` to **either** endpoint. Without the flag, plain JSON is returned.

```
event: step
data: {"step":"s3-check"}      # HEAD check before downloading
event: step
data: {"step":"downloading"}
event: step
data: {"step":"encoding"}
event: step
data: {"step":"uploading"}

event: done
data: {"videoId":"...","s3Url":"...","title":"..."}
```

- Cache hit (Redis/Mongo) → no steps, straight to `event: done`.
- Old records without `waveform` → `step: backfilling` with `pct` while peaks are extracted.
- Errors → `event: error` with `{"error": "..."}`.
- `: ping` comment every 15 s keeps the connection alive through proxies.
- React Native clients: use `EventSource`, or `fetch` + stream reader (POST requires fetch+reader).

## Error codes

| Status | Meaning |
|---|---|
| 400 | Bad body / invalid videoId or url |
| 401 | Wrong or missing `x-api-key` |
| 413 | Video longer than `MAX_DURATION_S` (default 900 s / 15 min) |
| 415 | No audio stream available |
| 502 | yt-dlp / ffmpeg / S3 failure (stderr tail included in message) |
