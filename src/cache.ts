/** Redis: cache nóng metadata bài hát (TTL 1 ngày) — trả lời trước khi chạm Mongo. */
import { createClient, type RedisClientType } from "redis";
import { Injectable } from "./di.js";
import { ConfigService } from "./config.js";
import type { SongDoc } from "./db.js";

@Injectable()
export class CacheService {
  private readonly redis: RedisClientType;
  private readonly ttlS: number;

  constructor(config: ConfigService) {
    this.ttlS = config.redisTtlS;
    this.redis = createClient({ url: config.redisUrl }) as RedisClientType;
    this.redis.on("error", (e: Error) => console.error("redis:", e.message));
  }

  async connect(): Promise<void> {
    await this.redis.connect();
    console.log("redis connected");
  }

  async getSong(videoId: string): Promise<SongDoc | null> {
    try {
      const raw = await this.redis.get(`song:${videoId}`);
      return raw ? (JSON.parse(raw) as SongDoc) : null;
    } catch {
      return null; // redis chết → fallback mongo/S3, không fail request
    }
  }

  async setSong(videoId: string, song: SongDoc): Promise<void> {
    try {
      await this.redis.set(`song:${videoId}`, JSON.stringify(song), { EX: this.ttlS });
    } catch {
      // cache fail không chặn request
    }
  }
}
