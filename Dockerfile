# --- deps: cài node_modules từ lockfile ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- build: compile TS -> JS, runtime không cần typescript/tsx ---
FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN ./node_modules/.bin/tsc --noEmit false --outDir dist

# --- runtime: chỉ node_modules prod + dist; yt-dlp/plugin qua pip, ffmpeg static 2.7MB ---
FROM node:20-alpine AS runtime
RUN apk add --no-cache python3 py3-pip \
    && pip3 install --break-system-packages --no-cache-dir \
       yt-dlp bgutil-ytdlp-pot-provider \
    && pip3 uninstall -y --break-system-packages pip wheel setuptools \
    && apk del py3-pip \
    && rm -rf /root/.cache
# ffmpeg static build (thay apk ffmpeg ~250MB libs) — verify: ffmpeg -encoders | grep mp3
COPY ffmpeg /usr/local/bin
RUN chmod +x /usr/local/bin/ffmpeg \
    && ffmpeg -version | head -1

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

# chạy non-root; cache yt-dlp ghi vào /tmp (writable)
ENV NODE_ENV=production PORT=3001 XDG_CACHE_HOME=/tmp/.cache
RUN mkdir -p /tmp/.cache && chown -R node:node /tmp/.cache
USER node

EXPOSE 3001
CMD ["node", "dist/server.js"]
