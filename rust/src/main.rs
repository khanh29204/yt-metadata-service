//! yt-metadata-service — bootstrap Rust (axum).
//!
//! GET /api/v1/audio-url?videoId=|url= [&sse=1]
//! -> { videoId, title, artist, thumbnail, durationMs, s3Url, waveform? }
//!
//! Orchestration ở resolver.rs; IO ở services.rs.
//! Auth: header x-api-key (SERVICE_API_KEY trống = tắt).

mod config;
mod resolver;
mod services;

use std::collections::HashMap;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use futures::StreamExt;
use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::config::Config;
use crate::services::Services;

struct App {
    cfg: Config,
    state: Arc<Services>,
}

#[tokio::main]
async fn main() {
    let cfg = Config::from_env();
    let state = Arc::new(Services::new(cfg.clone()).await.expect("connect mongo/redis/s3"));
    let port = cfg.port;
    let app = Arc::new(App { cfg, state });

    let router = Router::new()
        .route("/api/v1/audio-url", get(audio_url))
        .route("/health", get(|| async { "ok" }))
        .layer(middleware::from_fn_with_state(app.clone(), auth))
        .with_state(app);

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port))
        .await
        .expect("bind");
    println!("yt-metadata-service (rust) on :{port}");
    axum::serve(listener, router).await.unwrap();
}

async fn auth(State(app): State<Arc<App>>, req: Request, next: Next) -> Response {
    // tạm tắt khi SERVICE_API_KEY trống — bật lại khi mở public
    if !app.cfg.api_key.is_empty() && req.headers().get("x-api-key").map(|v| v.as_bytes()) != Some(app.cfg.api_key.as_bytes()) {
        return (StatusCode::UNAUTHORIZED, r#"{"error":"invalid api key"}"#).into_response();
    }
    next.run(req).await
}

async fn audio_url(State(app): State<Arc<App>>, _headers: HeaderMap, raw: axum::extract::RawQuery) -> Response {
    let params: HashMap<String, String> = raw
        .0
        .and_then(|q| serde_urlencoded::from_str(&q).ok())
        .unwrap_or_default();

    let input = params.get("videoId").cloned().or_else(|| params.get("url").cloned()).unwrap_or_default();
    if input.is_empty() {
        return err_json(400, "query must be ?videoId= or ?url=");
    }
    let Some(video_id) = resolver::extract_video_id(&input) else {
        return err_json(400, "cannot parse videoId from input");
    };
    if app.cfg.s3_bucket.is_empty() {
        return err_json(500, "S3_BUCKET not configured");
    }

    if params.get("sse").map(String::as_str) == Some("1") {
        return sse_resolve(app, video_id).await;
    }
    match resolver::resolve(&app.state, &video_id, "").await {
        Ok(doc) => shaped(doc),
        Err((status, msg)) => err_json(status, &msg),
    }
}

/// SSE: stream event step/done/error; ping ": ping" mỗi 15s; status luôn 200.
async fn sse_resolve(app: Arc<App>, video_id: String) -> Response {
    let (tx, rx) = mpsc::unbounded_channel::<String>();
    let token = format!("t-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos());

    services::register(&token, tx.clone());
    let state = app.state.clone();
    let tok = token.clone();
    let tok_ping = token.clone();
    // ping giữ connection — abort khi resolve xong (cùng với drop tx → stream đóng)
    let ping = tokio::spawn(async move {
        if let Some(tx) = services::sender_of(&tok_ping) {
            let mut tick = tokio::time::interval(std::time::Duration::from_secs(15));
            tick.tick().await; // bỏ tick đầu
            loop {
                tick.tick().await;
                if tx.send(": ping\n\n".to_string()).is_err() {
                    break;
                }
            }
        }
    });
    tokio::spawn(async move {
        let done = match resolver::resolve(&state, &video_id, &tok).await {
            Ok(doc) => ("done", shaped_value(doc).to_string()),
            Err((_, msg)) => ("error", json!({ "error": msg }).to_string()),
        };
        let _ = tx.send(format!("event: {}\ndata: {}\n\n", done.0, done.1));
        services::unregister(&tok); // bỏ sender trong registry
        ping.abort(); // dừng task ping
        drop(tx); // sender cuối → Body stream kết thúc → connection đóng
    });

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream")
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        .body(Body::from_stream(
            tokio_stream::wrappers::UnboundedReceiverStream::new(rx)
                .map(Ok::<_, std::io::Error>),
        ))
        .unwrap()
}

/// Response client chỉ thấy các field công khai (giống controller cũ: bỏ s3Key/createdAt).
fn shaped_value(doc_json: String) -> Value {
    let doc: Value = serde_json::from_str(&doc_json).unwrap_or(json!({}));
    let mut out = json!({
        "videoId": doc["videoId"],
        "title": doc["title"],
        "artist": doc["artist"],
        "thumbnail": doc["thumbnail"],
        "durationMs": doc["durationMs"],
        "s3Url": doc["s3Url"],
    });
    if let Some(w) = doc.get("waveform").filter(|w| !w.is_null()) {
        out["waveform"] = w.clone();
    }
    out
}

fn shaped(doc_json: String) -> Response {
    let body = serde_json::to_string(&shaped_value(doc_json)).unwrap_or_default();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body))
        .unwrap()
}

fn err_json(status: u16, msg: &str) -> Response {
    let code = StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        code,
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_string(&json!({ "error": msg })).unwrap_or_default(),
    )
        .into_response()
}
