# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Local, offline Kokoro-82M text-to-speech with a **single synthesis engine** —
`kokoro-js` on **WebGPU**, running in the Tauri app's webview. The app is both:

1. **A reader app** (Tauri 2 + React) — paste/read text, pick a narrator, listen.
2. **The synthesis host for a Windows SAPI5 voice** — "Kokoro (SAPI5)" appears in
   the system voice list so 32-bit hosts like **Kindle for PC Read Aloud** narrate
   with Kokoro. A thin **x86** COM DLL (`KokoroSapi.dll`) that Kindle loads
   in-process is **connect-only**: it forwards each `Speak` over a named pipe to
   the running app, which synthesizes on WebGPU and returns PCM.

All audio is produced in the app's webview; the SAPI engine itself does no
synthesis — it's a thin COM shim + pipe client with no third-party dependencies.
**Consequence: the app must be running for Kindle to speak.**

```
Kindle.exe (x86) ──in-proc COM (LoadLibrary + vtable)──▶ KokoroSapi.dll (x86 shim)
                                                            │ named pipe \\.\pipe\KokoroSapiSynth
                                                            ▼
                          Tauri app (x64): pipe_server.rs ──emit──▶ webview
                                                            ▲          │ kokoro-js (WebGPU)
                                                            └──PCM─────┘  synth_result
```

## Commands

```powershell
# Reader app (bun, never npm)
bun install
bun run tauri dev          # Vite (port 1420) + Tauri shell; also serves the SAPI pipe
bun run build              # tsc + vite build (frontend typecheck + bundle)

# SAPI engine — x86 only, no deps (thin COM shim + pipe client). NMake via vcvarsall.
kokoro-sapi\build.ps1

# Register the voice (elevated; MUST be the 32-bit regsvr32). Same DLL path =
# registration survives rebuilds; no re-register needed after a rebuild.
C:\Windows\SysWOW64\regsvr32.exe "kokoro-sapi\build\KokoroSapi.dll"

# SAPI smoke test — run under 32-BIT PowerShell, with the app running, to drive
# the engine -> pipe -> WebGPU path without Kindle.
C:\Windows\SysWOW64\WindowsPowerShell\v1.0\powershell.exe -File kokoro-sapi\test-speak.ps1
```

No Rust/JS test suites; "testing" is the play/stop loop in the app and Read Aloud
in Kindle (or `test-speak.ps1`).

## Architecture

### Webview synthesis (the one engine)
- `src/tts.worker.ts` loads `kokoro-js` in a Web Worker, prefers WebGPU
  (`dtype: fp32`, `model.onnx`) and falls back to wasm (`dtype: q8`,
  `model_quantized.onnx`) if WebGPU is missing or warm-up times out. `src/tts.ts`
  is the main-thread client (request/response by id). `synthesize()` returns a WAV
  URL for the UI; `synthesizeRaw()` returns raw f32 PCM for the SAPI bridge.

### Rust backend (`src-tauri/src/`)
- `lib.rs` — model **download/verify** + the `kokoro://` **asset server**
  (`serve_model_file`, honors Range + CORS preflight). Commands: `model_exists`,
  `model_location`, `download_model`, `verify_model`. Files download from
  HuggingFace into the Tauri **app-data dir** (per `model-manifest.json`,
  embedded via `include_str!`; its voice entries must stay in sync with `VOICES`
  in `src/voices.ts`).
- `pipe_server.rs` — the **SAPI bridge**. A tokio named-pipe **server** at
  `\\.\pipe\KokoroSapiSynth` speaking the `WorkerProtocol.h` wire format. Each
  `'S'` request → `emit("synth-request", {id,text,voice,speed})` → the frontend
  (`src/bridge.ts`) synthesizes via `synthesizeRaw` and returns bytes through the
  `synth_result` command, correlated by id (a `oneshot` map). While the app runs
  it owns the pipe; the engine just connects.

### SAPI engine (`kokoro-sapi/src/`) — connect-only, ~900 lines, no deps
- `Dll.cpp` — COM class factory + `DllRegisterServer`/`Unregister` (writes the
  CLSID `InprocServer32` and the `KokoroTTS` voice token).
