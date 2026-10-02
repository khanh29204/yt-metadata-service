# Operations

Deployment, configuration, and YouTube-specific setup. Primary Vietnamese reference:
`README.md` (env table + notes).

## Environment variables

Read once at startup in `src/config.ts` — restart the container to apply changes.

| Var | Required | Notes |
|---|---|---|
| SERVICE_API_KEY | ✅ | header `x-api-key`; empty = auth disabled |
| S3_BUCKET | ✅ | bucket holding the MP3s |
| S3_REGION | ✅ | e.g. `ap-southeast-1`; use `auto` for MinIO/R2 |
| S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY | ✅ | S3 credentials |
| S3_ENDPOINT | | MinIO/R2: `http://<host>:9000`; use the **private IP** if S3 is in the same VCN (internal ~480 Mbps, no bandwidth cost) |
| S3_PUBLIC_BASE | | public base URL returned to clients, **must include bucket prefix**: `https://s3.example.com/locket-music` |
| MONGO_URL | | e.g. `mongodb://mongo:27017/yt-metadata` |
| REDIS_URL | | default `redis://redis:6379`; TTL 1 day (`REDIS_TTL_S`) |
| YT_COOKIES | | cookie string `k=v; k2=v2` (grab from an incognito tab on `youtube.com/robots.txt`); defends against bot-check when the IP is flagged |
| MAX_DURATION_S | | default 900 (15 min); longer videos → 413 |
| MAX_CONCURRENCY | | default 2 — concurrent yt-dlp/ffmpeg jobs |
| PORT | | default 3001 |
| BGUTIL_URL | | default `http://bgutil:4416` (PO token provider) |

Also fixed in code: `timeoutMs = 5 min` for each yt-dlp/ffmpeg spawn (`config.ts`).

## Deployment

```bash
docker compose up --build -d          # build locally
docker compose pull && up -d          # production (prebuilt image)
```

Compose services: `api` (port 3001), `bgutil` (PO token provider for yt-dlp), `redis`.
MongoDB is external via `MONGO_URL`. Compose resource limits simulate Oracle
E2.1.Micro (1 OCPU / 1 GB) — validated with 30 users. Do not remove the concurrency
limit or the memory cap; cold resolves OOM otherwise (see [architecture.md](architecture.md#concurrency-semaphore)).

## YouTube anti-bot setup

yt-dlp uses the bgutil PO token provider plugin (compose service `bgutil`). If YouTube
bot-checks the VM's static Oracle IP, set `YT_COOKIES`:

1. Open an incognito tab, visit `youtube.com/robots.txt`, copy cookies (see the
   "Exporting YouTube cookies" wiki page referenced in README).
2. Paste as `k=v; k2=v2` into `YT_COOKIES`.
3. Cookies are written once to `/tmp/yt-cookies.txt` at startup (`src/ytdlp.ts`) —
   changing them requires a container restart. Netscape format is also accepted.

## Change checklists

- **Changing encoder settings**: app duration math depends on exactly 64 kbps CBR —
  see [Why CBR matters](architecture.md#why-cbr-matters). Update the S3 key hash too.
- **Any source change**: run `npm run check` (tsc --noEmit). No test suite exists.
- **Scaling**: the semaphore is in-process; single instance only. Scale horizontally if
  throughput must grow.
- **Debugging 502s**: error messages include the last 500 chars of yt-dlp/ffmpeg stderr.
