/**
 * Wrapper yt-dlp: metadata (-J) và tải audio-only.
 * PO token qua bgutil provider plugin; cookies tùy chọn qua env YT_COOKIES.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { Injectable } from "./di.js";
import { HttpError } from "./errors.js";
import { ConfigService } from "./config.js";

export interface VideoInfo {
  title?: string;
  uploader?: string;
  channel?: string;
  duration?: number;
  thumbnail?: string;
  formats?: { acodec?: string }[];
}

@Injectable()
export class YtDlpService {
  private readonly cookieArgs: string[];

  constructor(private readonly config: ConfigService) {
    // Cookies YouTube (phòng bot-check khi IP bị flag — VM Oracle có IP cố định).
    // Nhận chuỗi header "k=v; k2=v2" hoặc Netscape format; ghi 1 lần lúc start,
    // đổi cookies thì restart container.
    const cookies = config.ytCookies;
    if (cookies.trim()) {
      let content = cookies;
      if (!cookies.includes("\t") && !cookies.trimStart().startsWith("#")) {
        content =
          "# Netscape HTTP Cookie File\n" +
          cookies
            .split(";")
            .map((p) => {
              const [name, ...rest] = p.trim().split("=");
              return rest.length
                ? [".youtube.com", "TRUE", "/", "TRUE", "0", name, rest.join("=")].join("\t")
                : "";
            })
            .filter(Boolean)
            .join("\n") +
          "\n";
      }
      writeFileSync("/tmp/yt-cookies.txt", content);
      this.cookieArgs = ["--cookies", "/tmp/yt-cookies.txt"];
    } else {
      this.cookieArgs = [];
    }
  }

  /** Chạy cmd, gom stdout; output khớp progressRegex -> onProgress(pct 0-100). */
  private run(cmd: string, args: string[], onProgress?: (pct: number) => void): Promise<string> {
    return new Promise((resolveP, rejectP) => {
      const child = spawn(cmd, args, { timeout: this.config.timeoutMs });
      let stdout = "";
      let stderrTail = "";
      // yt-dlp in "[download]  12.3%" ra stdout (cần --newline), ffmpeg "size= ... 45%" ra stderr.
      const progressRe = onProgress ? /(\d{1,3}(?:\.\d+)?)\s*%/g : null;
      const onProgressCb = onProgress;
      const onChunk = (chunk: string) => {
        if (!progressRe || !onProgressCb) return;
        for (const m of chunk.matchAll(progressRe)) {
          const v = Number(m[1]);
          if (Number.isFinite(v)) onProgressCb(Math.min(100, Math.max(0, v)));
        }
      };
      child.stdout.on("data", (d: Buffer) => { stdout += d; onChunk(d.toString()); });
      child.stderr.on("data", (d: Buffer) => {
        const s = d.toString();
        stderrTail = (stderrTail + s).slice(-500);
        onChunk(s);
      });
      child.on("error", (err) => rejectP(new HttpError(502, `${cmd} spawn failed: ${err.message}`)));
      child.on("close", (code, signal) => {
        if (code === 0) { resolveP(stdout); return; }
        rejectP(new HttpError(502, signal ? `${cmd} timeout ${this.config.timeoutMs / 1000}s` : `${cmd} failed: ${stderrTail}`));
      });
    });
  }

  private baseArgs() {
    return [
      "--no-playlist", "--no-warnings",
      "--js-runtimes", "node", // EJS challenge solver dùng node (≥22) có sẵn trong image
      "--extractor-args", `youtubepot-bgutilhttp:base_url=${this.config.bgutilUrl}`,
      ...this.cookieArgs,
    ];
  }

  /** Metadata + duration qua yt-dlp -J. */
  async info(videoId: string): Promise<VideoInfo> {
    return JSON.parse(
      await this.run("yt-dlp", ["-J", ...this.baseArgs(), `https://www.youtube.com/watch?v=${videoId}`]),
    );
  }

  /** Tải audio-only + metadata trong MỘT lần chạy (tiết kiệm 1 vòng webpage/PO token/EJS).
   *  onProgress: % tải (0-100) từ dòng [download] của yt-dlp. */
  async downloadAudio(videoId: string, dir: string, onProgress?: (pct: number) => void): Promise<{ source: string; info: VideoInfo }> {
    const source = path.join(dir, "source");
    const stdout = await this.run("yt-dlp", [
      "-f", "ba/b", "--print-json", "--no-simulate", "--newline",
      ...this.baseArgs(), "-o", source,
      `https://www.youtube.com/watch?v=${videoId}`,
    ], onProgress);
    // stdout: JSON info in SAU khi tải xong (dòng JSON cuối)
    const line = stdout.trim().split("\n").pop() ?? "";
    return { source, info: JSON.parse(line) as VideoInfo };
  }
}
