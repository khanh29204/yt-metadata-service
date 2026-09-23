/**
 * Wrapper yt-dlp: metadata (-J) và tải audio-only.
 * PO token qua bgutil provider plugin; cookies tùy chọn qua env YT_COOKIES.
 */
import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Injectable } from "./di.js";
import { HttpError } from "./errors.js";
import { ConfigService } from "./config.js";

const execFileP = promisify(execFile);

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

  private async run(cmd: string, args: string[]) {
    try {
      const { stdout } = await execFileP(cmd, args, {
        timeout: this.config.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      return stdout;
    } catch (e: unknown) {
      const err = e as { stderr?: string; killed?: boolean; message: string };
      throw new HttpError(
        502,
        err.killed
          ? `${cmd} timeout ${this.config.timeoutMs / 1000}s`
          : `${cmd} failed: ${(err.stderr || err.message).slice(-500)}`,
      );
    }
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

  /** Tải audio-only tốt nhất, trả path file nguồn. */
  async downloadAudio(videoId: string, dir: string): Promise<string> {
    const source = path.join(dir, "source");
    await this.run("yt-dlp", [
      "-f", "ba/b", ...this.baseArgs(), "-o", source,
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    return source;
  }
}
