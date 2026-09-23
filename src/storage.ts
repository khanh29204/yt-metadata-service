/**
 * S3 storage: check tồn tại (HEAD), upload (PUT), sinh URL công khai.
 * Không dùng SDK — tự ký SigV4 (node:crypto), path-style, chạy với MinIO/R2/AWS.
 */
import { createHmac, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Injectable } from "./di.js";
import { ConfigService } from "./config.js";

/** Đánh dấu X (đúng giá trị) trả về chính nó. */
const sha256Hex = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

@Injectable()
export class StorageService {
  private readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly host: string; // host[:port] của S3 API
  private readonly baseUrl: string; // http(s)://host (path-style)
  private readonly publicBase: string;

  constructor(config: ConfigService) {
    const { bucket, region, accessKeyId, secretAccessKey, endpoint, publicBase } = config.s3;
    this.bucket = bucket;
    this.region = region;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.publicBase = publicBase;
    const url = new URL(endpoint || `https://s3.${region}.amazonaws.com`);
    this.host = url.host;
    this.baseUrl = url.origin;
  }

  /** SigV4 presign-free signed request (payload hash đầy đủ — file MP3 nhỏ nên đọc buffer). */
  private async signed(method: string, key: string, body?: Buffer): Promise<Response> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ""); // yyyymmddThhmmssZ
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(body ?? "");
    const canonicalUri = `/${this.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

    const headers: Record<string, string> = {
      host: this.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (body) headers["content-length"] = String(body.length);

    // canonicalHeaders: mỗi dòng kết thúc \n, join bằng "" — rồi join("\n") tạo
    // dòng trống trước signedHeaders (chuẩn SigV4; lệch 1 \n = SignatureDoesNotMatch)
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers).sort().map((h) => `${h}:${headers[h]}\n`).join("");
    const canonicalRequest = [
      method,
      canonicalUri,
      "", // query rỗng
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.secretAccessKey}`, dateStamp), this.region), "s3"),
      "aws4_request",
    );
    const credential = `${this.accessKeyId}/${scope}`;

    return fetch(`${this.baseUrl}${canonicalUri}`, {
      method,
      headers: { ...headers, Authorization: `AWS4-HMAC-SHA256 Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${hmac(signingKey, stringToSign).toString("hex")}` },
      body: body ? new Uint8Array(body) : undefined,
    });
  }

  /** true nếu key đã có trên S3 (cache). */
  async has(key: string): Promise<boolean> {
    try {
      const res = await this.signed("HEAD", key);
      return res.ok;
    } catch {
      // mọi lỗi HEAD (kể cả key chưa có) = cache miss; S3/creds sai sẽ báo ở bước put
      return false;
    }
  }

  async put(key: string, filePath: string): Promise<void> {
    const res = await this.signed("PUT", key, await readFile(filePath));
    if (!res.ok) {
      const detail = (await res.text()).slice(-300);
      throw new Error(`S3 PUT ${res.status}: ${detail}`);
    }
  }

  url(key: string): string {
    return this.publicBase
      ? `${this.publicBase.replace(/\/$/, "")}/${key}`
      : `${this.baseUrl}/${this.bucket}/${key}`;
  }
}
