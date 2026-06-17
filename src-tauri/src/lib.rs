use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

mod pipe_server;

// ---------------------------------------------------------------------------
// Kokoro TTS model: downloaded into the app data dir on first run, then served
// to the webview worker through the `kokoro://` URI scheme (see `run`). The
// model is Apache-2.0.
//
// The file list (paths, sizes, SHA-256) lives in model-manifest.json, embedded
// at build time. The voice entries there must stay in sync with VOICES in
// src/voices.ts. Regenerate the manifest from the HuggingFace tree API if the
// pinned model ever changes.
// ---------------------------------------------------------------------------

const MANIFEST_JSON: &str = include_str!("../model-manifest.json");

#[derive(Deserialize)]
struct Manifest {
    base_url: String,
    model_id: String,
    files: Vec<ManifestFile>,
}

#[derive(Deserialize)]
struct ManifestFile {
    // Repo-relative path, e.g. "onnx/model.onnx" or "voices/af_heart.bin".
    path: String,
    size: u64,
    // Lowercase hex SHA-256 of the file's contents.
    sha256: String,
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    downloaded: u64,
    total: u64,
    file: String,
}

fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir)
}

fn load_manifest() -> Result<Manifest, String> {
    serde_json::from_str(MANIFEST_JSON).map_err(|e| format!("bad model manifest: {e}"))
}

// On-disk location of a manifest file, under model_dir()/<model_id>/<path> — the
// same layout the `kokoro://` handler serves and that transformers.js requests.
fn model_file_path(dir: &Path, model_id: &str, rel: &str) -> PathBuf {
    dir.join(model_id).join(rel)
}

// Lowercase hex SHA-256 of `bytes`.
fn hex_sha256(digest: impl AsRef<[u8]>) -> String {
    digest.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

// Whether `path` exists with the expected byte length. Cheap (metadata only), so
// it's used as the readiness check on every launch (see `model_exists`). A
// final-named file only ever exists after a verified download (download_model
// renames into place only once the SHA-256 matches), so size is a sufficient
// guard against a truncated/clobbered file without re-hashing on startup.
fn file_present(path: &Path, size: u64) -> bool {
    std::fs::metadata(path)
        .map(|m| m.len() == size)
        .unwrap_or(false)
}

// Whether every file in the manifest is present on disk (the model is usable).
fn model_is_complete(dir: &Path, manifest: &Manifest) -> bool {
    manifest
        .files
        .iter()
        .all(|f| file_present(&model_file_path(dir, &manifest.model_id, &f.path), f.size))
}

// Whether `path` already holds the expected file: a cheap size check first, then
// a full SHA-256. Used during a download to decide if a file can be kept as-is
// (resume), so hashing the large onnx only happens while recovering a download.
fn file_is_valid(path: &Path, size: u64, sha256: &str) -> bool {
    if !file_present(path, size) {
        return false;
    }
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        match file.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => hasher.update(&buf[..n]),
            Err(_) => return false,
        }
    }
    hex_sha256(hasher.finalize()) == sha256
}

// Whether the TTS model has been fully downloaded (gates the setup screen).
// Checks that every manifest file is present on disk, rather than trusting a
// single status flag.
#[tauri::command]
fn model_exists(app: AppHandle) -> bool {
    let Ok(dir) = model_dir(&app) else {
        return false;
    };
    let Ok(manifest) = load_manifest() else {
        return false;
    };
    model_is_complete(&dir, &manifest)
}

// Absolute path of the directory the model/voice files are downloaded into
// (shown on the setup screen). The directory is created if missing so the setup
// screen's "open folder" link works even before the first download.
#[tauri::command]
fn model_location(app: AppHandle) -> Result<String, String> {
    let dir = model_dir(&app)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.to_string_lossy().into_owned())
}

#[derive(Serialize)]
struct VerifyResult {
    checked: usize,
    valid: usize,
    // Manifest paths that were missing or failed verification (and were removed).
    repaired: Vec<String>,
}

