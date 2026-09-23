# yt-metadata-service

POST /resolve: nhận videoId/link YouTube Music → tải audio bằng yt-dlp (PO token qua [bgutil provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)) → encode MP3 64kbps CBR không metadata (app tính duration = filesize / 8000 bytes/s) → upload S3 → trả metadata.

Idempotent: MP3 đã có trên S3 (HEAD) → trả ngay không tải lại. Metadata cache in-memory 1 ngày.

## Chạy

```bash
cp .env.example .env   # điền giá trị rồi:
docker compose up --build -d
```

## Biến env (.env)

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| SERVICE_API_KEY | ✅ | header `x-api-key`, bỏ trống = không check auth |
| S3_BUCKET | ✅ | bucket chứa MP3 |
| S3_REGION | ✅ | VD `ap-southeast-1` |
| S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY | ✅ | credentials SDK |
| S3_ENDPOINT | | S3-compatible (R2, MinIO): ví dụ `https://<account>.r2.cloudflarestorage.com`; bỏ trống nếu dùng AWS S3 |
| S3_PUBLIC_BASE | | nếu bucket không public: base URL để sinh link (VD kèm CloudFront); bỏ trống = URL chuẩn `https://bucket.s3.region.amazonaws.com/key` |
| BGUTIL_URL | | mặc định `http://bgutil:4416` (service trong compose) |
| MONGO_URL | | mặc định `mongodb://mongo:27017/yt-metadata` — lưu bền metadata bài hát |
| REDIS_URL | | mặc định `redis://redis:6379` — cache nóng metadata, TTL 1 ngày (`REDIS_TTL_S`) |
| MAX_DURATION_S | | mặc định 900 (15 phút), quá → 413 |
| PORT | | mặc định 3001 |

Lookup thứ tự: Redis → MongoDB → S3 (HEAD) → tải mới. Mongo là source of truth
(`songs`: videoId, title, artist, thumbnail, durationMs, s3Key, s3Url — không lưu
stream link vì MP3 đã nằm trên S3); Redis chết/fall-back không làm fail request.

## Test

```bash
curl -X POST localhost:3001/resolve \
  -H 'x-api-key: KEY' -H 'Content-Type: application/json' \
  -d '{"videoId":"RKvRLLQtDbg"}'
# hoặc -d '{"url":"https://music.youtube.com/watch?v=RKvRLLQtDbg"}'
```

Response:

```json
{
  "videoId": "RKvRLLQtDbg",
  "title": "...",
  "artist": "...",
  "thumbnail": "https://i.ytimg.com/vi/.../hqdefault.jpg",
  "durationMs": 232888,
  "s3Url": "https://bucket.s3.region.amazonaws.com/songs/RKvRLLQtDbg/<hash>.mp3"
}
```

Lỗi: 401 sai key, 400 sai body/videoId, 413 quá 15 phút, 415 không có audio, 502 yt-dlp/ffmpeg lỗi.

## Lưu ý

- yt-dlp + plugin bgutil nằm trong image; YouTube chặn bản cũ → nâng định kỳ: `docker compose exec api pip3 install --break-system-packages -U yt-dlp bgutil-ytdlp-pot-provider && docker compose restart api`.
- Nếu provider hết token/timeout, yt-dlp sẽ báo "PO Token" trong stderr → lỗi 502.
