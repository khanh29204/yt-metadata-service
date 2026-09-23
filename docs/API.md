# API Reference — yt-metadata-service

Base URL: `http://<host>:3001`

Auth: header `x-api-key: <SERVICE_API_KEY>` (bỏ trống `SERVICE_API_KEY` trong `.env` = tắt auth).

---

## POST /resolve

Resolve video YouTube thành metadata + URL MP3 trên S3. Idempotent: gọi lại cùng videoId trả ngay từ cache.

**Request** — `Content-Type: application/json`, nhận một trong hai:

```json
{ "videoId": "RKvRLLQtDbg" }
```

```json
{ "url": "https://music.youtube.com/watch?v=RKvRLLQtDbg" }
```

URL chấp nhận: `youtube.com/watch?v=`, `music.youtube.com/watch?v=`, `youtu.be/`, `youtube.com/(embed|shorts|v)/`, hoặc id trần 11 ký tự `[A-Za-z0-9_-]`.

**Response 200**

```json
{
  "videoId": "RKvRLLQtDbg",
  "title": "Lạc Trôi",
  "artist": "Sơn Tùng M-TP",
  "thumbnail": "https://i.ytimg.com/vi/RKvRLLQtDbg/hqdefault.jpg",
  "durationMs": 232888,
  "s3Url": "https://s3.example.com/locket-music/songs/RKvRLLQtDbg/01d0fe8baeac.mp3"
}
```

| Field | Kiểu | Ghi chú |
|---|---|---|
| `videoId` | string | id 11 ký tự đã chuẩn hóa |
| `title` | string | tiêu đề video |
| `artist` | string | uploader/channel YouTube |
| `thumbnail` | string | ảnh đại diện, fallback `i.ytimg.com/vi/<id>/hqdefault.jpg` |
| `durationMs` | number | thời lượng millisecond (metadata, app tự tính duration thực = filesize/8000) |
| `s3Url` | string | URL MP3 64kbps CBR, không metadata, tải trực tiếp được |

**Lỗi**

| Status | Khi nào |
|---|---|
| 400 | body thiếu/sai, không parse được videoId |
| 401 | sai hoặc thiếu `x-api-key` |
| 413 | video dài hơn 15 phút (`MAX_DURATION_S`) |
| 415 | video không có stream audio |
| 500 | cấu hình thiếu (`S3_BUCKET`) hoặc lỗi nội bộ |
| 502 | yt-dlp / ffmpeg / S3 PUT lỗi (stderr đính trong message) |

**Ví dụ**

```bash
curl -X POST localhost:3001/resolve \
  -H 'x-api-key: KEY' -H 'Content-Type: application/json' \
  -d '{"videoId":"RKvRLLQtDbg"}'
```

---

## GET /api/v1/audio-url

Phiên bản GET của `/resolve`, tham số qua query (tiện cho `<Image>`/preload, không cần body).

**Request**

```
GET /api/v1/audio-url?videoId=RKvRLLQtDbg
GET /api/v1/audio-url?url=https%3A%2F%2Fyoutu.be%2FRKvRLLQtDbg
```

**Response** — giống `POST /resolve` (200 + cùng JSON, cùng bảng lỗi).

---

## SSE mode (`?sse=1`)

Thêm `?sse=1` vào **cả hai** endpoint:

```
POST /resolve?sse=1
GET  /api/v1/audio-url?sse=1&videoId=RKvRLLQtDbg
```

Response là stream `text/event-stream` báo tiến trình; không có flag thì JSON như trên. Dùng khi cold resolve mất ~10-30s và client muốn hiển thị trạng thái thay vì chờ mù.

**Event stream**

```
event: step
data: {"step":"s3-check"}

event: step
data: {"step":"downloading"}

event: step
data: {"step":"encoding"}

event: step
data: {"step":"uploading"}

event: done
data: {"videoId":"RKvRLLQtDbg","title":"Lạc Trôi","artist":"Sơn Tùng M-TP","thumbnail":"...","durationMs":232888,"s3Url":"..."}
```

| Event | Ý nghĩa |
|---|---|
| `step` | bước đang xử lý: `s3-check` → `downloading` → `encoding` → `uploading` |
| `done` | hoàn tất, `data` = payload JSON giống response thường |
| `error` | thất bại, `data` = `{"error": "..."}` |

- **Cache hit (Redis/Mongo):** không có event `step` nào, nhận `done` gần như tức thì (mili-giây).
- Connection được giữ bởi comment ping `: ping` mỗi 15s (không qua được proxy cần `Cache-Control: no-cache` — đã set).
- Status HTTP luôn 200 khi dùng SSE; lỗi thực nằm trong event `error`.

**Client React Native** (POST phải dùng fetch + reader, `EventSource` chỉ hỗ trợ GET):

```js
async function resolveSse(videoId, onStep) {
  const res = await fetch(`${BASE}/resolve?sse=1`, {
    method: "POST",
    headers: { "x-api-key": KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", event = null;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ") && event) {
          const data = JSON.parse(line.slice(6));
          if (event === "step") onStep(data.step);
          else if (event === "done") return data;      // → metadata + s3Url
          else if (event === "error") throw new Error(data.error);
        }
      }
    }
  }
}
```

GET thì đơn giản hơn với `EventSource` (nhớ tự thêm header `x-api-key` — dùng polyfill hỗ trợ header, hoặc fetch+reader như trên).

---

## Ghi chú vận hành

- **Concurrency:** tối đa `MAX_CONCURRENCY` (mặc định 2) job tải/encode đồng thời; request dư xếp hàng — SSE vẫn nhận `step` đầu sau khi vào hàng.
- **Cache layer:** Redis (TTL 1 ngày) → MongoDB → S3 HEAD → tải mới. Redis chết không làm fail request (bỏ qua cache).
- **s3Url ổn định vĩnh viễn** theo videoId (hash chỉ phụ thuộc videoId) — có thể cache URL ở client không giới hạn.
