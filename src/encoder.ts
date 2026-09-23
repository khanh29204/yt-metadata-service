/**
 * ffmpeg: encode MP3 64kbps CBR, 44.1kHz, không metadata.
 * App tính duration = filesize / 8000 bytes/s → BẮT BUỘC đúng 64k CBR.
 */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { Injectable } from "./di.js";
import { HttpError } from "./errors.js";
import { ConfigService } from "./config.js";

const execFileP = promisify(execFile);

@Injectable()
export class EncoderService {
  constructor(private readonly config: ConfigService) {}

  async toMp3(source: string, dir: string): Promise<string> {
    const mp3 = path.join(dir, "out.mp3");
    try {
      await execFileP("ffmpeg", [
        "-i", source,
        "-vn", "-c:a", "libmp3lame", "-b:a", "64k", "-ar", "44100",
        "-write_id3v1", "0", "-id3v2_version", "0", "-reservoir", "0",
        mp3,
      ], { timeout: this.config.timeoutMs });
    } catch (e: unknown) {
      const err = e as { stderr?: string; killed?: boolean; message: string };
      throw new HttpError(
        502,
        err.killed
          ? `ffmpeg timeout ${this.config.timeoutMs / 1000}s`
          : `ffmpeg failed: ${(err.stderr || err.message).slice(-500)}`,
      );
    }
    return mp3;
  }
}
