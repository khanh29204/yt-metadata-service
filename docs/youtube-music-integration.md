# yt-metadata-service — Tài liệu tích hợp

Tài liệu cho mọi app/service muốn dùng tính năng: **gửi link/id YouTube → nhận URL MP3 ổn định trên S3 + metadata + waveform** để phát nhạc, chọn đoạn (trim) làm nhạc nền.

Phần nặng (tải video bằng yt-dlp, convert MP3 bằng ffmpeg, upload S3, cache) nằm hoàn toàn ở service — client chỉ gọi 1 API GET.

---

## 1. Luồng xử lý tổng thể

```
Client                       yt-metadata-service                          S3 / Cache
  │ GET /api/v1/audio-url          │
  │ ──────────────────────────────►│ 1. Parse videoId từ url hoặc id
  │                                │ 2. Check cache: Redis (TTL 1 ngày)
  │                                │    → MongoDB → S3 HEAD
  │                                │    ✦ cache hit: trả ngay kết quả
  │                                │ 3. Cache miss: yt-dlp tải stream audio
  │  (?sse=1: stream step/pct)     │ 4. ffmpeg convert MP3 64kbps CBR
  │                                │ 5. PUT lên S3  ────────────────────►
  │                                │ 6. Lưu cache (Redis/Mongo)
  │ ◄───── 200 {s3Url, metadata} ──│
  │ phát s3Url bằng player bất kỳ  │
```

Điểm mấu chốt:

- **Idempotent**: S3 key là `songs/<videoId>/<sha1(videoId)[0..12]>.mp3`, chỉ phụ thuộc videoId, nên **URL ổn định vĩnh viễn**, có thể cache ở client không giới hạn. MP3 đã tồn tại trên S3 thì trả ngay, không tải lại.
- **MP3 64kbps CBR không ID3 metadata**: duration thực ≈ `filesize / 8000` (byte/giây). Đây là yêu cầu cứng của service.
- Client **không cần cắt file thật**: MP3 là nguyên bài. Trim = lưu `startMs/endMs` và seek khi playback.

## 2. Auth & cấu hình

| Mục | Giá trị |
|---|---|
| Base URL | `https://lockut.quockhanh020924.id.vn` |
| Auth | header `x-api-key: <SERVICE_API_KEY>` trên mọi request (key do chủ service cấp) |

## 3. API Reference

### 3.1 `GET /api/v1/audio-url`

Tham số qua query, một trong hai:

```
GET https://lockut.quockhanh020924.id.vn/api/v1/audio-url?videoId=RKvRLLQtDbg
GET https://lockut.quockhanh020924.id.vn/api/v1/audio-url?url=https%3A%2F%2Fyoutu.be%2FRKvRLLQtDbg
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
  "s3Url": "https://s3.example.com/locket-music/songs/RKvRLLQtDbg/01d0fe8baeac.mp3",
  "waveform": [0.02, 0.11, 0.47]
}
```

| Field | Kiểu | Ghi chú |
|---|---|---|
| `videoId` | string | id 11 ký tự đã chuẩn hóa |
| `title` | string | tiêu đề video |
| `artist` | string | uploader/channel YouTube |
| `thumbnail` | string | ảnh đại diện |
| `durationMs` | number | thời lượng millisecond (từ metadata; duration thực ≈ filesize/8000 vì 64kbps CBR) |
| `s3Url` | string | MP3 64kbps CBR, không ID3 metadata, tải trực tiếp được, ổn định vĩnh viễn. Header `content-disposition: inline` nên browser mở thẳng player thay vì download |
| `waveform` | number[]? | 200 peak 0..1 (mỗi bucket ~ `durationMs/200` ms) để vẽ sóng âm. `undefined` với bài resolve trước khi có field này, gọi lại endpoint, service tự backfill |

**Lỗi**

| Status | Khi nào |
|---|---|
| 400 | thiếu/sai query, không parse được videoId |
| 401 | sai hoặc thiếu `x-api-key` |
| 413 | video dài hơn 15 phút |
| 415 | video không có stream audio |
| 500 | cấu hình server thiếu hoặc lỗi nội bộ |
| 502 | yt-dlp / ffmpeg / S3 PUT lỗi (500 ký tự cuối của stderr đính kèm trong message) |

### 3.2 Chế độ SSE (`?sse=1`)

