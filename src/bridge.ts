// SAPI bridge (frontend side): the Rust pipe server (pipe_server.rs) relays each
// Kindle synth request to the webview as a `synth-request` event; we synthesize
// raw PCM with kokoro-js (WebGPU) and hand the bytes back via `synth_result`,
// which Rust writes over the named pipe. Lets the in-Kindle SAPI engine narrate
// with the same WebGPU engine the reader app uses.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { initTTS, synthesizeRaw } from "./tts";
import { loadVoice } from "./voices";

// `rate` is the host's (Kindle's) rate-derived speed multiplier. The narrator,
// the user's speed multiplier and gain all live in this webview's localStorage —
// the same keys the reader UI writes (see App.tsx) — so the engine no longer
// carries them over the pipe (see WorkerProtocol.h).
type SynthRequest = { id: number; text: string; rate: number };

// Read a persisted numeric setting, clamped, falling back to `def` if unset/NaN.
function loadNum(key: string, def: number, lo: number, hi: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? "");
  return Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : def;
}

let started = false;

/** Begin serving SAPI synth requests. Idempotent. */
export function startSapiBridge() {
  if (started) return;
  started = true;
  // Warm the model so the first Kindle request isn't slow.
  initTTS(() => {});
  void listen<SynthRequest>("synth-request", async (e) => {
    const { id, text, rate } = e.payload;
    // Fold the user's own settings (localStorage) over the host's live rate.
    const voice = loadVoice();
    const speed = rate * loadNum("tts-speed", 1, 0.5, 2);
    const gain = loadNum("tts-gain", 1, 0, 2);
    try {
      const { audio } = await synthesizeRaw(text, voice, speed);
      if (gain !== 1) for (let i = 0; i < audio.length; i++) audio[i] *= gain;
      // Raw little-endian f32 bytes; Rust reinterprets as the sample buffer.
      const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
      await invoke("synth_result", { id, pcm: bytes });
    } catch (err) {
      console.error("[bridge] synth failed:", err);
      await invoke("synth_result", { id, pcm: new Uint8Array(0) });
    }
  });
}
