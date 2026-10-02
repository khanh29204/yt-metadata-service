//! IO services: Redis, MongoDB, S3, yt-dlp, ffmpeg — port của cache/db/storage/ytdlp/encoder.ts.
//! Orchestration nằm ở js/resolver.js (QuickJS); các host fn ở đây được JS gọi.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};


use object_store::{ObjectStore, PutPayload};use redis::AsyncCommands;
use serde_json::{json, Value};
use tokio::io::AsyncReadExt;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

use crate::config::Config;

/// Lỗi có HTTP status — port của HttpError (errors.ts).
#[derive(Debug, Clone)]
pub struct ApiErr {
    pub status: u16,
    pub message: String,
}

impl ApiErr {
    pub fn new(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

/// Registry các SSE stream đang mở, keyed theo token request — JS gọi `sendStep(token, ...)`.
/// Channel mang chuỗi SSE đã format ("event: ...\ndata: ...\n\n").
static STEPS: OnceLock<Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<String>>>> =
    OnceLock::new();

fn steps() -> &'static Mutex<HashMap<String, tokio::sync::mpsc::UnboundedSender<String>>> {
    STEPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Đăng ký SSE stream cho request token.
pub fn register(token: &str, tx: tokio::sync::mpsc::UnboundedSender<String>) {
    steps().lock().unwrap().insert(token.to_string(), tx);
}

pub fn unregister(token: &str) {
    steps().lock().unwrap().remove(token);
}

pub fn sender_of(token: &str) -> Option<tokio::sync::mpsc::UnboundedSender<String>> {
    steps().lock().unwrap().get(token).cloned()
}

fn sse_event(event: &str, data: &str) -> String {
    format!("event: {event}\ndata: {data}\n\n")
}

/// Đẩy 1 event step vào SSE stream của request (no-op nếu không phải SSE).
pub fn emit(token: &str, step: &str, pct: Option<u8>) {
    let mut ev = json!({ "step": step });
    if let Some(p) = pct {
        ev["pct"] = json!(p);
    }
    if let Some(tx) = steps().lock().unwrap().get(token) {
        let _ = tx.send(sse_event("step", &ev.to_string()));
    }
}

pub struct Services {
    pub cfg: Config,
    mongo: mongodb::Database,
    redis: redis::aio::MultiplexedConnection,
    s3: Box<dyn ObjectStore>,
    s3_base: String, // http(s)://host — path-style
    sem: Arc<Semaphore>,
    yt_base_args: Vec<String>,
}

impl Services {
    pub async fn new(cfg: Config) -> Result<Self, Box<dyn std::error::Error>> {
        // db name = path cuối của mongo url (bỏ query)
        let db = cfg
            .mongo_url
            .split('?').next().unwrap_or("")
            .rsplit('/').next().unwrap_or("yt-metadata")
            .to_string();
        let mongo = mongodb::Client::with_uri_str(&cfg.mongo_url).await?.database(&db);

        let redis = redis::Client::open(cfg.redis_url.as_str())?
            .get_multiplexed_tokio_connection()
            .await?;

        let mut b = object_store::aws::AmazonS3Builder::new()
            .with_bucket_name(&cfg.s3_bucket)
            .with_region(&cfg.s3_region)
            .with_access_key_id(&cfg.s3_access_key)
            .with_secret_access_key(&cfg.s3_secret)
            .with_allow_http(true);
        if !cfg.s3_endpoint.is_empty() {
            b = b.with_endpoint(&cfg.s3_endpoint);
        }
        let s3: Box<dyn ObjectStore> = Box::new(b.build()?);
        // base URL path-style (giống storage.ts)
        let s3_base = if cfg.s3_endpoint.is_empty() {
            format!("https://s3.{}.amazonaws.com", cfg.s3_region)
        } else {
            cfg.s3_endpoint
                .split("//").nth(1).and_then(|r| r.split('/').next()).map(|host| {
                    format!("{}//{}", cfg.s3_endpoint.split("//").next().unwrap_or("https:"), host)
                })
                .unwrap_or_else(|| cfg.s3_endpoint.clone())
        };

        let yt_base_args = build_cookie_args(&cfg.yt_cookies, &cfg.bgutil_url, &cfg.yt_js_runtime)?;

        Ok(Self {
            sem: Arc::new(Semaphore::new(cfg.max_concurrency)),
            cfg,
            mongo,
            redis,
            s3,
            s3_base,
            yt_base_args,
        })
    }

    // ---- Redis cache (chết không fail request) ----

    pub async fn cache_get(&self, video_id: &str) -> Option<String> {
        let mut c = self.redis.clone();
        c.get::<_, Option<String>>(format!("song:{video_id}")).await.ok().flatten()
    }

    pub async fn cache_set(&self, video_id: &str, doc: &str) {
        let mut c = self.redis.clone();
        let _ = c
            .set_ex::<_, _, ()>(format!("song:{video_id}"), doc, self.cfg.redis_ttl_s)
            .await;
    }

    // ---- MongoDB ----

    pub async fn mongo_get(&self, video_id: &str) -> Result<Option<String>, ApiErr> {
        let col = self.mongo.collection::<mongodb::bson::Document>("songs");
        let doc = col
            .find_one(mongodb::bson::doc! { "videoId": video_id })
            .await
            .map_err(|e| ApiErr::new(500, e.to_string()))?;
        Ok(doc.map(|d| serde_json::to_string(&d).expect("bson->json")))
    }

    pub async fn mongo_save(&self, doc_json: &str) -> Result<(), ApiErr> {
        let v: Value = serde_json::from_str(doc_json)
            .map_err(|e| ApiErr::new(500, e.to_string()))?;
        let bson = mongodb::bson::to_bson(&v).map_err(|e| ApiErr::new(500, e.to_string()))?;
        let full = bson.as_document().cloned().ok_or_else(|| ApiErr::new(500, "song doc not a document"))?;
        // $set không được chạm filter key (videoId), immutable (_id) lẫn $setOnInsert
        // (createdAt) — MongoDB báo conflict/immutable path
        let mut updatable = full.clone();
        updatable.remove("createdAt");
        updatable.remove("videoId");
        updatable.remove("_id");
        // $setOnInsert chỉ chứa createdAt: field khác đã nằm trong $set —
        // overlap giữa $set và $setOnInsert gây conflict path ('title'...)
        // createdAt kiểu Date (node/db.ts lưu Date, không phải chuỗi ISO)
        let created_at = full
            .get("createdAt")
            .and_then(|b| b.as_str())
            .and_then(iso_to_bson_date)
            .map(mongodb::bson::Bson::DateTime)
            .unwrap_or(mongodb::bson::Bson::Null);
        let on_insert = mongodb::bson::doc! {
            "createdAt": created_at,
        };
        let col = self.mongo.collection::<mongodb::bson::Document>("songs");
        col.update_one(
            mongodb::bson::doc! { "videoId": v["videoId"].as_str().unwrap_or_default() },
            mongodb::bson::doc! {
                "$set": mongodb::bson::to_bson(&updatable).unwrap(),
                "$setOnInsert": mongodb::bson::to_bson(&on_insert).unwrap(),
            },
        )
        .upsert(true)
        .await
        .map_err(|e| ApiErr::new(500, e.to_string()))?;
        Ok(())
    }

    // ---- S3 ----

    pub async fn s3_has(&self, key: &str) -> bool {
        self.s3.head(&object_store::path::Path::from(key)).await.is_ok()
    }

    /// Tải file về buffer (backfill waveform cho bản ghi cũ) — port storage.get.
    pub async fn s3_get(&self, key: &str) -> Result<Vec<u8>, ApiErr> {
        let obj = self
            .s3
            .get(&object_store::path::Path::from(key))
            .await
            .map_err(|e| ApiErr::new(502, format!("S3 GET: {e}")))?;
        let bytes = obj
            .bytes()
            .await
            .map_err(|e| ApiErr::new(502, format!("S3 GET: {e}")))?;
        Ok(bytes.to_vec())
    }

    pub async fn s3_put(&self, token: &str, key: &str, file: &str) -> Result<(), ApiErr> {
        use object_store::{Attribute, AttributeValue, Attributes, PutOptions};
        emit(token, "uploading", None);
        let bytes = tokio::fs::read(file).await.map_err(|e| ApiErr::new(500, e.to_string()))?;
        // content-disposition inline — browser mở link sẽ PHÁT nhạc thay vì tải file;
        // content-type audio/mpeg — giống storage.ts signed PUT
        let opts: PutOptions = Attributes::from_iter([
            (
                Attribute::ContentDisposition,
                AttributeValue::from("inline"),
            ),
            (
                Attribute::ContentType,
                AttributeValue::from("audio/mpeg"),
            ),
        ])
        .into();
        self.s3
            .put_opts(
                &object_store::path::Path::from(key),
                PutPayload::from(bytes),
                opts,
            )
            .await
            .map_err(|e| ApiErr::new(502, format!("S3 PUT: {e}")))?;
        Ok(())
    }

    /// URL công khai — publicBase ưu tiên, không thì path-style qua API host.
    pub fn s3_url_for(&self, key: &str) -> String {
        if self.cfg.s3_public_base.is_empty() {
            format!("{}/{}/{}", self.s3_base, self.cfg.s3_bucket, key)
        } else {
            format!("{}/{}", self.cfg.s3_public_base.trim_end_matches('/'), key)
        }
    }

    pub fn log_cache_hit(&self, key: &str) {
        println!("cache hit: {key}");
    }

    pub fn s3_key_for(&self, video_id: &str) -> String {
        // hash = sha1(videoId) — key cố định nên HEAD được làm cache
        use sha1_smol::Sha1;
        let mut h = Sha1::new();
        h.update(video_id.as_bytes());
        format!("songs/{}/{}.mp3", video_id, h.digest().to_string()[..12].to_string())
    }

    /// Permit semaphore tải/encode (backfill waveform dùng chung giới hạn).
    pub async fn acquire_permit(&self) -> OwnedSemaphorePermit {
        self.sem.clone().acquire_owned().await.unwrap()
    }

    // ---- Workdir ----

    pub async fn mkdtemp(&self) -> Result<String, ApiErr> {
        let dir = std::env::temp_dir().join(format!(
            "yt-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| ApiErr::new(500, e.to_string()))?;
        Ok(dir.to_string_lossy().into_owned())
    }

    pub async fn rmrf(&self, dir: &str) {
        let _ = tokio::fs::remove_dir_all(dir).await;
    }

    // ---- yt-dlp ----

    fn watch_url(&self, video_id: &str) -> String {
        format!("https://www.youtube.com/watch?v={video_id}")
    }

    /// Chạy yt-dlp, gom stdout. on_pct = (token, step): bắt "12.3%" từ MỖI chunk
    /// stdout/stderr (giống Node matchAll) → emit(step, pct).
    async fn yt_dlp(&self, args: Vec<String>, on_pct: Option<(&str, &str)>) -> Result<String, ApiErr> {
        let mut cmd = tokio::process::Command::new("yt-dlp");
        cmd.args(&args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        let mut child = cmd
            .spawn()
            .map_err(|e| ApiErr::new(502, format!("yt-dlp spawn failed: {e}")))?;
        let mut stdout = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();

        // task stderr cần 'static → owns token/step (on_pct giữ nguyên cho stdout)
        let on_pct_err = on_pct.map(|(t, s)| (t.to_string(), s.to_string()));
        let err_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // stderr cũng parse % (ffmpeg in "size= ... 45%" ra stderr)
                        if let Some((token, step)) = &on_pct_err {
                            let s = String::from_utf8_lossy(&chunk[..n]);
                            for pct in scan_pcts(&s) {
                                emit(token, step, Some(pct));
                            }
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if buf.len() > 500 {
                            let cut = buf.len() - 500;
                            buf.drain(..cut);
                        }
                    }
                }
            }
            String::from_utf8_lossy(&buf).into_owned()
        });

        let mut lines = String::new();
        let mut line = Vec::new();
        let mut chunk = [0u8; 8192];
        let run = async {
            loop {
                match stdout.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // parse % trên từng chunk (Node cũng parse từng chunk data)
                        if let Some((token, step)) = on_pct {
                            let s = String::from_utf8_lossy(&chunk[..n]);
                            for pct in scan_pcts(&s) {
                                emit(token, step, Some(pct));
                            }
                        }
                        for &b in &chunk[..n] {
                            if b == b'\n' {
                                let s = String::from_utf8_lossy(&line).into_owned();
                                lines.push_str(&s);
                                lines.push('\n');
                                line.clear();
                            } else {
                                line.push(b);
                            }
                        }
                    }
                }
            }
        };
        if tokio::time::timeout(self.cfg.timeout, run).await.is_err() {
            let _ = child.kill().await;
            return Err(ApiErr::new(502, format!(
                "yt-dlp timeout {}s", self.cfg.timeout.as_secs()
            )));
        }
        let status = child.wait().await.map_err(|e| ApiErr::new(502, e.to_string()))?;
        let stderr_tail = err_task.await.unwrap_or_default();
        if !status.success() {
            return Err(ApiErr::new(502, format!("yt-dlp failed: {stderr_tail}")));
        }
        Ok(lines)
    }

    /// Metadata qua yt-dlp -J (không giới hạn concurrency — giống path cache-hit S3).
    pub async fn yt_info(&self, video_id: &str) -> Result<String, ApiErr> {
        let mut args = vec!["-J".to_string()];
        args.extend(self.yt_base_args.clone());
        args.push(self.watch_url(video_id));
        Ok(self.yt_dlp(args, None).await?.trim().to_string())
    }

    /// Tải audio + encode + trả (info JSON, waveform). Emit downloading/encoding(pct) qua token.
    /// KHÔNG tự giữ permit — caller (resolver bước 4) acquire bao cả download+encode+s3_put
    /// (giống Node: limited() bọc cả storage.put).
    pub async fn download_encode(
        &self,
        video_id: &str,
        dir: &str,
        token: &str,
    ) -> Result<(String, Vec<f64>), ApiErr> {
        emit(token, "downloading", None);
        let source = format!("{dir}/source");
        let mut args = vec![
            "-f", "ba/b", "--print-json", "--no-simulate", "--newline",
        ]
        .into_iter().map(String::from).collect::<Vec<_>>();
        args.extend(self.yt_base_args.clone());
        args.extend(["-o".into(), source.clone(), self.watch_url(video_id)]);
        // không emit pct khi tải — Node resolver.ts cũng không truyền onProgress vào downloadAudio
        let stdout = self.yt_dlp(args, None).await?;

        // info JSON = dòng cuối in bởi --print-json
        let info_raw = stdout
            .lines()
            .filter(|l| l.starts_with('{'))
            .last()
            .ok_or_else(|| ApiErr::new(502, "yt-dlp: no info json"))?;
        let info: Value = serde_json::from_str(info_raw)
            .map_err(|e| ApiErr::new(502, format!("yt-dlp info parse: {e}")))?;

        let duration_s = info["duration"].as_f64().unwrap_or(0.0);
        let has_audio = info["formats"].as_array().is_some_and(|fs| {
            fs.iter().any(|f| {
                f["acodec"].as_str().is_some_and(|a| !a.is_empty() && a != "none")
            })
        });
        if duration_s == 0.0 || !has_audio {
            return Err(ApiErr::new(415, "no audio stream available"));
        }
        if duration_s > self.cfg.max_duration_s as f64 {
            return Err(ApiErr::new(
                413,
                format!(
                    "video too long: {}s (max {}s)",
                    duration_s as u64, self.cfg.max_duration_s
                ),
            ));
        }

        emit(token, "encoding", None);
        let mp3 = format!("{dir}/out.mp3");
        let waveform = self.encode(&source, &mp3, token).await?;
        let info_json = serde_json::to_string(&info).expect("info json");
        Ok((info_json, waveform))
    }

    /// ffmpeg 1 lần chạy, 2 output: MP3 64k CBR (file) + PCM mono 8kHz (pipe) cho waveform.
    async fn encode(&self, source: &str, mp3: &str, token: &str) -> Result<Vec<f64>, ApiErr> {
        let args = [
            "-i", source,
            "-vn", "-c:a", "libmp3lame", "-b:a", "64k", "-ar", "44100",
            "-write_id3v1", "0", "-id3v2_version", "0", "-reservoir", "0",
            mp3,
            "-map", "0:a", "-vn", "-ac", "1", "-ar", "8000",
            "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
        ];
        let pcm = self.run_ffmpeg(&args, token, "encoding").await?;
        Ok(peaks(&pcm, 200))
    }

    /// Decode file audio có sẵn thành PCM 8kHz → peaks (backfill waveform bản ghi cũ).
    pub async fn waveform_from_file(&self, file: &str, token: &str) -> Result<Vec<f64>, ApiErr> {
        let args = [
            "-i", file, "-map", "0:a", "-vn", "-ac", "1", "-ar", "8000",
            "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1",
        ];
        let pcm = self.run_ffmpeg(&args, token, "backfilling").await?;
        Ok(peaks(&pcm, 200))
    }

    /// Chạy ffmpeg: thu stdout (PCM pipe) + bám stderr parse Duration/time= → emit(step, pct).
    async fn run_ffmpeg(
        &self,
        args: &[&str],
        token: &str,
        step: &str,
    ) -> Result<Vec<u8>, ApiErr> {
        let mut child = tokio::process::Command::new("ffmpeg")
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| ApiErr::new(502, format!("ffmpeg spawn failed: {e}")))?;

        let mut pcm_out = child.stdout.take().unwrap();
        let mut stderr = child.stderr.take().unwrap();
        let pcm_task = tokio::spawn(async move {
            let mut buf = Vec::new();
            let _ = pcm_out.read_to_end(&mut buf).await;
            buf
        });

        // ffmpeg tách dòng bằng \r — parse TỪNG dòng (parse trên buffer tích lũy
        // sẽ trả giá trị time cũ)
        let mut stderr_tail = String::new();
        let mut duration_s = 0f64;
        let mut line = Vec::new();
        let mut chunk = [0u8; 4096];
        let run = async {
            loop {
                match stderr.read(&mut chunk).await {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        for &b in &chunk[..n] {
                            if b != b'\r' && b != b'\n' {
                                line.push(b);
                                continue;
                            }
                            if line.is_empty() {
                                continue;
                            }
                            let s = String::from_utf8_lossy(&line);
                            if let Some(d) = parse_hms(&s, "Duration:") {
                                duration_s = d;
                            }
                            if duration_s > 0.0 {
                                if let Some(t) = parse_hms(&s, "time=") {
                                    emit(token, step, Some(((t / duration_s * 100.0).clamp(0.0, 100.0)) as u8));
                                }
                            }
                            stderr_tail.push_str(&s);
                            if stderr_tail.len() > 500 {
                                let cut = stderr_tail.len() - 500;
                                stderr_tail.drain(..cut);
                            }
                            line.clear();
                        }
                    }
                }
            }
        };
        if tokio::time::timeout(self.cfg.timeout, run).await.is_err() {
            let _ = child.kill().await;
            return Err(ApiErr::new(502, format!("ffmpeg timeout {}s", self.cfg.timeout.as_secs())));
        }
        let status = child.wait().await.map_err(|e| ApiErr::new(502, e.to_string()))?;
        let pcm = pcm_task.await.unwrap_or_default();
        if !status.success() {
            return Err(ApiErr::new(502, format!("ffmpeg failed: {stderr_tail}")));
        }
        Ok(pcm)
    }
}

