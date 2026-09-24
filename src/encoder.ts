/**
 * ffmpeg: encode MP3 64kbps CBR, 44.1kHz, không metadata.
 * App tính duration = filesize / 8000 bytes/s → BẮT BUỘC đúng 64k CBR.
 * onProgress: % encode (0-100) từ progress ffmpeg (time vs duration).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { Injectable } from "./di.js";
import { HttpError } from "./errors.js";
import { ConfigService } from "./config.js";

@Injectable()
export class EncoderService {
  constructor(private readonly config: ConfigService) {}

  async toMp3(source: string, dir: string, onProgress?: (pct: number) => void): Promise<string> {
    const mp3 = path.join(dir, "out.mp3");
    return new Promise((resolveP, rejectP) => {
      const child = spawn("ffmpeg", [
        "-i", source,
        "-vn", "-c:a", "libmp3lame", "-b:a", "64k", "-ar", "44100",
        "-write_id3v1", "0", "-id3v2_version", "0", "-reservoir", "0",
        mp3,
      ], { timeout: this.config.timeoutMs });
      let stderrTail = "";
      // ffmpeg in "time=00:01:23.45" ra stderr (mỗi ~0.5s khi không -progress).
      const timeRe = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;
      let durationS = 0;
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        stderrTail = (stderrTail + s).slice(-500);
        if (!onProgress) return;
        const dur = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (dur) durationS = +dur[1] * 3600 + +dur[2] * 60 + +dur[3];
        for (const m of s.matchAll(timeRe)) {
          const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
          if (durationS > 0) onProgress(Math.min(100, Math.max(0, (t / durationS) * 100)));
        }
      });
      child.on("error", (err) => rejectP(new HttpError(502, `ffmpeg spawn failed: ${err.message}`)));
      child.on("close", (code, signal) => {
        if (code === 0) { resolveP(mp3); return; }
        rejectP(new HttpError(502, signal
          ? `ffmpeg timeout ${this.config.timeoutMs / 1000}s`
          : `ffmpeg failed: ${stderrTail}`));
      });
    });
  }
}