// Full integrity check: hash every model file against its manifest SHA-256 and
// delete any that are missing or corrupt, so a follow-up `download_model`
// re-fetches just those (resume). Unlike `model_exists` (cheap, runs every
// launch) this is opt-in, so paying to hash ~400 MB is acceptable; it runs on a
// blocking thread to avoid stalling the async runtime / UI.
#[tauri::command]
async fn verify_model(app: AppHandle) -> Result<VerifyResult, String> {
    let dir = model_dir(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let manifest = load_manifest()?;
        let mut repaired = Vec::new();
        for f in &manifest.files {
            let path = model_file_path(&dir, &manifest.model_id, &f.path);
            if !file_is_valid(&path, f.size, &f.sha256) {
                let _ = std::fs::remove_file(&path);
                repaired.push(f.path.clone());
            }
        }
        let checked = manifest.files.len();
        Ok(VerifyResult {
            checked,
            valid: checked - repaired.len(),
            repaired,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Download the Kokoro model + curated voice packs into the app data dir,
// emitting `model-download-progress` as bytes arrive. Each file is verified
// against its manifest SHA-256 before being committed. Idempotent and
// resumable: returns early if every file is already present, and on a re-run
// skips files already on disk that verify, re-fetching only the rest. The
// webview (WebGPU) and the SAPI bridge both read these files.
#[tauri::command]
async fn download_model(app: AppHandle) -> Result<(), String> {
    let dir = model_dir(&app)?;
    let manifest = load_manifest()?;
    if model_is_complete(&dir, &manifest) {
        return Ok(());
    }

    let client = reqwest::Client::new();

    // Total is known from the manifest — no HEAD pass needed.
    let total: u64 = manifest.files.iter().map(|f| f.size).sum();
    let mut downloaded: u64 = 0;

    for f in &manifest.files {
        let dest = model_file_path(&dir, &manifest.model_id, &f.path);

        // Resume: a previously-downloaded file that still verifies is kept.
        if file_is_valid(&dest, f.size, &f.sha256) {
            downloaded += f.size;
            let _ = app.emit(
                "model-download-progress",
                DownloadProgress {
                    downloaded,
                    total,
                    file: f.path.clone(),
                },
            );
            continue;
        }

        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let part = dest.with_extension("part");
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        let mut hasher = Sha256::new();

        let url = format!("{}/{}", manifest.base_url, f.path);
        let resp = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("GET {url} failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("GET {url} failed: {e}"))?;
        let mut stream = resp.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("stream {url} failed: {e}"))?;
            hasher.update(&chunk);
            file.write_all(&chunk).map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;
            let _ = app.emit(
                "model-download-progress",
                DownloadProgress {
                    downloaded,
                    total,
                    file: f.path.clone(),
                },
            );
        }
        file.flush().map_err(|e| e.to_string())?;
        drop(file);

        // Verify before committing; a corrupt/truncated download is discarded
        // (never renamed into place) so a retry re-fetches it.
        let got = hex_sha256(hasher.finalize());
        if got != f.sha256 {
            let _ = std::fs::remove_file(&part);
            return Err(format!(
                "checksum mismatch for {}: expected {}, got {got}",
                f.path, f.sha256
            ));
        }
        std::fs::rename(&part, &dest).map_err(|e| e.to_string())?;
    }

    Ok(())
}

fn content_type(path: &str) -> &'static str {
    if path.ends_with(".json") {
        "application/json"
    } else {
        "application/octet-stream"
    }
}

// Parse a single-range `Range` header (`bytes=START-END`, open-ended, or suffix
// `bytes=-N`) into an inclusive (start, end) within `len`. None = unsatisfiable.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    if len == 0 {
        return None;
    }
    let spec = header.strip_prefix("bytes=")?;
    let (s, e) = spec.split_once('-')?;
    if s.is_empty() {
        let n: u64 = e.parse().ok()?;
        return Some((len.saturating_sub(n), len - 1));
    }
    let start: u64 = s.parse().ok()?;
    let end: u64 = if e.is_empty() {
        len - 1
    } else {
        e.parse::<u64>().ok()?.min(len - 1)
    };
    if start > end || start >= len {
        return None;
    }
    Some((start, end))
}

