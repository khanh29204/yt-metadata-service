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

  /** Bám stderr ffmpeg, đo % từ time= vs Duration → gọi onProgress. Dùng chung các luồng decode. */
  private static watchProgress(
    child: import("node:child_process").ChildProcess,
    onProgress?: (pct: number) => void,
  ): (chunk: Buffer) => string {
    let stderrTail = "";
    const timeRe = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/g;
    let durationS = 0;
    return (d: Buffer) => {
      const s = d.toString();
      stderrTail = (stderrTail + s).slice(-500);
      if (onProgress) {
        const dur = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
        if (dur) durationS = +dur[1] * 3600 + +dur[2] * 60 + +dur[3];
        for (const m of s.matchAll(timeRe)) {
          const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
          if (durationS > 0) onProgress(Math.min(100, Math.max(0, (t / durationS) * 100)));
        }
      }
      return stderrTail;
    };
  }

  /** Số peak của waveform (0..1), đủ mượt cho UI vẽ sóng. */
  static readonly WAVEFORM_POINTS = 200;

  /** Chạy ffmpeg, thu stdout (PCM pipe) + stderr (progress/log). Reject nếu exit != 0. */
  private static run(
    args: string[],
    timeoutMs: number,
    onProgress?: (pct: number) => void,
  ): Promise<{ pcm: Buffer; stderrTail: string }> {
    return new Promise((resolveP, rejectP) => {
      const child = spawn("ffmpeg", args, { timeout: timeoutMs });
      const chunks: Buffer[] = [];
      let stderrTail = "";
      const onStderr = EncoderService.watchProgress(child, onProgress);
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.stderr.on("data", (d: Buffer) => {
        stderrTail = onStderr(d);
      });
      child.on("error", (err) => rejectP(new HttpError(502, `ffmpeg spawn failed: ${err.message}`)));
      child.on("close", (code, signal) => {
        if (code !== 0) {
          rejectP(new HttpError(502, signal
            ? `ffmpeg timeout ${timeoutMs / 1000}s`
            : `ffmpeg failed: ${stderrTail}`));
          return;
        }
        resolveP({ pcm: Buffer.concat(chunks), stderrTail });
      });
    });
  }

  /**
   * Decode 1 lần, 2 output: MP3 64k CBR (ghi file) + raw PCM mono 8kHz (pipe stdout).
   * App tính duration = filesize / 8000 bytes/s → BẮT BUỘC đúng 64k CBR.
   * onProgress: % encode (0-100) từ progress ffmpeg (time vs duration).
   */
  async toMp3(
    source: string,
    dir: string,
    onProgress?: (pct: number) => void,
  ): Promise<{ mp3: string; waveform: number[] }> {
    const mp3 = path.join(dir, "out.mp3");
    const { pcm } = await EncoderService.run([
      "-i", source,
      "-vn", "-c:a", "libmp3lame", "-b:a", "64k", "-ar", "44100",
      "-write_id3v1", "0", "-id3v2_version", "0", "-reservoir", "0",
      mp3,
      // output 2: PCM thô mono 8kHz qua pipe — JS rút thành peaks, không file trung gian
      "-map", "0:a", "-vn", "-ac", "1", "-ar", "8000",
      "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
    ], this.config.timeoutMs, onProgress);
    return { mp3, waveform: EncoderService.peaks(pcm) };
  }

  /** Lấy waveform từ file audio có sẵn (mp3 trên S3) — cho backfill bản ghi cũ. */
  async waveformFromFile(
    file: string,
    onProgress?: (pct: number) => void,
  ): Promise<number[]> {
    const { pcm } = await EncoderService.run([
      "-i", file, "-map", "0:a", "-vn", "-ac", "1", "-ar", "8000",
      "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
    ], this.config.timeoutMs, onProgress);
    return EncoderService.peaks(pcm);
  }

  /** raw s16le mono → N peak (max abs mỗi bucket, chuẩn hóa 0..1, 2 số lẻ). */
  private static peaks(raw: Buffer, points = EncoderService.WAVEFORM_POINTS): number[] {
    const buckets = Math.min(points, Math.max(1, Math.floor(raw.length / 2)));
    const size = raw.length / 2 / buckets;
    const out: number[] = [];
    for (let b = 0; b < buckets; b++) {
      let max = 0;
      const start = Math.floor(b * size);
      const end = Math.floor((b + 1) * size);
      for (let i = start; i < end; i++) {
        const v = Math.abs(raw.readInt16LE(i * 2));
        if (v > max) max = v;
      }
      out.push(Math.round((max / 32768) * 100) / 100);
    }
    return out;
  }
}
