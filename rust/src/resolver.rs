//! Orchestration: resolve videoId -> metadata + MP3 trên S3 — port của src/resolver.ts.
//! Thứ tự lookup: Redis (cache 1 ngày) → MongoDB → S3 (HEAD) → tải mới.

use std::sync::Arc;

use serde_json::json;

use crate::services::{emit, Services};

/// Chuẩn hóa videoId từ url youtube/music/youtu.be/embed/shorts, hoặc id trần — port extractVideoId.
pub fn extract_video_id(input: &str) -> Option<String> {
    let is_id_char = |c: char| c.is_ascii_alphanumeric() || c == '_' || c == '-';
    let take11 = |s: &str| -> Option<String> {
        let id: String = s.chars().take_while(|c| is_id_char(*c)).take(11).collect();
        (id.chars().count() == 11).then_some(id)
    };
    for marker in ["?v=", "&v=", "youtu.be/", "/embed/", "/shorts/", "/v/"] {
        if let Some(i) = input.find(marker) {
            if let Some(id) = take11(&input[i + marker.len()..]) {
                return Some(id);
            }
        }
    }
    let t = input.trim();
    (t.chars().count() == 11 && t.chars().all(is_id_char)).then(|| t.to_string())
}

fn to_song(state: &Services, video_id: &str, info: &serde_json::Value, s3_key: &str, waveform: Option<&[f64]>) -> serde_json::Value {
    let mut song = json!({
        "videoId": video_id,
        "title": info["title"].as_str().unwrap_or(""),
        "artist": info["uploader"].as_str().or(info["channel"].as_str()).unwrap_or(""),
        "thumbnail": info["thumbnail"].as_str()
            .unwrap_or(&format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")),
        "durationMs": ((info["duration"].as_f64().unwrap_or(0.0) * 1000.0).round()) as i64,
        "s3Key": s3_key,
        "s3Url": state.s3_url_for(s3_key),
        "createdAt": chrono_like_now(),
    });
    if let Some(w) = waveform.filter(|w| !w.is_empty()) {
        song["waveform"] = json!(w);
    }
    song
}

/// ISO 8601 UTC, không kéo phụ thuộc chrono.
fn chrono_like_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let days = secs / 86400;
    // civil-from-days (Howard Hinnant algorithm)
    let z = days as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    let (h, mi, s) = ((secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{mi:02}:{s:02}.000Z")
}

/// Bản ghi cũ chưa có waveform: tải MP3 từ S3, decode lấy peaks, update Mongo + Redis.
/// Lỗi backfill không làm fail request — trả song nguyên trạng (port withWaveform).
async fn with_waveform(state: &Arc<Services>, mut song: serde_json::Value, token: &str) -> serde_json::Value {
    if song["waveform"].is_array() {
        return song;
    }
    let video_id = song["videoId"].as_str().unwrap_or_default().to_string();
    let dir = match state.mkdtemp().await {
        Ok(d) => d,
        Err(_) => return song,
    };
    let result = async {
        let _permit = state.acquire_permit().await; // decode ăn CPU — chung giới hạn yt-dlp/encode
        emit(token, "backfilling", None);
        let file = format!("{dir}/in.mp3");
        let bytes = state
            .s3_get(song["s3Key"].as_str().unwrap_or_default())
            .await
            .map_err(|e| (e.status, e.message))?;
        tokio::fs::write(&file, &bytes).await.map_err(|e| (500, e.to_string()))?;
        let waveform = state
            .waveform_from_file(&file, token)
            .await
            .map_err(|e| (e.status, e.message))?;
        song["waveform"] = json!(waveform);
        state.mongo_save(&song.to_string()).await.map_err(|e| (e.status, e.message))?;
        state.cache_set(&video_id, &song.to_string()).await;
        println!("waveform backfilled: {video_id}");
        Ok::<(), (u16, String)>(())
    }
    .await;
    state.rmrf(&dir).await;
    if let Err((_, msg)) = result {
        eprintln!("waveform backfill failed: {video_id}: {msg}");
        // không mutate song — trả nguyên trạng
        let mut orig = song.clone();
        orig.as_object_mut().map(|o| o.remove("waveform"));
        return orig;
    }
    song
}

/// Luồng resolve chính. Trả JSON SongDoc; lỗi (status, message).
pub async fn resolve(state: &Arc<Services>, video_id: &str, token: &str) -> Result<String, (u16, String)> {
    // 1. Redis cache nóng — JSON hỏng thì coi như cache miss, chạy tiếp xuống Mongo
    // (Node getSong bọc try/catch JSON.parse → null)
    if let Some(cached) = state.cache_get(video_id).await {
        if let Ok(song) = serde_json::from_str::<serde_json::Value>(&cached) {
            return serde_json::to_string(&with_waveform(state, song, token).await)
                .map_err(|e| (500, e.to_string()));
        }
    }

    // 2. MongoDB (bền)
    if let Some(stored) = state.mongo_get(video_id).await.map_err(|e| (e.status, e.message))? {
        state.cache_set(video_id, &stored).await;
        let song: serde_json::Value = serde_json::from_str(&stored)
            .map_err(|e| (500, format!("mongo parse: {e}")))?;
        return serde_json::to_string(&with_waveform(state, song, token).await)
            .map_err(|e| (500, e.to_string()));
    }

    // 3. MP3 đã có trên S3 nhưng chưa có record? (VD DB mới setup, S3 cũ)
    emit(token, "check", None);
    let s3_key = state.s3_key_for(video_id);
    if state.s3_has(&s3_key).await {
        state.log_cache_hit(&s3_key);
        let info_json = state
            .yt_info(video_id)
            .await
            .map_err(|e| (e.status, e.message))?;
        let info: serde_json::Value =
            serde_json::from_str(&info_json).map_err(|e| (502, format!("yt-dlp info parse: {e}")))?;
        let song = to_song(state, video_id, &info, &s3_key, None);
        state
            .mongo_save(&song.to_string())
            .await
            .map_err(|e| (e.status, e.message))?;
        let doc = song.to_string();
        state.cache_set(video_id, &doc).await;
        return serde_json::to_string(&with_waveform(state, song, token).await)
            .map_err(|e| (500, e.to_string()));
    }

    // 4. Tải + encode + upload — MỘT lần chạy yt-dlp; emit downloading/encoding(pct)/uploading từ services
    let dir = state.mkdtemp().await.map_err(|e| (e.status, e.message))?;
    let result = async {
        // permit bao cả download + encode + upload (Node limited() bọc cả storage.put)
        let _permit = state.acquire_permit().await;
        let (info_json, waveform) = state
            .download_encode(video_id, &dir, token)
            .await
            .map_err(|e| (e.status, e.message))?;
        state
            .s3_put(token, &s3_key, &format!("{dir}/out.mp3"))
            .await
            .map_err(|e| (e.status, e.message))?;
        drop(_permit); // upload xong mới nhả — rmrf ở finally ngoài không cần permit
        let info: serde_json::Value =
            serde_json::from_str(&info_json).map_err(|e| (502, format!("yt-dlp info parse: {e}")))?;
        let song = to_song(state, video_id, &info, &s3_key, Some(&waveform));
        state
            .mongo_save(&song.to_string())
            .await
            .map_err(|e| (e.status, e.message))?;
        let doc = song.to_string();
        state.cache_set(video_id, &doc).await;
        Ok::<String, (u16, String)>(doc)
    }
    .await;
    state.rmrf(&dir).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_video_id() {
        assert_eq!(extract_video_id("RKvRLLQtDbg").as_deref(), Some("RKvRLLQtDbg"));
        assert_eq!(extract_video_id("https://music.youtube.com/watch?v=RKvRLLQtDbg").as_deref(), Some("RKvRLLQtDbg"));
        assert_eq!(extract_video_id("https://youtu.be/RKvRLLQtDbg?t=1").as_deref(), Some("RKvRLLQtDbg"));
        assert_eq!(extract_video_id("https://www.youtube.com/shorts/RKvRLLQtDbg").as_deref(), Some("RKvRLLQtDbg"));
        assert_eq!(extract_video_id("https://www.youtube.com/embed/RKvRLLQtDbg").as_deref(), Some("RKvRLLQtDbg"));
        assert_eq!(extract_video_id("short"), None);
        assert_eq!(extract_video_id("has!special@chars").is_none().then_some(()), Some(()));
    }
}
