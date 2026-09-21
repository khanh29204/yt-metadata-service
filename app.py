"""yt-metadata-service — backend lấy metadata YouTube Music.

Thay thế bản Rust (rusty_ytdl bị YouTube chặn decipher signature):
dùng yt-dlp CLI có sẵn trên máy — tự xử lý cipher + PO token.

API (giữ nguyên contract như bản Rust cũ):
  GET /api/v1/audio-url?url=<link>
    -> {success, data: {title, author, thumbnail, duration_ms, direct_url}, error}
"""

import json
import subprocess

from fastapi import FastAPI, Query
from fastapi.responses import JSONResponse

app = FastAPI()

# Audio-only, bitrate 64–128 kbps
MIN_ABR_KBPS = 64
MAX_ABR_KBPS = 128


def probe(url: str) -> tuple[dict | None, str]:
    """Chạy yt-dlp -J lấy metadata. Trả (info, stderr) — info None nếu lỗi."""
    try:
        out = subprocess.run(
            [
                "yt-dlp",
                "-J",
                "--no-playlist",
                "--no-warnings",
                url,
            ],
            capture_output=True,
            text=True,
            timeout=60,
            check=True,
        )
        return json.loads(out.stdout), ""
    except subprocess.CalledProcessError as e:
        return None, (e.stderr or "")[-500:]
    except subprocess.TimeoutExpired:
        return None, "yt-dlp timeout 60s"
    except json.JSONDecodeError:
        return None, "yt-dlp output not JSON"


def pick_audio(info: dict) -> dict | None:
    """Chọn audio-only format có abr trong [64, 128] kbps, lấy cao nhất."""
    audio = [
        f
        for f in info.get("formats", [])
        if f.get("acodec") not in (None, "none")
        and f.get("vcodec") in (None, "none")
        and f.get("url")
        and f.get("abr") is not None
        and MIN_ABR_KBPS <= f["abr"] <= MAX_ABR_KBPS
    ]
    # Fallback: audio-only thấp nhất (dưới 128 kbps)
    if not audio:
        audio = [
            f
            for f in info.get("formats", [])
            if f.get("acodec") not in (None, "none")
            and f.get("vcodec") in (None, "none")
            and f.get("url")
            and f.get("abr") is not None
        ]
    return max(audio, key=lambda f: f["abr"]) if audio else None


@app.get("/api/v1/audio-url")
def audio_url(url: str = Query(...)):
    info, stderr = probe(url)
    if info is None:
        return JSONResponse(
            {"success": False, "data": None, "error": f"yt-dlp failed: {stderr}"},
            status_code=502,
        )

    fmt = pick_audio(info)
    if fmt is None:
        return JSONResponse(
            {"success": False, "data": None, "error": "no audio format in 64-128kbps"},
            status_code=404,
        )

    duration_s = info.get("duration") or 0
    abr = fmt.get("abr")
    return {
        "success": True,
        "data": {
            "title": info.get("title", ""),
            "author": info.get("uploader", info.get("channel", "")),
            "thumbnail": info.get("thumbnail", ""),
            "duration_ms": int(duration_s * 1000),
            "direct_url": fmt["url"],
            "audio": {
                "itag": fmt.get("format_id"),
                "ext": fmt.get("ext"),
                "codec": fmt.get("acodec"),
                "bitrate_kbps": round(abr) if abr is not None else None,
                "sample_rate_hz": fmt.get("asr"),
                "filesize_bytes": fmt.get("filesize") or fmt.get("filesize_approx"),
            },
        },
        "error": None,
    }