// `kokoro://` handler: serve a downloaded model file from the app data dir.
// transformers.js (and WebView2) may issue Range requests for the large onnx
// files, so honour them; CORS is opened up since the worker fetches cross-origin.
fn serve_model_file(
    app: &AppHandle,
    request: tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let cors = |b: tauri::http::response::Builder| {
        b.header("Access-Control-Allow-Origin", "*")
            .header("Access-Control-Allow-Methods", "GET, OPTIONS")
            .header("Access-Control-Allow-Headers", "Range, Content-Type")
    };
    let not_found = || {
        cors(tauri::http::Response::builder().status(404))
            .body(Vec::new())
            .unwrap()
    };
    // The worker fetches cross-origin (app origin → kokoro.localhost); a Range
    // request is non-simple, so the webview may preflight. Answer OPTIONS here.
    if request.method() == tauri::http::Method::OPTIONS {
        return cors(tauri::http::Response::builder().status(204))
            .body(Vec::new())
            .unwrap();
    }
    let Ok(dir) = model_dir(app) else {
        return not_found();
    };
    let rel = request.uri().path().trim_start_matches('/');
    if rel.is_empty() || rel.contains("..") {
        return not_found();
    }
    let file_path: PathBuf = dir.join(Path::new(rel));
    let Ok(mut file) = std::fs::File::open(&file_path) else {
        return not_found();
    };
    let Ok(meta) = file.metadata() else {
        return not_found();
    };
    let len = meta.len();
    let ctype = content_type(rel);

    if let Some(range) = request.headers().get("range").and_then(|v| v.to_str().ok()) {
        if let Some((start, end)) = parse_range(range, len) {
            let count = (end - start + 1) as usize;
            let mut buf = vec![0u8; count];
            if file.seek(SeekFrom::Start(start)).is_ok() && file.read_exact(&mut buf).is_ok() {
                return cors(
                    tauri::http::Response::builder()
                        .status(206)
                        .header("Content-Type", ctype)
                        .header("Accept-Ranges", "bytes")
                        .header("Content-Range", format!("bytes {start}-{end}/{len}")),
                )
                .body(buf)
                .unwrap();
            }
        }
    }

    let mut buf = Vec::with_capacity(len as usize);
    if file.read_to_end(&mut buf).is_err() {
        return not_found();
    }
    cors(
        tauri::http::Response::builder()
            .status(200)
            .header("Content-Type", ctype)
            .header("Accept-Ranges", "bytes"),
    )
    .body(buf)
    .unwrap()
}

// Directory the SAPI engine reads its assets/controls from — the AssetDir on the
// registered voice token (written by DllRegisterServer into the 32-bit registry
// view that Kindle reads).
#[cfg(windows)]
fn sapi_asset_dir() -> Result<PathBuf, String> {
    use winreg::enums::HKEY_LOCAL_MACHINE;
    use winreg::RegKey;
    let attrs = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\WOW6432Node\Microsoft\Speech\Voices\Tokens\KokoroTTS\Attributes")
        .map_err(|_| "Kokoro SAPI voice is not registered".to_string())?;
    let dir: String = attrs
        .get_value("AssetDir")
        .map_err(|_| "voice token has no AssetDir".to_string())?;
    Ok(PathBuf::from(dir))
}

#[cfg(not(windows))]
fn sapi_asset_dir() -> Result<PathBuf, String> {
    Err("the SAPI voice is Windows-only".into())
}

// Write the SAPI engine's runtime controls (narrator / speed multiplier / volume
// gain) to controls.ini in its AssetDir, so the in-Kindle engine picks them up on
// its next utterance. Written atomically (temp + rename) so the engine, which
// re-reads the file every Speak, never sees a partial update.
#[tauri::command]
fn set_controls(voice: String, speed: f32, gain: f32) -> Result<(), String> {
    let dir = sapi_asset_dir()?;
    let body = format!("voice={voice}\nspeed={speed}\ngain={gain}\n");
    let dest = dir.join("controls.ini");
    let tmp = dir.join("controls.ini.tmp");
    std::fs::write(&tmp, body).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

// Seed the bundled default controls.ini into the engine's AssetDir on startup,
// so a fresh install has a sane narrator/speed/gain before the user ever touches
// the sliders. Non-destructive: skips if a controls.ini already exists (that's
// the user's saved state) and is best-effort — if the voice isn't registered or
// the resource can't be resolved, the engine just falls back to its own defaults.
fn seed_controls(app: &AppHandle) {
    let Ok(dir) = sapi_asset_dir() else { return };
    let dest = dir.join("controls.ini");
    if dest.exists() {
        return;
    }
    let Ok(src) = app
        .path()
        .resolve("resources/controls.ini", tauri::path::BaseDirectory::Resource)
    else {
        return;
    };
    if let Some(parent) = dest.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = std::fs::copy(&src, &dest) {
        eprintln!("[controls] seed skipped: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Shared state + named-pipe server bridging Kindle's SAPI engine to
        // webview WebGPU synthesis (see pipe_server.rs).
        .manage(std::sync::Arc::new(pipe_server::Bridge::default()))
        .setup(|app| {
            seed_controls(app.handle());
            pipe_server::start(app.handle().clone());
            Ok(())
        })
        .register_uri_scheme_protocol("kokoro", |ctx, request| {
            serve_model_file(ctx.app_handle(), request)
        })
        .invoke_handler(tauri::generate_handler![
            model_exists,
            model_location,
            download_model,
            verify_model,
            set_controls,
            pipe_server::synth_result
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
