# yt-metadata-service

Microservice cho tính năng music clip của app Locket: nhận videoId/link YouTube → tải audio bằng yt-dlp (PO token qua [bgutil provider](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)) → encode MP3 64kbps CBR **không metadata** (app tính duration = filesize / 8000 bytes/s, bắt buộc CBR) → upload S3 → trả metadata.

Idempotent: bài nào đã có trên S3 thì trả ngay, không tải lại.

## Kiến trúc

```
app Locket ──► POST /resolve
                │
                ▼
        ResolverService (thứ tự lookup)
          1. Redis      — cache nóng, TTL 1 ngày
          2. MongoDB    — source of truth (collection songs)
          3. S3 HEAD    — MP3 có sẵn nhưng DB trống
          4. Tải mới:   yt-dlp (tải + metadata trong 1 lần chạy)
                        → ffmpeg MP3 64k CBR → S3 PUT → ghi Mongo + Redis
```

- **DI kiểu NestJS**: mini container tự viết (`src/di.ts`, `@Injectable()` + `reflect-metadata`), constructor injection.
- **Chia lớp**: `routes.ts` (router) → `resolve.controller.ts` (validate/map lỗi) → `resolver.ts` (orchestration) → các service: `ytdlp.ts`, `encoder.ts`, `storage.ts` (S3 SigV4 tự ký bằng `node:crypto`, không dùng AWS SDK), `db.ts` (mongoose), `cache.ts` (redis).
- **Semaphore** giới hạn yt-dlp/ffmpeg chạy đồng thời (`MAX_CONCURRENCY`, mặc định 2) chống OOM trên VM 1GB; job dư xếp hàng.
- **Image**: multi-stage, `node:22-alpine` (node ≥22 làm JS runtime cho EJS challenge solver của yt-dlp), ffmpeg static musl 2.7MB, cuối cùng ~380MB.

## API

### POST /resolve

Body: `{"videoId": "..."}` hoặc `{"url": "https://music.youtube.com/watch?v=..."}` (nhận youtube.com / music.youtube.com / youtu.be / id trần 11 ký tự).

```json
{
  "videoId": "RKvRLLQtDbg",
  "title": "Lạc Trôi",
  "artist": "Sơn Tùng M-TP",
  "thumbnail": "https://i.ytimg.com/vi/.../hqdefault.jpg",
  "durationMs": 232888,
  "s3Url": "https://.../songs/RKvRLLQtDbg/<hash>.mp3"
}
```

### GET /api/v1/audio-url

Cùng ý nghĩa, tham số qua query: `?videoId=...` hoặc `?url=...`.

### SSE mode (?sse=1)

Thêm `?sse=1` vào **cả hai** endpoint để nhận tiến trình dạng [Server-Sent Events](https://developer.mozilla.org/docs/Web/API/Server-sent_events); không có flag thì trả JSON bình thường:

```
event: step
data: {"step":"s3-check"}      # có 3-check trước khi tải
event: step
data: {"step":"downloading"}
event: step
data: {"step":"encoding"}
event: step
data: {"step":"uploading"}

event: done
data: {"videoId":"...","s3Url":"...","title":"..."}
```

- Cache hit (Redis/Mongo) → không có step nào, thẳng `event: done`.
- Lỗi → `event: error` với `{"error": "..."}`.
- Ping `: ping` mỗi 15s giữ connection qua proxy.
- Client RN: đọc bằng `EventSource` hoặc `fetch` + stream reader (POST cần fetch+reader).

Lỗi HTTP: 400 sai body/videoId, 401 sai `x-api-key`, 413 video > 15 phút, 415 không có audio, 502 lỗi yt-dlp/ffmpeg/S3.

## Chạy

```bash
cp .env.example .env   # điền giá trị rồi:
docker compose up --build -d   # production: docker compose pull && up -d
```

Compose gồm: `api` (port 3001), `bgutil` (PO token provider), `redis`. MongoDB dùng service ngoài (đặt `MONGO_URL`). Giới hạn tài nguyên trong compose giả lập Oracle E2.1.Micro (1 OCPU/1GB) — đã chịu được 30 user; cold resolve cần `MAX_CONCURRENCY` để không OOM.

## Biến env (.env)

| Biến | Bắt buộc | Ghi chú |
|---|---|---|
| SERVICE_API_KEY | ✅ | header `x-api-key`, bỏ trống = không check auth |
| S3_BUCKET | ✅ | bucket chứa MP3 |
| S3_REGION | ✅ | VD `ap-southeast-1`; với MinIO/R2 để `auto` |
| S3_ACCESS_KEY_ID / S3_SECRET_ACCESS_KEY | ✅ | credentials S3 |
| S3_ENDPOINT | | MinIO/R2: `http://<host>:9000`; trỏ **private IP** nếu S3 cùng VCN (traffic nội bộ ~480Mbps, không tốn băng thông) |
| S3_PUBLIC_BASE | | base URL public trả cho client, **phải có prefix bucket**: `https://s3.example.com/locket-music` |
| MONGO_URL | | VD `mongodb://mongo:27017/yt-metadata` |
| REDIS_URL | | mặc định `redis://redis:6379`, TTL 1 ngày (`REDIS_TTL_S`) |
| YT_COOKIES | | chuỗi cookie `k=v; k2=v2` (lấy từ tab ẩn danh vào `youtube.com/robots.txt` — xem wiki Exporting YouTube cookies); chống bot-check khi IP bị flag |
| MAX_DURATION_S | | mặc định 900 (15 phút), quá → 413 |
| MAX_CONCURRENCY | | mặc định 2 — số yt-dlp/ffmpeg chạy đồng thời |
| PORT | | mặc định 3001 |

## Deploy (GitHub Actions)

Workflow build/push `ghcr.io/khanh29204/yt-metadata-service:latest` (linux/amd64) rồi SSH chạy `pull.sh` trên server. **`package-lock.json` và `ffmpeg-alpine-musl-static.zip` phải được commit** (build cần). Trên VM cần `.env` đầy đủ (nhớ `S3_ENDPOINT` private IP + `S3_PUBLIC_BASE` có prefix bucket) và swap bật sẵn.

## Lưu ý

- yt-dlp + plugin bgutil nằm trong image; YouTube chặn bản cũ → nâng định kỳ: `docker compose exec api pip3 install --break-system-packages -U "yt-dlp[default]" bgutil-ytdlp-pot-provider && docker compose restart api`.
- Bot-check: ưu tiên PO token (bgutil); nếu vẫn dính "Sign in to confirm you're not a bot" thì dùng `YT_COOKIES` (cookie phiên ẩn danh, không dùng cookie tài khoản chính). Cookie lấy ở IP khác IP server sẽ báo "The page needs to be reloaded".
- Log timing trong cold path (`yt-dlp Xms, encode Yms`, `s3 put Zms`) để đo nút cổ chân.