/// "k=v; k2=v2" hoặc Netscape → ghi /tmp/yt-cookies.txt, trả args yt-dlp.
fn build_cookie_args(
    cookies: &str,
    bgutil_url: &str,
    js_runtime: &str,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let base = |cookies_args: &[&str]| {
        let mut v = vec![
            "--no-playlist".to_string(),
            "--no-warnings".to_string(),
            "--js-runtimes".to_string(),
            js_runtime.to_string(),
            "--extractor-args".to_string(),
            format!("youtubepot-bgutilhttp:base_url={bgutil_url}"),
        ];
        v.extend(cookies_args.iter().map(|s| s.to_string()));
        v
    };
    if cookies.trim().is_empty() {
        return Ok(base(&[]));
    }
    let content = if cookies.contains('\t') || cookies.trim_start().starts_with('#') {
        cookies.to_string()
    } else {
        let mut out = String::from("# Netscape HTTP Cookie File\n");
        for part in cookies.split(';') {
            let part = part.trim();
            if let Some((name, val)) = part.split_once('=') {
                out.push_str(&format!(".youtube.com\tTRUE\t/\tTRUE\t0\t{name}\t{val}\n"));
            }
        }
        out
    };
    std::fs::write("/tmp/yt-cookies.txt", content)?;
    Ok(base(&["--cookies", "/tmp/yt-cookies.txt"]))
}

