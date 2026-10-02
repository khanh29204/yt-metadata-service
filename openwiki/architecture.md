# Architecture

Small, single-instance Express service. Everything lives in `src/` (12 files). This page
explains the request flow and the non-obvious design decisions.

## Request flow

1. **`src/routes.ts`** — Express router. Applies `express.json()`, a simple `x-api-key`
   auth middleware (skipped when `SERVICE_API_KEY` is empty), then dispatches to
   `ResolveController` — either plain JSON or SSE mode when `?sse=1`.
2. **`src/resolve.controller.ts`** — validates the body/query (`videoId` or `url`;
   accepts youtube.com, music.youtube.com, youtu.be, or a bare 11-char ID), maps
   `HttpError` to HTTP status, collects step callbacks for SSE.
3. **`src/resolver.ts` (`ResolverService`)** — orchestration with this lookup order:
   1. Redis cache (`src/cache.ts`, TTL `REDIS_TTL_S`, default 1 day)
   2. MongoDB (`src/db.ts`, collection `songs`, `_id`-style unique `videoId`)
   3. S3 HEAD (`src/storage.ts`) — MP3 present but DB record missing → reconstruct metadata
   4. Fresh download: yt-dlp fetches audio + metadata in one run, ffmpeg encodes, S3 PUT,
      then write Mongo (durable) + Redis (hot).
4. Writes are idempotent by design: the S3 key is `songs/<videoId>/<sha1(videoId)[0..12]>.mp3`
   — a stable key makes the S3 HEAD check act as a cache.

## Why CBR matters

The Locket app computes duration as `filesize / 8000 bytes/s`, which is only valid for a
constant bitrate of exactly **64 kbps** (`src/encoder.ts`). The encoder therefore always
produces MP3 64k CBR 44.1 kHz **without metadata** — any ID3/Vorbis tags would shift the
filesize and break duration math. If you ever change ffmpeg args, also fold the args into
the S3 key hash (`resolver.ts` comment: "đưa args vào hash") or cached files will be wrong.

## Waveform (single decode)

`EncoderService.toMp3` decodes the input **once** with two outputs: the MP3 file and raw
PCM mono 8 kHz piped to stdout. From the PCM it computes `WAVEFORM_POINTS = 200` peaks
(0..1) used by the app to draw the waveform. No second decode pass.

**Backfill** (`ResolverService.withWaveform`): songs saved before the waveform field exist
without peaks. On request, the service downloads the MP3 from S3, re-decodes to extract
peaks, updates Mongo + Redis, and emits an SSE `backfilling` step with a `pct`. Backfill
failures are logged and swallowed — the request still returns the song as-is.

## Concurrency (semaphore)

`ResolverService.limited()` is an in-process FIFO semaphore capped by `MAX_CONCURRENCY`
(default 2). Rationale from source comments: each yt-dlp/ffmpeg job consumes ~150–250 MB;
30 parallel jobs caused OOM kills on the 1 GB Oracle VM. This is sufficient for a single
instance; scale horizontally if needed. Applies to both fresh downloads and waveform backfills.

## S3 storage without AWS SDK

`src/storage.ts` signs requests with **SigV4 implemented by hand** using `node:crypto`
(path-style URLs, works with AWS S3, MinIO, Cloudflare R2). Gotchas encoded in comments:

- Canonical headers must end each line with `\n` and join with `""` — one wrong newline
  produces `SignatureDoesNotMatch`.
- Uploads set `content-type: audio/mpeg` and `content-disposition: inline` so browser
  links **play** the music instead of downloading it.
- `S3_PUBLIC_BASE` must include the bucket prefix (e.g. `https://s3.example.com/locket-music`).
- If S3 lives in the same VCN, point `S3_ENDPOINT` at the private IP (internal traffic
  ~480 Mbps, no bandwidth cost).

## SSE mode

`routes.ts` switches to `text/event-stream` when `?sse=1`: steps (`s3-check`,
`downloading`, `encoding`, `uploading`, optionally `backfilling`) are streamed as
`event: step` frames, ending with `event: done` or `event: error`. A `: ping` comment is
sent every 15 s to survive proxies. Cache hits emit no steps — straight to `done`.
Progress percentages come from parsing yt-dlp stdout (`[download] 12.3%`) and ffmpeg
stderr (`time=` vs `Duration:`) in `ytdlp.ts`/`encoder.ts`.

## Dependency injection

`src/di.ts` is a minimal NestJS-style container: `@Injectable()` decorator +
`reflect-metadata` design:paramtypes for constructor injection, resolved in `routes.ts`.
No framework beyond Express; the pattern exists to keep services testable and layering clean.

## Runtime: yt-dlp needs a JS engine

History (git log): the project moved Deno → Bun → **Node.js**, landing on
`node:22-alpine` because yt-dlp's EJS challenge solver requires a modern JS runtime.
Docker is multi-stage with static musl ffmpeg (~2.7 MB) for a ~380 MB final image.

## Related docs in repo

- `README.md` — primary reference (Vietnamese).
- `docs/API.md` — endpoint details.
- `docs/youtube-music-integration.md` — background on the YouTube Music integration.
