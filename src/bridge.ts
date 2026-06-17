// SAPI bridge (frontend side): the Rust pipe server (pipe_server.rs) relays each
// Kindle synth request to the webview as a `synth-request` event; we synthesize
// raw PCM with kokoro-js (WebGPU) and hand the bytes back via `synth_result`,
// which Rust writes over the named pipe. Lets the in-Kindle SAPI engine narrate
// with the same WebGPU engine the reader app uses.
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { initTTS, synthesizeRaw } from "./tts";

type SynthRequest = { id: number; text: string; voice: string; speed: number };

let started = false;

/** Begin serving SAPI synth requests. Idempotent. */
export function startSapiBridge() {
  if (started) return;
  started = true;
  // Warm the model so the first Kindle request isn't slow.
  initTTS(() => {});
  void listen<SynthRequest>("synth-request", async (e) => {
    const { id, text, voice, speed } = e.payload;
    try {
      const { audio } = await synthesizeRaw(text, voice, speed);
      // Raw little-endian f32 bytes; Rust reinterprets as the sample buffer.
      const bytes = new Uint8Array(audio.buffer, audio.byteOffset, audio.byteLength);
      await invoke("synth_result", { id, pcm: bytes });
    } catch (err) {
      console.error("[bridge] synth failed:", err);
      await invoke("synth_result", { id, pcm: new Uint8Array(0) });
    }
  });
}
