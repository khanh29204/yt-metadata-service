/** Controller: validate input, gọi service, map kết quả/lỗi -> {status, body}. */
import { Injectable } from "./di.js";
import { HttpError } from "./errors.js";
import { ConfigService } from "./config.js";
import { ResolverService } from "./resolver.js";

/** Chuẩn hóa videoId từ url youtube.com / music.youtube.com / youtu.be, hoặc id trần. */
function extractVideoId(input: string): string | null {
  const m =
    input.match(/[?&]v=([\w-]{11})/) ||
    input.match(/youtu\.be\/([\w-]{11})/) ||
    input.match(/\/(?:embed|shorts|v)\/([\w-]{11})/);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(input.trim()) ? input.trim() : null;
}

@Injectable()
export class ResolveController {
  constructor(
    private readonly resolver: ResolverService,
    private readonly config: ConfigService,
  ) {}

  async resolve(
    body: unknown,
    onStep?: (step: string, pct?: number) => void,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const input = (body as { videoId?: unknown; url?: unknown } | null)?.videoId ??
      (body as { url?: unknown } | null)?.url;
    if (typeof input !== "string" || !input)
      return { status: 400, body: { error: "body must be {videoId} or {url}" } };

    const videoId = extractVideoId(input);
    if (!videoId) return { status: 400, body: { error: "cannot parse videoId from input" } };
    if (!this.config.s3.bucket) return { status: 500, body: { error: "S3_BUCKET not configured" } };

    try {
      const m = await this.resolver.resolve(videoId, onStep);
      return {
        status: 200,
        body: {
          videoId: m.videoId,
          title: m.title,
          artist: m.artist,
          thumbnail: m.thumbnail,
          durationMs: m.durationMs,
          s3Url: m.s3Url,
        },
      };
    } catch (e: unknown) {
      if (e instanceof HttpError) return { status: e.status, body: { error: e.message } };
      console.error(e);
      return { status: 500, body: { error: "internal error" } };
    }
  }
}
