// Named-pipe server that bridges the SAPI engine (running inside Kindle) to
// WebGPU synthesis in the app's webview. The x86 KokoroSapi.dll connects to
// \\.\pipe\KokoroSapiSynth and speaks the protocol in
// kokoro-sapi/src/WorkerProtocol.h ('S' = synth, 'I' = info). Each synth request
// is relayed to the frontend (kokoro-js on WebGPU) via the `synth-request`
// event; the frontend returns raw f32 PCM through the `synth_result` command,
// which we write back over the pipe.
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
const SYNTH_ERROR: u32 = 0xFFFF_FFFF;
const MAX_TEXT: u32 = 1 << 20;
const MAX_VOICE: u16 = 64;
const SYNTH_TIMEOUT: Duration = Duration::from_secs(120);

/// Correlates pipe requests with frontend responses. Shared (via Tauri state)
/// between the pipe-serving tasks and the `synth_result` command.
#[derive(Default)]
pub struct Bridge {
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Vec<u8>>>>,
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
}

#[derive(Clone, Serialize)]
struct SynthRequest {
    id: u64,
    text: String,
    voice: String,
    speed: f32,
}

/// Frontend → backend: raw little-endian f32 PCM (24 kHz mono) for request `id`.
#[tauri::command]
pub fn synth_result(app: AppHandle, id: u64, pcm: Vec<u8>) {
    app.state::<Arc<Bridge>>().fulfill(id, pcm);
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
                let mut b2 = [0u8; 2];
                pipe.read_exact(&mut b4).await?;
                let speed = f32::from_le_bytes(b4);
                pipe.read_exact(&mut b2).await?;
                let vlen = u16::from_le_bytes(b2);
                if vlen > MAX_VOICE {
                    return Ok(());
                }
                let mut vbuf = vec![0u8; vlen as usize];
                pipe.read_exact(&mut vbuf).await?;
                let voice = String::from_utf8_lossy(&vbuf).into_owned();
                pipe.read_exact(&mut b4).await?;
                let tlen = u32::from_le_bytes(b4);
                if tlen == 0 || tlen > MAX_TEXT {
                    return Ok(());
                }
                let mut tbuf = vec![0u8; tlen as usize];
                pipe.read_exact(&mut tbuf).await?;
                let text = String::from_utf8_lossy(&tbuf).into_owned();

                let (id, rx) = bridge.register();
                let _ = app.emit("synth-request", SynthRequest { id, text, voice, speed });
                let pcm = match tokio::time::timeout(SYNTH_TIMEOUT, rx).await {
                    Ok(Ok(pcm)) => pcm,
                    _ => {
                        bridge.cancel(id);
                        pipe.write_all(&SYNTH_ERROR.to_le_bytes()).await?;
                        continue;
                    }
                };
                let n = (pcm.len() / 4) as u32; // bytes -> f32 sample count
                pipe.write_all(&n.to_le_bytes()).await?;
                if n > 0 {
                    pipe.write_all(&pcm).await?;
                }
            }
            _ => return Ok(()), // unknown command: drop the client
        }
    }
}
