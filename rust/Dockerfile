# Build context = repo root:
#   docker build -f rust/Dockerfile -t yt-metadata-service:rust .
#
# --- build: binary Rust static (musl), cache deps bằng main.rs giả ---
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /app
COPY rust/Cargo.toml rust/Cargo.lock ./
RUN mkdir src && echo "fn main() {}" > src/main.rs \
    && cargo build --release && rm src/main.rs
COPY rust/src ./src
RUN touch src/main.rs && cargo build --release

# --- runtime: yt-dlp qua pip, bun (runtime JS cho EJS solver của yt-dlp —
#     có build musl chính thức, nên image vẫn là alpine) ---
FROM alpine:3.20
ARG BUN_VERSION=bun-v1.4.2
RUN apk add --no-cache python3 py3-pip wget ca-certificates unzip \
    && pip3 install --break-system-packages --no-cache-dir \
       "yt-dlp[default]" bgutil-ytdlp-pot-provider \
    && pip3 uninstall -y --break-system-packages pip wheel setuptools \
    && apk del py3-pip \
    && rm -rf /root/.cache \
    && wget -qO /tmp/bun.zip \
       "https://github.com/oven-sh/bun/releases/download/${BUN_VERSION}/bun-linux-x64-musl.zip" \
    && unzip -o /tmp/bun.zip -d /tmp/bun \
    && mv /tmp/bun/bun-linux-x64-musl/bun /usr/local/bin/bun \
    && chmod +x /usr/local/bin/bun \
    && bun --version \
    && rm -rf /tmp/bun /tmp/bun.zip
COPY ffmpeg /usr/local/bin/ffmpeg
RUN chmod +x /usr/local/bin/ffmpeg && ffmpeg -version | head -1

COPY --from=build /app/target/release/yt-metadata-service /usr/local/bin/yt-metadata-service

# chạy non-root; cache yt-dlp ghi vào /tmp (writable)
ENV PORT=3001 YT_JS_RUNTIME=bun XDG_CACHE_HOME=/tmp/.cache
RUN mkdir -p /tmp/.cache && chmod 777 /tmp/.cache
USER nobody

EXPOSE 3001
CMD ["yt-metadata-service"]
