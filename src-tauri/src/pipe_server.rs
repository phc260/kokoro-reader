// Named-pipe server that bridges the SAPI engine (running inside Kindle) to
// WebGPU synthesis in the app's webview. The x86 KokoroSapi.dll connects to
// \\.\pipe\KokoroSapiSynth and speaks the protocol in
// kokoro-sapi/src/WorkerProtocol.h ('S' = synth whole utterance, 'I' = info).
//
// This end now owns all chunking: a single 'S' request carries the whole
// utterance; we split it into sentence chunks, synthesize each in the frontend
// (kokoro-js on WebGPU) via the `synth-request` event with a depth-1 prefetch
// pipeline, and stream the PCM back to the engine frame by frame
// ([nSamples][gain][samples...], then a kStreamEnd / kSynthError marker). The
// engine is a pure sink that pumps frames to the SAPI site and aborts by closing
// the pipe. Gain (per chunk) and the per-chunk sentence count are read from the
// webview's localStorage via the `gain-request` / `chunk-request` events.
//
// While the app is running it owns the pipe, replacing the native worker.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};
use tokio::sync::oneshot;

const PIPE_NAME: &str = r"\\.\pipe\KokoroSapiSynth";
const CMD_SYNTH: u8 = b'S';
const CMD_INFO: u8 = b'I';
// Frame-stream markers (must match WorkerProtocol.h). A leading u32 >= STREAM_END
// is a control marker, never a real sample count.
const STREAM_END: u32 = 0xFFFF_FFFE;
const SYNTH_ERROR: u32 = 0xFFFF_FFFF;
const MAX_TEXT: u32 = 1 << 20;
const SYNTH_TIMEOUT: Duration = Duration::from_secs(120);
// The gain query just reads localStorage in the webview, so it's quick; if the
// frontend doesn't answer promptly we fall back to unity rather than stall audio.
const GAIN_TIMEOUT: Duration = Duration::from_secs(2);
// Same idea for the per-chunk sentence count; fall back to the default of 4 if
// the frontend is slow/absent.
const CHUNK_TIMEOUT: Duration = Duration::from_secs(2);
const DEFAULT_CHUNK_SENTENCES: u32 = 4;

/// Correlates pipe requests with frontend responses. Shared (via Tauri state)
/// between the pipe-serving tasks and the `synth_result` command.
#[derive(Default)]
pub struct Bridge {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Vec<u8>>>>,
    // Parallel map for `gain-request` round-trips (engine 'G' command). Separate
    // from `pending` because the reply is a single float, not a PCM buffer.
    gain_pending: Mutex<HashMap<u64, oneshot::Sender<f32>>>,
    // Parallel map for `chunk-request` round-trips (engine 'C' command): the
    // per-chunk sentence count, replied as a single u32.
    chunk_pending: Mutex<HashMap<u64, oneshot::Sender<u32>>>,
}

impl Bridge {
    fn register(&self) -> (u64, oneshot::Receiver<Vec<u8>>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        (id, rx)
    }
    fn fulfill(&self, id: u64, pcm: Vec<u8>) {
        if let Some(tx) = self.pending.lock().unwrap().remove(&id) {
            let _ = tx.send(pcm);
        }
    }
    fn cancel(&self, id: u64) {
        self.pending.lock().unwrap().remove(&id);
    }
    fn register_gain(&self) -> (u64, oneshot::Receiver<f32>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.gain_pending.lock().unwrap().insert(id, tx);
        (id, rx)
    }
    fn fulfill_gain(&self, id: u64, gain: f32) {
        if let Some(tx) = self.gain_pending.lock().unwrap().remove(&id) {
            let _ = tx.send(gain);
        }
    }
    fn cancel_gain(&self, id: u64) {
        self.gain_pending.lock().unwrap().remove(&id);
    }
    fn register_chunk(&self) -> (u64, oneshot::Receiver<u32>) {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.chunk_pending.lock().unwrap().insert(id, tx);
        (id, rx)
    }
    fn fulfill_chunk(&self, id: u64, sentences: u32) {
        if let Some(tx) = self.chunk_pending.lock().unwrap().remove(&id) {
            let _ = tx.send(sentences);
        }
    }
    fn cancel_chunk(&self, id: u64) {
        self.chunk_pending.lock().unwrap().remove(&id);
    }
}

#[derive(Clone, Serialize)]
struct SynthRequest {
    id: u64,
    text: String,
    // Host's rate-derived speed multiplier (1 = host normal). The frontend owns
    // the narrator voice + the user's speed/gain (from localStorage) and folds
    // `rate` into the final synthesis speed — see bridge.ts / WorkerProtocol.h.
    rate: f32,
}