/// Quét các số "%" trong chunk — tương đương regex `(\d{1,3}(?:\.\d+)?)\s*%` của Node,
/// clamp 0-100. (Không kéo crate regex cho 1 pattern.)
fn scan_pcts(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    for (i, &c) in b.iter().enumerate() {
        if c != b'%' {
            continue;
        }
        // bỏ qua khoảng trắng trước '%'
        let mut j = i;
        while j > 0 && b[j - 1].is_ascii_whitespace() {
            j -= 1;
        }
        // đọc ngược phần thập phân: digits + tối đa 1 dấu '.'
        let mut end = j;
        let mut saw_digit = false;
        let mut dots = 0;
        while end > 0 {
            let c = b[end - 1];
            if c.is_ascii_digit() {
                saw_digit = true;
                end -= 1;
            } else if c == b'.' && dots == 0 && end > 1 && b[end - 2].is_ascii_digit() {
                dots += 1;
                end -= 1;
            } else {
                break;
            }
        }
        if !saw_digit {
            continue;
        }
        if let Ok(v) = s[end..j].parse::<f64>() {
            out.push(v.clamp(0.0, 100.0) as u8);
        }
    }
    out
}

/// ISO 8601 UTC ("2025-01-02T03:04:05.678Z") → bson DateTime — nghịch đảo chrono_like_now
/// (days_from_civil, Howard Hinnant). Chấp nhận cả dạng không có mili-giây.
fn iso_to_bson_date(s: &str) -> Option<mongodb::bson::DateTime> {
    let n: Vec<i64> = s
        .split(|c: char| !c.is_ascii_digit())
        .filter_map(|p| p.parse().ok())
        .collect();
    if n.len() < 6 {
        return None;
    }
    let (y, mo, d) = (n[0], n[1], n[2]);
    let y2 = y - if mo <= 2 { 1 } else { 0 };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * if mo > 2 { mo - 3 } else { mo + 9 } + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    let secs = days * 86400 + n[3] * 3600 + n[4] * 60 + n[5];
    let ms = n.get(6).copied().unwrap_or(0);
    Some(mongodb::bson::DateTime::from_millis(secs * 1000 + ms))
}