Thêm `?sse=1` để nhận stream tiến trình thay vì chờ mù (cold resolve mất ~10–30s). GET + SSE dùng được `EventSource` sẵn có trên cả web lẫn RN:

```js
const es = new EventSource(
  `https://lockut.quockhanh020924.id.vn/api/v1/audio-url?sse=1&videoId=${videoId}`,
);
```

**Lưu ý EventSource không gửi được header `x-api-key`.** Hai cách:

* Nếu service cho phép (đang cấu hình như vậy): truyền key qua query `&apiKey=<key>`.
* Nếu cần header: dùng fetch + stream reader, mẫu ở mục 5.

Response là `text/event-stream`; **status HTTP luôn 200**, lỗi thực nằm trong event `error`.

```
event: step
data: {"step":"s3-check"}

event: step
data: {"step":"downloading","pct":12}

event: step
data: {"step":"encoding","pct":42}

event: step
data: {"step":"uploading"}

event: done
data: {"videoId":"...","title":"...","s3Url":"..."}
```

| Event | Ý nghĩa |
|---|---|
| `step` | `s3-check` → `downloading` → `encoding` → `uploading`. Với bản ghi cũ chưa có waveform có thể nhận `backfilling` thay các bước tải mới. `pct` (0-100, tùy chọn): từ yt-dlp ở `downloading`, từ ffmpeg ở `encoding`/`backfilling` |
| `done` | hoàn tất, `data` = payload JSON giống response thường |
| `error` | thất bại, `data` = `{"error": "..."}` |

* **Cache hit**: không có event `step`, nhận `done` gần như tức thì.
* Connection được giữ bởi comment ping `: ping` mỗi 15s.
* Backfill waveform lỗi thì request vẫn trả bài hát như cũ, không có event `error`.

## 4. Tích hợp ReactJS (web)

```jsx
// api/music.ts
const BASE = 'https://lockut.quockhanh020924.id.vn';
const KEY = '<SERVICE_API_KEY>';

const headers = { 'x-api-key': KEY };

export async function resolveSong(videoId) {
  // cache vô thời hạn theo videoId: URL ổn định vĩnh viễn
  const cached = localStorage.getItem(`song:${videoId}`);
  if (cached) return JSON.parse(cached);

  const res = await fetch(`${BASE}/api/v1/audio-url?videoId=${videoId}`, { headers });
  if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
  const data = await res.json();
  localStorage.setItem(`song:${videoId}`, JSON.stringify(data));
  return data;
}