/// Backend → frontend: payload of the `gain-request` event; the webview replies
/// with the current "tts-gain" via the `gain_result` command, keyed by `id`.
#[derive(Clone, Serialize)]
struct GainRequest {
    id: u64,
}

/// Backend → frontend: payload of the `chunk-request` event; the webview replies
/// with the current "tts-chunk" via the `chunk_result` command, keyed by `id`.
#[derive(Clone, Serialize)]
struct ChunkRequest {
    id: u64,
}

/// Frontend → backend: raw little-endian f32 PCM (24 kHz mono) for request `id`.
#[tauri::command]
pub fn synth_result(app: AppHandle, id: u64, pcm: Vec<u8>) {
    app.state::<Arc<Bridge>>().fulfill(id, pcm);
}

/// Frontend → backend: answer to a `gain-request` (current "tts-gain").
#[tauri::command]
pub fn gain_result(app: AppHandle, id: u64, gain: f32) {
    app.state::<Arc<Bridge>>().fulfill_gain(id, gain);
}

/// Frontend → backend: answer to a `chunk-request` (current "tts-chunk").
#[tauri::command]
pub fn chunk_result(app: AppHandle, id: u64, sentences: u32) {
    app.state::<Arc<Bridge>>().fulfill_chunk(id, sentences);
}

/// Split an utterance into sentence chunks for streaming. We ramp up: the FIRST
/// chunk is a single sentence (so audio starts quickly), then chunks coalesce
/// `sentences_per_chunk` sentences each (fewer round-trips / inter-chunk seams).
/// Boundaries are `. ! ?` (followed by whitespace / a closing quote / end) and
/// newlines; decimals ("3.14") and ellipses are not boundaries. A single sentence
/// that runs past `SOFT_CAP` is split at its last clause boundary (`, ; :`) so a
/// run-on breaks at a natural pause; only if it has no clause boundary at all does
/// it fall back to a word break past `HARD_CAP`. The frontend (kokoro-js)
/// sub-splits anything past its token limit anyway. Ported from the old
/// KokoroTTSEngine.cpp `SplitText`; operates on chars (Unicode scalars).
fn split_text(text: &str, sentences_per_chunk: usize) -> Vec<String> {
    const FIRST_SENTENCES: usize = 1; // small first chunk -> each page starts fast
    let k_sentences = sentences_per_chunk.max(1); // 0 would never flush
    const SOFT_CAP: usize = 400; // over-long sentence: break at a clause (, ; :)
    const HARD_CAP: usize = 2000; // last resort (no clause found: word boundary)

    let c: Vec<char> = text.chars().collect();
    let n = c.len();
    let mut chunks: Vec<String> = Vec::new();

    let is_space =
        |ch: char| matches!(ch, ' ' | '\t' | '\r' | '\n' | '\u{0C}' | '\u{0B}');
    let is_digit = |ch: char| ch.is_ascii_digit();
    // closing quotes/brackets, incl. curly ” ’
    let is_closer =
        |ch: char| matches!(ch, '"' | '\'' | ')' | ']' | '}' | '\u{201D}' | '\u{2019}');

    // `sentence_start` tracks the in-progress sentence so the caps measure one
    // sentence, not the whole multi-sentence chunk. `last_clause` is the position
    // just after the most recent `, ; :` in that sentence — the preferred split
    // point for an over-long one.
    let mut start = 0usize;
    let mut sentences = 0usize;
    let mut sentence_start = 0usize;
    let mut last_clause = 0usize;

    // flush takes the mutable state by ref to dodge closure/borrow conflicts.
    let flush = |chunks: &mut Vec<String>,
                 start: &mut usize,
                 sentences: &mut usize,
                 sentence_start: &mut usize,
                 last_clause: &mut usize,
                 end: usize| {
        let mut a = *start;
        let mut b = end;
        while a < b && is_space(c[a]) {
            a += 1;
        }
        while b > a && is_space(c[b - 1]) {
            b -= 1;
        }
        if b > a {
            chunks.push(c[a..b].iter().collect());
        }
        *start = end;
        *sentences = 0;
        *sentence_start = end;
        *last_clause = 0;
    };

    let mut i = 0usize;
    while i < n {
        let ch = c[i];

        // Find a sentence/paragraph boundary at i; boundary_end = position after it.
        let mut boundary_end = 0usize;
        if ch == '\n' {
            boundary_end = i + 1;
        } else if ch == '.' || ch == '!' || ch == '?' {
            let mut is_boundary = true;
            if ch == '.' {
                let decimal =
                    i > 0 && is_digit(c[i - 1]) && i + 1 < n && is_digit(c[i + 1]);
                let ellipsis =
                    (i + 1 < n && c[i + 1] == '.') || (i > 0 && c[i - 1] == '.');
                if decimal || ellipsis {
                    is_boundary = false;
                }
            }
            if is_boundary {
                let mut j = i + 1; // swallow trailing terminators + closers (?!" or .")
                while j < n
                    && (c[j] == '.' || c[j] == '!' || c[j] == '?' || is_closer(c[j]))
                {
                    j += 1;
                }
                if j >= n || is_space(c[j]) {
                    boundary_end = j;
                }
            }
        }

        if boundary_end != 0 {
            // Count the sentence; emit once we've collected `target` of them.
            sentences += 1;
            let target = if chunks.is_empty() { FIRST_SENTENCES } else { k_sentences };
            if sentences >= target {
                flush(
                    &mut chunks,
                    &mut start,
                    &mut sentences,
                    &mut sentence_start,
                    &mut last_clause,
                    boundary_end,
                );
                i = start;
            } else {
                i = boundary_end;
                sentence_start = boundary_end; // next sentence begins here
                last_clause = 0;
            }
            continue;
        }

        // Remember clause boundaries (`, ; :` before whitespace / end) as
        // candidate split points for an over-long sentence.
        if (ch == ',' || ch == ';' || ch == ':') && (i + 1 >= n || is_space(c[i + 1])) {
            last_clause = i + 1;
        }

        // The current sentence has run long: prefer to break at its last clause
        // boundary; fall back to a word break only if it has none (HARD_CAP).
        if i - sentence_start >= SOFT_CAP && last_clause > sentence_start {
            let at = last_clause; // copy: can't pass &mut last_clause and it by value
            flush(
                &mut chunks,
                &mut start,
                &mut sentences,
                &mut sentence_start,
                &mut last_clause,
                at,
            );
            i = start;
            continue;
        }
        if i - sentence_start >= HARD_CAP {
            // no clause break: cut on a word boundary
            let mut brk = i;
            while brk > start && !is_space(c[brk - 1]) {
                brk -= 1;
            }
            if brk <= start {
                brk = i; // one long token: hard cut
            }
            flush(
                &mut chunks,
                &mut start,
                &mut sentences,
                &mut sentence_start,
                &mut last_clause,
                brk,
            );
            i = start;
            continue;
        }
        i += 1;
    }
    flush(
        &mut chunks,
        &mut start,
        &mut sentences,
        &mut sentence_start,
        &mut last_clause,
        n,
    ); // trailing text
    chunks
}

