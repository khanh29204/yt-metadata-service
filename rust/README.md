# yt-metadata-service (Rust + axum)

Port của service Node.js sang binary Rust thuần — axum xử lý toàn bộ request.
Runtime JS duy nhất trong image là **Bun** (yt-dlp dùng cho EJS challenge solver,
có build musl chính thức nên image vẫn là alpine; đổi được qua env
`YT_JS_RUNTIME=quickjs|deno|bun|node` — lưu ý deno không chạy trên alpine vì
không có build musl). API không đổi — xem `docs/API.md`.

## Cấu trúc

```
rust/
├── Cargo.toml
└── src/
    ├── main.rs         # axum: route, auth x-api-key, SSE (?sse=1), ping 15s
    ├── config.rs       # env — giống src/config.ts
    ├── resolver.rs     # orchestration — port của src/resolver.ts (lookup + shaping)
    └── services.rs     # Redis/MongoDB/S3(object_store)/yt-dlp/ffmpeg — có unit test
```

## Chạy

```bash
cd rust
cargo run --release        # cần yt-dlp, ffmpeg, qjs trên PATH; env giống bản Node
```

Binary release ~11MB. Env var giữ nguyên (`PORT`, `SERVICE_API_KEY`, `MONGO_URL`,
`REDIS_URL`, `S3_*`, `BGUTIL_URL`, `YT_COOKIES`, `MAX_CONCURRENCY`, `MAX_DURATION_S`,
`REDIS_TTL_S`, `YT_JS_RUNTIME`).

## Test

```bash
cargo test
```
