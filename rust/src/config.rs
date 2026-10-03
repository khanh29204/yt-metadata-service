//! Đọc env 1 lần lúc start — port của src/config.ts.

use std::time::Duration;

#[derive(Clone)]
pub struct Config {
    pub port: u16,
    pub api_key: String,
    pub max_duration_s: u64,   // 15 phút
    pub max_concurrency: usize, // job yt-dlp/ffmpeg đồng thời
    pub timeout: Duration,      // tải/encode 5 phút
    pub bgutil_url: String,
    pub yt_cookies: String,
    pub yt_js_runtime: String, // JS runtime cho EJS solver của yt-dlp: quickjs|deno|bun|node
    /// Allowlist origin cho CORS, phân tách bằng dấu phẩy (VD "https://a.com,https://b.com").
    /// Rỗng = không set header CORS nào (chỉ same-origin).
    pub cors_origins: Vec<String>,
    pub mongo_url: String,
    pub redis_url: String,
    pub redis_ttl_s: u64,
    pub s3_bucket: String,
    pub s3_region: String,
    pub s3_access_key: String,
    pub s3_secret: String,
    pub s3_endpoint: String,     // S3-compatible (R2, MinIO...)
    pub s3_public_base: String,  // URL công khai MP3 (CloudFront / MinIO domain)
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

impl Config {
    pub fn from_env() -> Self {
        Self {
            port: env_or("PORT", "3001").parse().unwrap_or(3001),
            api_key: env_or("SERVICE_API_KEY", ""),
            max_duration_s: env_or("MAX_DURATION_S", "900").parse().unwrap_or(900),
            max_concurrency: env_or("MAX_CONCURRENCY", "2").parse().unwrap_or(2),
            timeout: Duration::from_secs(5 * 60),
            bgutil_url: env_or("BGUTIL_URL", "http://bgutil:4416"),
            yt_cookies: env_or("YT_COOKIES", ""),
            // Node hardcode --js-runtimes node (EJS solver cần node ≥22 có sẵn trong image)
            yt_js_runtime: env_or("YT_JS_RUNTIME", "node"),
            cors_origins: env_or("CORS_ORIGINS", "")
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(String::from)
                .collect(),
            mongo_url: env_or("MONGO_URL", "mongodb://mongo:27017/yt-metadata"),
            redis_url: env_or("REDIS_URL", "redis://redis:6379"),
            redis_ttl_s: env_or("REDIS_TTL_S", "86400").parse().unwrap_or(86400),
            s3_bucket: env_or("S3_BUCKET", ""),
            s3_region: env_or("S3_REGION", "us-east-1"),
            s3_access_key: env_or("S3_ACCESS_KEY_ID", ""),
            s3_secret: env_or("S3_SECRET_ACCESS_KEY", ""),
            s3_endpoint: env_or("S3_ENDPOINT", ""),
            s3_public_base: env_or("S3_PUBLIC_BASE", ""),
        }
    }
}