/// Ask the webview for the current per-chunk sentence count ("tts-chunk"); fall
/// back to the default so a slow/absent frontend doesn't stall the start of
/// synthesis. Clamped 1..=8.
async fn query_chunk_sentences(app: &AppHandle, bridge: &Arc<Bridge>) -> usize {
    let (id, rx) = bridge.register_chunk();
    let _ = app.emit("chunk-request", ChunkRequest { id });
    let s = match tokio::time::timeout(CHUNK_TIMEOUT, rx).await {
        Ok(Ok(s)) => s,
        _ => {
            bridge.cancel_chunk(id);
            DEFAULT_CHUNK_SENTENCES
        }
    };
    s.clamp(1, 8) as usize
}

/// Ask the webview for the user's current gain ("tts-gain"); unity on miss. Read
/// fresh per chunk so a slider move lands within the playing chunk.
async fn query_gain(app: &AppHandle, bridge: &Arc<Bridge>) -> f32 {
    let (id, rx) = bridge.register_gain();
    let _ = app.emit("gain-request", GainRequest { id });
    match tokio::time::timeout(GAIN_TIMEOUT, rx).await {
        Ok(Ok(g)) => g,
        _ => {
            bridge.cancel_gain(id);
            1.0
        }
    }
}

/// Synthesize one chunk in the webview, as a detached task so it overlaps the
/// (backpressured) write of the previous chunk's frame — that's the depth-1
/// prefetch the engine used to do. Returns the raw f32 PCM bytes, or None on
/// timeout/failure.
fn spawn_synth(
    app: AppHandle,
    bridge: Arc<Bridge>,
    text: String,
    rate: f32,
) -> tauri::async_runtime::JoinHandle<Option<Vec<u8>>> {
    tauri::async_runtime::spawn(async move {
        let (id, rx) = bridge.register();
        let _ = app.emit("synth-request", SynthRequest { id, text, rate });
        match tokio::time::timeout(SYNTH_TIMEOUT, rx).await {
            Ok(Ok(pcm)) => Some(pcm),
            _ => {
                bridge.cancel(id);
                None
            }
        }
    })
}

