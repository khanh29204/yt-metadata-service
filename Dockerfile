FROM node:20-slim

# yt-dlp + plugin bgutil PO token provider; ffmpeg để encode MP3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-pip ffmpeg \
    && pip3 install --break-system-packages --no-cache-dir \
       yt-dlp bgutil-ytdlp-pot-provider \
    && apt-get purge -y python3-pip && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev && npm install tsx --no-save

COPY src ./src
COPY tsconfig.json ./

ENV PORT=3001
EXPOSE 3001
CMD ["npx", "tsx", "src/server.ts"]
