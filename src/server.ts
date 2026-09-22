/**
 * yt-metadata-service — resolve YouTube link -> metadata + MP3 64k CBR trên S3.
 *
 * POST /resolve { videoId | url }
 * -> { videoId, title, artist, thumbnail, durationMs, s3Url }
 *
 * yt-dlp (PO token qua bgutil provider) tải audio -> ffmpeg encode MP3
 * 64kbps CBR (app tính duration = filesize/8000, bắt buộc đúng bitrate,
 * không metadata) -> upload S3. Cache: HEAD S3 + metadata in-memory 1 ngày.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import express from "express";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const execFileP = promisify(execFile);

const PORT = Number(process.env.PORT || 3001);
const API_KEY = process.env.SERVICE_API_KEY ?? "";
const MAX_DURATION_S = Number(process.env.MAX_DURATION_S || 900); // 15 phút
const YTDLP_TIMEOUT_MS = 5 * 60_000;
const BGUTIL_URL = process.env.BGUTIL_URL || "http://bgutil:4416";

const s3 = new S3Client({
  region: process.env.S3_REGION || "us-east-1",
  // S3-compatible (R2, MinIO...): set S3_ENDPOINT, ví dụ https://<account>.r2.cloudflarestorage.com
  ...(process.env.S3_ENDPOINT
    ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true }
    : {}),
  credentials: {
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
  },
});
const BUCKET = process.env.S3_BUCKET ?? "";
// URL công khai của MP3: nếu set S3_PUBLIC_BASE dùng nó, else URL chuẩn S3.
const PUBLIC_BASE = process.env.S3_PUBLIC_BASE ?? "";

interface Meta {
  title: string;
  artist: string;
  thumbnail: string;
  durationMs: number;
  s3Key: string;
  cachedAt: number;
}
// ponytail: metadata cache in-memory 1 ngày, mất khi restart (cache S3 vẫn sống)
const metaCache = new Map<string, Meta>();
const DAY = 24 * 3600_000;

const s3Url = (key: string) =>
  PUBLIC_BASE
    ? `${PUBLIC_BASE.replace(/\/$/, "")}/${key}`
    : `https://${BUCKET}.s3.${process.env.S3_REGION || "us-east-1"}.amazonaws.com/${key}`;

/** Chuẩn hóa videoId từ url youtube.com / music.youtube.com / youtu.be, hoặc id trần. */
function extractVideoId(input: string): string | null {
  const m =
    input.match(/[?&]v=([\w-]{11})/) ||
    input.match(/youtu\.be\/([\w-]{11})/) ||
    input.match(/\/(?:embed|shorts|v)\/([\w-]{11})/);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(input.trim()) ? input.trim() : null;
}

