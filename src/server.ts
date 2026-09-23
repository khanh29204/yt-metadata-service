/**
 * yt-metadata-service — bootstrap (giống main.ts của Nest).
 *
 * POST /resolve { videoId | url }
 * -> { videoId, title, artist, thumbnail, durationMs, s3Url }
 *
 * Dependency graph (container tự inject theo constructor):
 *   ConfigService → YtDlpService, EncoderService, StorageService
 *                 → ResolverService → ResolveController → routes
 */
import "reflect-metadata";
import express from "express";
import { container } from "./di.js";
import { ConfigService } from "./config.js";
import { MongoService } from "./db.js";
import { CacheService } from "./cache.js";
import { createRouter } from "./routes.js";

const config = container.resolve(ConfigService);

async function main() {
  // kết nối Mongo + Redis trước khi nhận request
  await container.resolve(MongoService).connect();
  await container.resolve(CacheService).connect();

  const app = express();
  app.use(createRouter());

  app.listen(config.port, () => console.log(`yt-metadata-service on :${config.port}`));
}

void main();
