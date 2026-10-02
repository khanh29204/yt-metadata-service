# Quickstart — yt-metadata-service

Microservice backing the **music clip** feature of the Locket app. It accepts a YouTube
video ID or link, downloads audio via `yt-dlp` (PO token through the
[bgutil provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)), encodes MP3
**64 kbps CBR with no metadata**, uploads to S3, and returns metadata.

**Idempotent:** if the MP3 already exists on S3, it returns immediately without re-downloading.

> Docs in this repo (README.md, docs/) are written in Vietnamese; this wiki is English.
> Language note: app duration math assumes CBR — see [Why CBR matters](architecture.md#why-cbr-matters).

## Architecture at a glance

```
Locket app ──► POST /resolve (or GET /api/v1/audio-url)
               │
               ▼
       ResolverService (lookup order)
         1. Redis      — hot cache, TTL 1 day
         2. MongoDB    — source of truth (collection `songs`)
         3. S3 HEAD    — MP3 exists but DB record missing
         4. Fresh download: yt-dlp (metadata + audio in one run)
                       → ffmpeg MP3 64k CBR (+ waveform in same decode)
                       → S3 PUT → write Mongo + Redis
```

- **DI**: hand-rolled NestJS-style mini container (`src/di.ts`, `@Injectable()` + `reflect-metadata`), constructor injection.
- **Layering**: `routes.ts` (router) → `resolve.controller.ts` (validate/error mapping) → `resolver.ts` (orchestration) → services: `ytdlp.ts`, `encoder.ts`, `storage.ts` (SigV4 signed with `node:crypto`, no AWS SDK), `db.ts` (mongoose), `cache.ts` (redis).
- **Semaphore** limits concurrent yt-dlp/ffmpeg jobs (`MAX_CONCURRENCY`, default 2) to prevent OOM on a 1 GB VM; excess jobs queue.
- **Image**: multi-stage, `node:22-alpine` (Node ≥ 22 is the JS runtime for yt-dlp's EJS challenge solver), static musl ffmpeg (~2.7 MB), final image ~380 MB.

See [architecture.md](architecture.md) for details and [api.md](api.md) for the full API.

## Run

```bash
cp .env.example .env   # fill values, then:
docker compose up --build -d   # production: docker compose pull && up -d
```

Compose runs: `api` (port 3001), `bgutil` (PO token provider), `redis`. MongoDB is
external (`MONGO_URL`). Compose resource limits simulate an Oracle E2.1.Micro
(1 OCPU / 1 GB) — served 30 users; cold resolves need `MAX_CONCURRENCY` to avoid OOM.

Full env var table: [operations.md](operations.md#environment-variables).

## Checks

- `npm run check` — TypeScript typecheck (`tsc --noEmit`). This is the only automated check; **no test suite exists**.
- No linter configured.

## Where to go next

- [architecture.md](architecture.md) — request flow, semaphore, SigV4 signing, waveform, SSE internals.
- [api.md](api.md) — endpoints, SSE event protocol, error codes.
- [operations.md](operations.md) — env vars, deployment, YouTube cookies/PO tokens, troubleshooting.

## Backlog

- Testing area — source anchor: `package.json` (only `check` script). Reason: no tests exist in the repo yet; document a testing strategy when one is added.
- `docs/API.md` and `docs/youtube-music-integration.md` — summarized in api.md/architecture.md; not separately indexed.