async function run(cmd: string, args: string[]) {
  try {
    const { stdout } = await execFileP(cmd, args, {
      timeout: YTDLP_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (e: unknown) {
    const err = e as { stderr?: string; killed?: boolean; message: string };
    throw new HttpError(
      502,
      err.killed
        ? `${cmd} timeout ${YTDLP_TIMEOUT_MS / 1000}s`
        : `${cmd} failed: ${(err.stderr || err.message).slice(-500)}`,
    );
  }
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** yt-dlp -J: metadata + duration (PO token qua bgutil provider plugin). */
async function ytdlpInfo(url: string) {
  const out = await run("yt-dlp", [
    "-J", "--no-playlist", "--no-warnings",
    "--extractor-args", `youtubepot-bgutilhttp:base_url=${BGUTIL_URL}`,
    url,
  ]);
  return JSON.parse(out);
}

/** Tải audio-only tốt nhất rồi ffmpeg encode MP3 64k CBR không metadata. */
async function downloadAndEncode(videoId: string, dir: string): Promise<string> {
  await run("yt-dlp", [
    "-f", "ba/b", "--no-playlist", "--no-warnings",
    "--extractor-args", `youtubepot-bgutilhttp:base_url=${BGUTIL_URL}`,
    "-o", path.join(dir, "source"),
    `https://www.youtube.com/watch?v=${videoId}`,
  ]);
  const mp3 = path.join(dir, "out.mp3");
  await run("ffmpeg", [
    "-i", path.join(dir, "source"),
    "-vn", "-c:a", "libmp3lame", "-b:a", "64k", "-ar", "44100",
    "-write_id3v1", "0", "-id3v2_version", "0", "-reservoir", "0",
    mp3,
  ]);
  return mp3;
}

// Giới hạn số yt-dlp/ffmpeg chạy đồng thời (mỗi job ăn ~150-250MB; 30 job
// song song = OOM kill trên VM 1GB). Job dư xếp hàng chờ.
// ponytail: semaphore in-process FIFO, đủ cho 1 instance; cần nhiều hơn thì scale ngang.
const MAX_CONCURRENCY = Number(process.env.MAX_CONCURRENCY || 2);
let active = 0;
const waiters: (() => void)[] = [];
async function acquire() {
  if (active >= MAX_CONCURRENCY) await new Promise<void>((r) => waiters.push(r));
  active++;
}
function release() {
  active--;
  waiters.shift()?.();
}

/** Chạy fn trong semaphore; nằm ngoài try/finally vì acquire có thể chờ. */
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

async function resolve(videoId: string): Promise<Meta> {
  const hit = metaCache.get(videoId);
  if (hit && Date.now() - hit.cachedAt < DAY) return hit;

  // ponytail: hash = sha1(videoId) — key cố định nên HEAD được làm cache;
  // nếu sau này muốn re-encode khi đổi ffmpeg args thì đưa args vào hash.
  const hash = createHash("sha1").update(videoId).digest("hex").slice(0, 12);
  const key = `songs/${videoId}/${hash}.mp3`;

  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    console.log(`cache hit: ${key}`);
    const info = await limited(() => ytdlpInfo(`https://www.youtube.com/watch?v=${videoId}`));
    const meta: Meta = {
      title: info.title ?? "",
      artist: info.uploader ?? info.channel ?? "",
      thumbnail: info.thumbnail ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      durationMs: Math.round((info.duration ?? 0) * 1000),
      s3Key: key,
      cachedAt: Date.now(),
    };
    metaCache.set(videoId, meta);
    return meta;
  } catch {
    // mọi lỗi HEAD (kể cả key chưa có) = cache miss; S3/creds sai sẽ báo ở bước upload
  }

  const dir = await mkdtemp(path.join(tmpdir(), "yt-"));
  let info!: { title?: string; uploader?: string; channel?: string; duration?: number; thumbnail?: string; formats?: { acodec?: string }[] };
  try {
    await limited(async () => {
      info = await ytdlpInfo(`https://www.youtube.com/watch?v=${videoId}`);
      const durationS = info.duration ?? 0;
      if (!durationS || !info.formats?.some((f: { acodec?: string }) => f.acodec && f.acodec !== "none"))
        throw new HttpError(415, "no audio stream available");
      if (durationS > MAX_DURATION_S)
        throw new HttpError(413, `video too long: ${Math.round(durationS)}s (max ${MAX_DURATION_S}s)`);
      const mp3 = await downloadAndEncode(videoId, dir);
      await s3.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: createReadStream(mp3), ContentType: "audio/mpeg" }),
      );
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const meta: Meta = {
    title: info.title ?? "",
    artist: info.uploader ?? info.channel ?? "",
    thumbnail: info.thumbnail ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationMs: Math.round((info.duration ?? 0) * 1000),
    s3Key: key,
    cachedAt: Date.now(),
  };
  metaCache.set(videoId, meta);
  return meta;
}

const app = express();
app.use(express.json());

// app.use((req, res, next) => {
//   if (!API_KEY || req.header("x-api-key") === API_KEY) return next();
//   res.status(401).json({ error: "invalid api key" });
// });

app.post("/resolve", async (req, res) => {
  const input: unknown = req.body?.videoId ?? req.body?.url;
  if (typeof input !== "string" || !input)
    return res.status(400).json({ error: "body must be {videoId} or {url}" });

  const videoId = extractVideoId(input);
  if (!videoId) return res.status(400).json({ error: "cannot parse videoId from input" });
  if (!BUCKET) return res.status(500).json({ error: "S3_BUCKET not configured" });

  try {
    const meta = await resolve(videoId);
    res.json({
      videoId,
      title: meta.title,
      artist: meta.artist,
      thumbnail: meta.thumbnail,
      durationMs: meta.durationMs,
      s3Url: s3Url(meta.s3Key),
    });
  } catch (e: unknown) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
    console.error(e);
    res.status(500).json({ error: "internal error" });
  }
});

app.listen(PORT, () => console.log(`yt-metadata-service on :${PORT}`));
