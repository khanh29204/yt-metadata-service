/**
 * Orchestration: resolve videoId -> metadata + MP3 trên S3.
 * Thứ tự lookup: Redis (cache 1 ngày) → MongoDB → S3 (HEAD) → tải mới.
 * Ghi: tải xong thì lưu Mongo (bền) + Redis (nóng).
 */
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Injectable } from "./di.js";
import { HttpError } from "./errors.js";
import { ConfigService } from "./config.js";
import { YtDlpService } from "./ytdlp.js";
import { EncoderService } from "./encoder.js";
import { StorageService } from "./storage.js";
import { MongoService, type SongDoc } from "./db.js";
import { CacheService } from "./cache.js";

export interface Meta {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string;
  durationMs: number;
  s3Key: string;
  s3Url: string;
}

@Injectable()
export class ResolverService {
  // Giới hạn số yt-dlp/ffmpeg chạy đồng thời (mỗi job ăn ~150-250MB; 30 job
  // song song = OOM kill trên VM 1GB — đã test). Job dư xếp hàng chờ.
  // ponytail: semaphore in-process FIFO, đủ cho 1 instance; cần nhiều hơn thì scale ngang.
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    private readonly youtube: YtDlpService,
    private readonly encoder: EncoderService,
    private readonly storage: StorageService,
    private readonly mongo: MongoService,
    private readonly cache: CacheService,
    private readonly config: ConfigService,
  ) {}

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.config.maxConcurrency)
      await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  private s3KeyFor(videoId: string): string {
    // ponytail: hash = sha1(videoId) — key cố định nên HEAD được làm cache;
    // nếu sau này muốn re-encode khi đổi ffmpeg args thì đưa args vào hash.
    const hash = createHash("sha1").update(videoId).digest("hex").slice(0, 12);
    return `songs/${videoId}/${hash}.mp3`;
  }

  private toSong(
    videoId: string,
    info: {
      title?: string;
      uploader?: string;
      channel?: string;
      duration?: number;
      thumbnail?: string;
    },
    s3Key: string,
  ): SongDoc {
    return {
      videoId,
      title: info.title ?? "",
      artist: info.uploader ?? info.channel ?? "",
      thumbnail:
        info.thumbnail ?? `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
      durationMs: Math.round((info.duration ?? 0) * 1000),
      s3Key,
      s3Url: this.storage.url(s3Key),
      createdAt: new Date(),
    };
  }

  async resolve(
    videoId: string,
    onStep?: (step: string, pct?: number) => void,
  ): Promise<Meta> {
    const step = onStep ?? (() => {});
    const s3Key = this.s3KeyFor(videoId);

    // 1. Redis cache nóng
    const cached = await this.cache.getSong(videoId);
    if (cached) return cached;

    // 2. MongoDB (bền)
    const stored = await this.mongo.get(videoId);
    if (stored) {
      void this.cache.setSong(videoId, stored);
      return stored;
    }

    // 3. MP3 đã có trên S3 nhưng chưa có record? (VD DB mới setup, S3 cũ)
    step("check");
    if (await this.storage.has(s3Key)) {
      console.log(`cache hit: ${s3Key}`);
      const song = this.toSong(
        videoId,
        await this.youtube.info(videoId),
        s3Key,
      );
      await this.mongo.save(song);
      void this.cache.setSong(videoId, song);
      return song;
    }

    // 4. Tải + encode + upload — MỘT lần chạy yt-dlp (info + download gộp)
    const dir = await mkdtemp(`${tmpdir()}/yt-`);
    let info;
    let source;
    try {
      await this.limited(async () => {
        const t0 = Date.now();
        step("downloading");
        ({ source, info } = await this.youtube.downloadAudio(videoId, dir));
        const tDlp = Date.now() - t0;
        const durationS = info.duration ?? 0;
        if (
          !durationS ||
          !info.formats?.some((f) => f.acodec && f.acodec !== "none")
        )
          throw new HttpError(415, "no audio stream available");
        if (durationS > this.config.maxDurationS)
          throw new HttpError(
            413,
            `video too long: ${Math.round(durationS)}s (max ${this.config.maxDurationS}s)`,
          );
        step("encoding");
        const mp3 = await this.encoder.toMp3(source, dir, (pct) =>
          step("encoding", pct),
        );
        console.log(`yt-dlp ${tDlp}ms, encode ${Date.now() - t0 - tDlp}ms`);
        step("uploading");
        const t2 = Date.now();
        await this.storage.put(s3Key, mp3);
        console.log(`s3 put ${((Date.now() - t2) / 1000) | 0}s`);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }

    const song = this.toSong(videoId, info!, s3Key);
    await this.mongo.save(song);
    void this.cache.setSong(videoId, song);
    return song;
  }
}