/// Spawn the pipe server on the async runtime. Call once from `setup`.
pub fn start(app: AppHandle) {
    let bridge = app.state::<Arc<Bridge>>().inner().clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve_loop(app, bridge).await {
            eprintln!("[pipe] server stopped: {e}");
        }
    });
}

async fn serve_loop(app: AppHandle, bridge: Arc<Bridge>) -> std::io::Result<()> {
    let mut first = true;
    loop {
        // first_pipe_instance fails if another server already owns the name
        // (e.g. the native worker or a second app instance) — surfaced via `?`.
        let server = ServerOptions::new()
            .first_pipe_instance(first)
            .create(PIPE_NAME)?;
        first = false;
        server.connect().await?; // a client (the SAPI engine) connected
        let app = app.clone();
        let bridge = bridge.clone();
        tauri::async_runtime::spawn(async move {
            // EOF / broken pipe on disconnect is normal; ignore.
            let _ = serve_client(server, app, bridge).await;
        });
    }
}

async fn serve_client(
    mut pipe: NamedPipeServer,
    app: AppHandle,
    bridge: Arc<Bridge>,
) -> std::io::Result<()> {
    loop {
        let mut cmd = [0u8; 1];
        pipe.read_exact(&mut cmd).await?;
        match cmd[0] {
            CMD_INFO => {
                let json = br#"{"provider":"WebGPU(app)","voice":""}"#;
                pipe.write_all(&(json.len() as u16).to_le_bytes()).await?;
                pipe.write_all(json).await?;
            }
            CMD_SYNTH => {
                let mut b4 = [0u8; 4];
                pipe.read_exact(&mut b4).await?;
                let rate = f32::from_le_bytes(b4);
                pipe.read_exact(&mut b4).await?;
                let tlen = u32::from_le_bytes(b4);
                if tlen == 0 || tlen > MAX_TEXT {
                    return Ok(());
                }
                let mut tbuf = vec![0u8; tlen as usize];
                pipe.read_exact(&mut tbuf).await?;
                let text = String::from_utf8_lossy(&tbuf).into_owned();

                // We own the chunking now: split the whole utterance, then stream
                // each chunk's PCM back as a frame ([nSamples][gain][samples...]).
                let per_chunk = query_chunk_sentences(&app, &bridge).await;
                let chunks = split_text(&text, per_chunk);
                if chunks.is_empty() {
                    pipe.write_all(&STREAM_END.to_le_bytes()).await?;
                    continue;
                }

                // Depth-1 prefetch: synth chunk k+1 (detached) while we stream k.
                // The pipe's buffer fills mid-write and blocks, which is the
                // backpressure that bounds how far ahead we synthesize. An abort
                // shows up here as a broken-pipe write error (`?`), unwinding the
                // loop; the in-flight task is dropped.
                let mut pending =
                    Some(spawn_synth(app.clone(), bridge.clone(), chunks[0].clone(), rate));
                let mut failed = false;
                for k in 0..chunks.len() {
                    let pcm = pending.take().unwrap().await.ok().flatten();
                    if k + 1 < chunks.len() {
                        pending = Some(spawn_synth(
                            app.clone(),
                            bridge.clone(),
                            chunks[k + 1].clone(),
                            rate,
                        ));
                    }
                    let pcm = match pcm {
                        Some(pcm) => pcm,
                        None => {
                            failed = true;
                            break;
                        }
                    };
                    // Read gain just before the frame ships (≈ when the engine
                    // plays it) so a slider move isn't frozen into prefetched PCM.
                    let gain = query_gain(&app, &bridge).await;
                    let n = (pcm.len() / 4) as u32; // bytes -> f32 sample count
                    pipe.write_all(&n.to_le_bytes()).await?;
                    pipe.write_all(&gain.to_le_bytes()).await?;
                    if n > 0 {
                        pipe.write_all(&pcm).await?;
                    }
                }
                let marker = if failed { SYNTH_ERROR } else { STREAM_END };
                pipe.write_all(&marker.to_le_bytes()).await?;
            }
            _ => return Ok(()), // unknown command: drop the client
        }
    }
}
