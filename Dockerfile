# --- GIAI ĐOẠN 1: Build (Cài đặt dependencies) ---
# Lớp này chỉ cache khi pyproject.toml/uv.lock đổi — sửa app.py không phải cài lại
FROM python:3.12-alpine AS builder
WORKDIR /app

# uv: cài dependencies từ pyproject.toml (có lock thì dùng lock)
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
COPY pyproject.toml uv.lock* ./
RUN uv sync --frozen --no-install-project --no-dev

# --- GIAI ĐOẠN 2: Runtime ---
FROM python:3.12-alpine AS runner
WORKDIR /app

# apk layer đứng trước COPY để không bị vô hiệu khi sửa code
# ffmpeg cho các format cần mux; uv cho cronjob tự nâng yt-dlp 4h sáng
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv
RUN apk add --no-cache ffmpeg

COPY --from=builder /app/.venv ./.venv
COPY app.py ./

# Bảo mật: không chạy bằng root
RUN addgroup -S app && adduser -S app -G app
USER app

ENV PATH="/app/.venv/bin:$PATH"

EXPOSE 3001

CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "3001"]