/// Tìm "HH:MM:SS(.ms)" ngay sau `marker` (ffmpeg Duration:/time=).
fn parse_hms(s: &str, marker: &str) -> Option<f64> {
    let rest = s.split(marker).nth(1)?;
    let mut it = rest.trim_start().split(&[':', ' ', ',']);
    let h: f64 = it.next()?.parse().ok()?;
    let m: f64 = it.next()?.parse().ok()?;
    let sec: f64 = it.next()?.parse().ok()?;
    if !(0.0..=24.0).contains(&h) {
        return None;
    }
    Some(h * 3600.0 + m * 60.0 + sec)
}

/// raw s16le mono → N peak (max abs mỗi bucket, chuẩn hóa 0..1, 2 số lẻ).
fn peaks(raw: &[u8], points: usize) -> Vec<f64> {
    let samples = raw.len() / 2;
    let buckets = points.min(samples.max(1));
    let size = samples as f64 / buckets as f64;
    (0..buckets)
        .map(|b| {
            let start = (b as f64 * size) as usize;
            let end = (((b + 1) as f64 * size) as usize).min(samples);
            let mut max: u16 = 0;
            for i in start..end {
                let v = i16::from_le_bytes([raw[i * 2], raw[i * 2 + 1]]).unsigned_abs();
                if v > max {
                    max = v;
                }
            }
            (max as f64 / 32768.0 * 100.0).round() / 100.0        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_peaks() {
        // 4 sample → 4 bucket: [1.0, 0.0, 0.5, 0.0]
        let mut raw = Vec::new();
        for v in [-32768i16, 0, 16384, -100] {
            raw.extend_from_slice(&v.to_le_bytes());
        }
        assert_eq!(peaks(&raw, 200), vec![1.0, 0.0, 0.5, 0.0]);
        // 2 sample, 1 bucket (points=1) → max abs
        let two: Vec<u8> = [-32768i16, 100]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        assert_eq!(peaks(&two, 1), vec![1.0]);
        assert_eq!(peaks(&[], 200), vec![0.0]); // 1 bucket rỗng
    }

    #[test]
    fn test_iso_to_bson_date() {
        // 2025-01-02T03:04:05.678Z = 1735787045678 ms
        assert_eq!(
            iso_to_bson_date("2025-01-02T03:04:05.678Z").unwrap().timestamp_millis(),
            1_735_787_045_678
        );
        // không có mili-giây ("2025-01-02T03:04:05Z")
        assert_eq!(
            iso_to_bson_date("2025-01-02T03:04:05Z").unwrap().timestamp_millis(),
            1_735_787_045_000
        );
        assert!(iso_to_bson_date("not-a-date").is_none());
    }

    #[test]
    fn test_parse_hms() {
        assert_eq!(parse_hms("Duration: 00:01:40.00, start: 0", "Duration:"), Some(100.0));
        assert_eq!(parse_hms("time=00:00:50.00", "time="), Some(50.0));
        assert_eq!(parse_hms("nothing", "time="), None);
    }

    #[test]
    fn test_scan_pcts() {
        // regex Node: \d{1,3}(\.\d+)?\s*%
        assert_eq!(scan_pcts("[download]  12.3% of 4.5MiB"), vec![12]);
        assert_eq!(scan_pcts("size= 1024kB time=00:00:30 45 %"), vec![45]);
        assert_eq!(scan_pcts("100% done, 0.5% left"), vec![100, 0]);
        // "1234%": Node backtrack khớp "234%" → 234 clamp 100
        assert_eq!(scan_pcts("1234%"), vec![100]);
        assert_eq!(scan_pcts("no percent here"), Vec::<u8>::new());
        assert_eq!(scan_pcts("999%"), vec![100]); // clamp 0-100
        assert_eq!(scan_pcts(".5%"), vec![5]); // regex Node vẫn khớp "5%"
    }
}