// Player: <audio> hoặc thư viện (howler.js...)
export function MusicPlayer({ song, startMs, endMs }) {
  const ref = useRef(null);
  // trim = seek khi playback, không cắt file
  const onTimeUpdate = () => {
    if (endMs && ref.current.currentTime * 1000 >= endMs) {
      ref.current.currentTime = (startMs ?? 0) / 1000; // loop lại khung
    }
  };
  return <audio ref={ref} src={song.s3Url} onTimeUpdate={onTimeUpdate} controls />;
}
```

### Web SSE với EventSource

```js
function resolveSse(videoId, onStep) { // onStep(step, pct?)
  return new Promise((resolve, reject) => {
    const es = new EventSource(
      `${BASE}/api/v1/audio-url?sse=1&videoId=${videoId}&apiKey=${KEY}`,
    );
    es.addEventListener('step', (e) => {
      const d = JSON.parse(e.data);
      onStep?.(d.step, d.pct);
    });
    es.addEventListener('done', (e) => { es.close(); resolve(JSON.parse(e.data)); });
    es.addEventListener('error', (e) => {
      es.close();
      // EventSource error event cũng bắn khi mất kết nối mạng,
      // phân biệt bằng data JSON có field "error"
      if (e.data) reject(new Error(JSON.parse(e.data).error));
      else reject(new Error('network'));
    });
  });
}
```

UI vẽ waveform trên web: dùng `waveform` (200 peak) render canvas/SVG, hoặc thư viện `wavesurfer.js` (có thể truyền mảng peak có sẵn thay vì decode lại).

## 5. Tích hợp React Native

```js
// api/music.ts
export async function resolveSong(videoId) {
  const cached = await AsyncStorage.getItem(`song:${videoId}`);
  if (cached) return JSON.parse(cached);

  const res = await fetch(`${BASE}/api/v1/audio-url?videoId=${videoId}`, { headers });
  if (!res.ok) throw new Error(`resolve failed: ${res.status}`);
  const data = await res.json();
  await AsyncStorage.setItem(`song:${videoId}`, JSON.stringify(data));
  return data;
}
```

* **Phát nhạc**: dùng player có sẵn trong dự án (`react-native-video`, `expo-av`, `react-native-track-player`). Đưa thẳng `s3Url` vào source.
* **Trim loop**: player seek tới `startMs / 1000`, lắng nghe vị trí playing, tới `endMs / 1000` thì seek về `startMs`.

### RN SSE

RN chưa hỗ trợ streaming body của fetch. Hai lựa chọn:

* **`EventSource` polyfill** (khuyến nghị, GET nên dùng được): `react-native-sse` hoặc `event-source-polyfill`. API giống mẫu web ở mục 4.
* **XMLHttpRequest + onprogress**, không cần thư viện thêm:

```js
function resolveSseRN(videoId, onStep) { // onStep(step, pct?)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let buf = '', event = null;
    xhr.open('GET', `${BASE}/api/v1/audio-url?sse=1&videoId=${videoId}&apiKey=${KEY}`);
    xhr.onprogress = () => {
      const chunk = xhr.responseText.slice(buf.length);
      buf = xhr.responseText;
      let idx;
      while ((idx = chunk.indexOf('\n\n')) !== -1) {
        // parse từng block "event: ...\ndata: {...}"
        for (const line of chunk.slice(0, idx).split('\n')) {
          if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ') && event) {
            const data = JSON.parse(line.slice(6));
            if (event === 'step') onStep?.(data.step, data.pct);
            else if (event === 'done') { resolve(data); xhr.abort(); return; }
            else if (event === 'error') { reject(new Error(data.error)); return; }
          }
        }
      }
    };
    xhr.onerror = () => reject(new Error('network'));
    xhr.send();
  });
}
```

Lưu ý RN: nếu dùng `onprogress` với XHR GET thì một số version cần header `Accept: text/event-stream` và URL cần thêm tham số ngẫu nhiên (`&_=${Date.now()}`) để tránh cache của hệ điều hành.

## 6. Trim đoạn nhạc ≤30s (nhạc nền moment/clip)

MP3 trả về là **nguyên bài**, trim là chuyện client-side, làm giống nhau trên web lẫn RN:

1. **Vẽ waveform** từ `waveform` (200 peak). Thiếu field thì gọi lại endpoint để service backfill, hoặc fallback sóng giả.
2. **UI chọn khung** `startMs/endMs` trên waveform (Locket giới hạn 5s-30s; service không ràng buộc).
3. **Preview**: phát trong phạm vi khung, tới `endMs` thì seek về `startMs` (loop).
4. **Lưu** `{ s3Url, startMs, endMs }` vào data của bạn. Khi phát thật: seek tới `startMs`, dừng/chuyển tiếp khi tới `endMs`.

## 7. Quy tắc bắt buộc & giới hạn

| Quy tắc | Lý do |
|---|---|
| **Cache `s3Url` + metadata vô thời hạn theo videoId** | URL ổn định vĩnh viễn; resolve chỉ dành cho lần đầu user chọn bài |
| Không bắn loạt resolve song song hàng trăm bài | service giới hạn `MAX_CONCURRENCY` (mặc định 2) job tải đồng thời, dư xếp hàng. Mỗi job yt-dlp/ffmpeg tốn ~150-250MB RAM |
| Validate thời lượng trước khi cho user chọn (nếu biết trước) | > 15 phút → `413`, không có audio → `415` |
| Với SSE luôn xử lý event `error` | HTTP luôn 200, không đọc status được |

Vận hành phía service (để bạn biết, không cần làm gì): cache layer Redis (TTL 1 ngày) → MongoDB → S3 HEAD → tải mới; Redis chết không làm fail request.

## 8. Checklist tích hợp

* [ ] Có `x-api-key`
* [ ] Gọi `GET /api/v1/audio-url`, hiện SSE progress cho cold resolve
* [ ] Phát `s3Url` bằng player có sẵn (web: `<audio>`/howler; RN: react-native-video/expo-av)
* [ ] Cache `{videoId → s3Url, title, artist, thumbnail, waveform}` phía app (web: localStorage; RN: AsyncStorage)
* [ ] (Tùy chọn) trim UI, cắt bằng seek khi playback
* [ ] Xử lý 413/415/502 + SSE `error`
