/** Đọc env 1 lần lúc start — inject ConfigService vào các service khác. */
import { Injectable } from "./di.js";

@Injectable()
export class ConfigService {
  readonly port = Number(process.env.PORT || 3001);
  readonly apiKey = process.env.SERVICE_API_KEY ?? "";
  readonly maxDurationS = Number(process.env.MAX_DURATION_S || 900); // 15 phút
  readonly maxConcurrency = Number(process.env.MAX_CONCURRENCY || 2);
  readonly timeoutMs = 5 * 60_000; // tải/encode 5 phút
  readonly bgutilUrl = process.env.BGUTIL_URL || "http://bgutil:4416";
  readonly ytCookies = process.env.YT_COOKIES ?? "";
  readonly mongoUrl = process.env.MONGO_URL || "mongodb://mongo:27017/yt-metadata";
  readonly redisUrl = process.env.REDIS_URL || "redis://redis:6379";
  readonly redisTtlS = Number(process.env.REDIS_TTL_S || 86400); // cache metadata 1 ngày
  readonly s3 = {
    bucket: process.env.S3_BUCKET ?? "",
    region: process.env.S3_REGION || "us-east-1",
    accessKeyId: process.env.S3_ACCESS_KEY_ID ?? "",
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? "",
    // S3-compatible (R2, MinIO...): set S3_ENDPOINT; bỏ trống nếu dùng AWS S3
    endpoint: process.env.S3_ENDPOINT ?? "",
    // base URL công khai của MP3 (VD CloudFront / MinIO domain có bucket prefix)
    publicBase: process.env.S3_PUBLIC_BASE ?? "",
  };
}
