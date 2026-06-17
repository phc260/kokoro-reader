# kokoro-reader

Local, offline text-to-speech built on [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX),
with **one** synthesis engine — [`kokoro-js`](https://www.npmjs.com/package/kokoro-js)
on **WebGPU**, in a Tauri webview — serving two front ends:

1. **A desktop reader app** (Tauri 2 + React) — paste text, pick a narrator, listen.
2. **A SAPI5 voice for Windows** — "Kokoro (SAPI5)" appears in the system voice
   list, so apps like **Kindle for PC Read Aloud** narrate books with Kokoro. A
   thin **x86** COM DLL that Kindle loads in-process forwards each utterance over
   a named pipe to the running app, which synthesizes on the GPU and returns
   audio.

```
Kindle.exe (x86, MSIX)                         kokoro-reader app (Tauri 2, x64)
  │ classic SAPI5 (ISpVoice)                      React UI ──┐
  ▼  loads in-process via COM                                │ kokoro-js on WebGPU
KokoroSapi.dll  (x86 SAPI shim, connect-only)     webview ◀──┘   (the one engine)
  │  named pipe \\.\pipe\KokoroSapiSynth             ▲ synth-request / synth_result
  └──────────────────────────────────────────▶ Rust pipe_server.rs
                                                    └ also: download + serve model
                                                      (app-data dir, kokoro:// scheme)
```

The app's webview is the **only** place audio is produced. The Rust backend
downloads the model on first run, serves it to the webview, and hosts the named
pipe that bridges Kindle's SAPI engine to that webview. **The app must be running
for Kindle to speak.**

## How Kindle reads with Kokoro (the engine chain)

The trick is letting a 32-bit app drive GPU TTS that lives in a *different*,
64-bit process. It does **not** connect to anything in the networking sense —
COM loads our DLL straight into Kindle and calls its functions:

1. **SAPI5 is a registry-discovered COM plugin.** `DllRegisterServer` (`Dll.cpp`)
   writes `CLSID\{guid}\InprocServer32` → the DLL's path, and a voice token
   `…\Speech\Voices\Tokens\KokoroTTS` whose `CLSID` points back at that GUID. The
   32-bit `regsvr32` lands these in `WOW6432Node`, the view 32-bit Kindle reads.
2. **Kindle loads the DLL in-process.** It resolves its default voice token →
   CLSID → `CoCreateInstance(CLSCTX_INPROC_SERVER)` → COM `LoadLibrary`s
   `KokoroSapi.dll` into *Kindle's* address space and calls `ISpTTSEngine::Speak`.
   This is why the engine **must be x86** (matching Kindle) and a native COM DLL —
   a webview/JS thing can't be loaded this way, and it can't be merged into the
   x64 app.
3. **The DLL is a thin shim → the app.** `Speak` splits the text into chunks and,
   over the pipe `\\.\pipe\KokoroSapiSynth` (`WorkerProtocol.h`), asks the running
   app to synthesize each (`'S'` = `[speed][voice][text]` → `[nSamples][f32]`).
   `pipe_server.rs` relays to the webview, kokoro-js renders on **WebGPU**, and the
   PCM comes back and is written to Kindle's audio site.
4. **Default-voice selection (MSIX).** Kindle plays whichever token equals
   `DefaultTokenId` — and because it's sandboxed, that value lives in its
   **private hive** (`…\Packages\AMZNKindle…\SystemAppData\Helium\User.dat`), not
   real HKCU. Point it at Kokoro: stop Kindle, `reg load` the hive, set
   `Software\Microsoft\Speech\Voices\DefaultTokenId` to the `KokoroTTS` token,
   `reg unload`.

**Streaming.** `Speak` synthesizes **sentence by sentence** — a small first chunk
(fast first sound) then 4-sentence chunks — with a **depth-1 prefetch pipeline**:
chunk N+1 synthesizes on a background thread while chunk N streams to the host in
~250 ms blocks. So there's no gap at chunk boundaries and `SPVES_ABORT` stops
playback promptly. (Gaps *between Kindle pages* are Kindle's own page-turn time —
each page is a fresh `Speak` whose text we can't see in advance.)

## Layout

| Path | What |
|---|---|
| `src/` | React frontend; `tts.worker.ts` (kokoro-js Web Worker), `tts.ts` (client; `synthesize` / `synthesizeRaw`), `bridge.ts` (SAPI bridge listener), `voices.ts` |
| `src-tauri/src/lib.rs` | Model download/verify + `kokoro://` asset server |
| `src-tauri/src/pipe_server.rs` | Named-pipe server bridging the SAPI engine to webview synthesis |
| `src-tauri/model-manifest.json` | Files the app downloads from HF (paths + sizes + SHA-256); kept in sync with `src/voices.ts` |
| `kokoro-sapi/src/` | The x86 SAPI engine: `Dll.cpp`, `KokoroTTSEngine.cpp`, `WorkerClient.cpp`, `WorkerProtocol.h` (thin COM shim + pipe client, no deps) |
| `kokoro-sapi/build.ps1` | Builds the x86 engine (NMake via vcvarsall) |
| `kokoro-sapi/*.ps1` | `test-speak.ps1` (SAPI smoke test), `kindle-voice-guard.ps1` (hive patch), `switch-voice.ps1` |

## Building

Prerequisites: [bun](https://bun.sh), Rust, and (for the SAPI voice) Visual
Studio with the **x86** MSVC toolchain + CMake.

```powershell
# Reader app
bun install
bun run tauri dev        # also serves the SAPI pipe while running

# SAPI engine (x86) — thin shim, no third-party deps
.\kokoro-sapi\build.ps1

# Register the voice (ELEVATED prompt; the 32-bit regsvr32 is the one that matters)
C:\Windows\SysWOW64\regsvr32.exe "kokoro-sapi\build\KokoroSapi.dll"
```

The TTS model (~430 MB: `onnx/model.onnx` for WebGPU, `onnx/model_quantized.onnx`
for the wasm fallback, voices, config/tokenizer) is **downloaded by the app** on
first run into its app-data dir — there's a setup wizard; no manual asset step.

## Kindle for PC notes

- Kindle is **32-bit MSIX**; the engine must be x86, registered under
  `WOW6432Node` (the 32-bit `regsvr32` does this), and its default voice patched
  in the package hive (above). `kindle-voice-guard.ps1` re-applies the patch if a
  Kindle update resets it.
- **The app must be running** when Kindle reads — it's the synthesizer. If it
  isn't, the voice is silent (the shim has no local fallback by design).
- Don't move/delete `kokoro-sapi/` — the registered token references the DLL by
  path.