- `KokoroTTSEngine.cpp` — `ISpTTSEngine`. `Speak` gathers the host's text, runs
  `SplitText` (1-sentence first chunk for fast start, then **4 sentences**/chunk),
  and runs a **depth-1 prefetch pipeline**: chunk N+1 synthesizes on a worker
  thread (`std::async`) while chunk N streams to the SAPI site in ~250 ms blocks
  with `SPVES_ABORT` checks. On stop it interrupts the in-flight synth by closing
  the pipe (`WorkerClient::Close` is atomic for that cross-thread cancel).
- `WorkerClient.cpp` — pipe **client**: `EnsureConnected` is connect-only (no
  spawn); `Synthesize` does the `'S'` round-trip.
- `WorkerProtocol.h` — the wire format, shared in spirit with `pipe_server.rs`.
  **Change it in both places.**

## Gotchas / invariants (do not rediscover these)

- **The app must be running** or Kindle gets no audio (the engine's `Speak`
  returns `E_FAIL` when the pipe is absent — there's no fallback). A tray /
  auto-start mode is the planned fix.
- **The engine must stay x86** — Kindle is a 32-bit process and loads the COM DLL
  *in-process by registry path*. It therefore **cannot** be merged into the x64
  app; it's a separate file, bundled + registered. (Rewriting it in Rust is
  possible via `windows-rs` COM, but it'd still be a separate x86 cdylib.)
- **Tauri v2 needs a capability for `listen`.** `src-tauri/capabilities/default.json`
  grants `core:default` (+ `opener:default`). Without it the frontend `listen`
  silently throws "event.listen not allowed" and the bridge never receives
  requests. (Custom `invoke` commands work without a capability; core ones don't.)
- **Registration → `WOW6432Node`.** The 32-bit `regsvr32` writes
  `HKLM\SOFTWARE\Classes\…` into the WOW64 view — exactly what 32-bit Kindle reads.
- **Kindle (MSIX) shadows HKCU.** Its SAPI default voice (`DefaultTokenId`) comes
  from the package hive
  (`…\Packages\AMZNKindle…\SystemAppData\Helium\User.dat`), not real HKCU. Patch
  it via `reg load`/`unload` with Kindle stopped (`kindle-voice-guard.ps1`
  re-applies it if an update resets it). The OneCore registry is a dead end —
  Kindle uses classic `SpVoice`.
- **The kokoro:// scheme URL is per-platform.** macOS/Linux `kokoro://localhost/`;
  Windows/Android `http(s)://kokoro.localhost/` (WebView2 has no bare schemes).
  `tts.worker.ts` derives it from `self.location.protocol` — don't hardcode it.
- **App → engine controls** go through `models/controls.ini` (dotenv-style
  `voice=`/`speed=`/`gain=`), written atomically by the `set_controls` Tauri
  command to the token's `AssetDir` (read from the registry) and parsed by the
  engine's `ReadControls()` every `Speak`: `voice` is the narrator, `speed`/`gain`
  multiply the host's rate/volume. The app's narrator dropdown + speed/volume
  sliders push this on change, so they drive Kindle too.
- **Background WebGPU.** When the app is hidden/tray (the daemon use case),
  Chromium can throttle the renderer; pass
  `--disable-background-timer-throttling --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows` to keep WebGPU synthesizing.
- **Don't move `kokoro-sapi/`** — the registered token points at the DLL by path;
  relocating means re-`regsvr32` + re-pointing `AssetDir`.

## Environment quirks

- **PowerShell 5.1:** don't redirect native stderr (`2>&1` + `$ErrorActionPreference=Stop`
  turns a harmless cmd-autorun "vswhere.exe is not recognized" line into a
  terminating error — run `build.ps1` without `2>&1`). `Select-Object -First`
  truncates upstream pipelines.
- **File locks:** rebuilds hit LNK1104 while Kindle holds `KokoroSapi.dll` — stop
  Kindle (and the app) first. Port 1420 lingers after a crashed dev session.
- Registering/unregistering the voice and editing the MSIX hive need elevation
  (`Start-Process -Verb RunAs`).
- Use **bun** for all JS package/script work.
