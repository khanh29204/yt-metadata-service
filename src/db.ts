/**
 * MongoDB (mongoose): lưu bền metadata bài hát.
 * Collection `songs` — _id = videoId. Không lưu stream link (file MP3 đã nằm trên S3).
 */
import mongoose, { Schema } from "mongoose";
import { Injectable } from "./di.js";
import { ConfigService } from "./config.js";

export interface SongDoc {
  videoId: string;
  title: string;
  artist: string;
  thumbnail: string;
  durationMs: number;
  s3Key: string;
  s3Url: string;
  createdAt: Date;
}

const songSchema = new Schema<SongDoc>({
  videoId: { type: String, required: true, unique: true }, // key tra cứu
  title: String,
  artist: String,
  thumbnail: String,
  durationMs: Number,
  s3Key: { type: String, required: true },
  s3Url: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

@Injectable()
export class MongoService {
  private readonly Song = mongoose.model<SongDoc>("songs", songSchema);

  constructor(private readonly config: ConfigService) {}

  async connect(): Promise<void> {
    await mongoose.connect(this.config.mongoUrl);
    console.log("mongo connected");
  }

  async get(videoId: string): Promise<SongDoc | null> {
    return this.Song.findOne({ videoId }).lean();
  }

  async save(song: SongDoc): Promise<void> {
    const { createdAt, ...updatable } = song; // createdAt chỉ set lúc insert
    await this.Song.updateOne(
      { videoId: song.videoId },
      { $set: updatable, $setOnInsert: { createdAt: createdAt ?? new Date() } as never },
      { upsert: true },
    );
  }
}
