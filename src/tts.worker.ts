import { KokoroTTS, TextSplitterStream, env as kokoroEnv } from "kokoro-js";
import { env } from "@huggingface/transformers";

// Model files (config/tokenizer/onnx) are downloaded into the app data dir on
// first run (see `download_model` in src-tauri/src/lib.rs) and served back here
// over the custom `kokoro` URI scheme. No remote model downloads at synthesis time.
//
// Tauri exposes a custom scheme differently per platform. macOS/Linux serve the
// whole app (and custom schemes) from `tauri://localhost`, so the model is at
// `kokoro://localhost/`. Windows/Android route everything through `localhost`
// subdomains over http(s) (WebView2 doesn't support bare `xxx://` schemes), so
// the model is at `http(s)://kokoro.localhost/` — matching the app's own scheme.
// Derive it from the worker's origin (no Tauri JS API exists inside a Worker).
const KOKORO_BASE =
  self.location.protocol === "tauri:"
    ? "kokoro://localhost/"
    : `${self.location.protocol}//kokoro.localhost/`;
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = KOKORO_BASE;
// ORT wasm/mjs are served from the site root by the dev middleware / build copy.
kokoroEnv.wasmPaths = "/";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
// Voice used to warm up the model; per-request voices come in on "speak".
const WARMUP_VOICE = "af_heart";

// kokoro-js hardcodes voice downloads from Hugging Face. Redirect those fetches
// to the voice files served over the `kokoro://` scheme so the app works fully
// offline (the model/config/tokenizer already load locally via transformers).
const HF_VOICE_RE = new RegExp(
  `^https://huggingface\\.co/${MODEL_ID}/resolve/main/(voices/.+\\.bin)$`,
);
const localBase = `${env.localModelPath}${MODEL_ID}/`;
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const m = url.match(HF_VOICE_RE);
  return m ? originalFetch(localBase + m[1], init) : originalFetch(input, init);
}) as typeof fetch;

// kokoro-js types `voice` as a union of its known voice ids; our ids come from
// the same list (see voices.ts), so narrow the runtime string to that type.
type VoiceId = NonNullable<Parameters<KokoroTTS["stream"]>[1]>["voice"];

type Backend = "webgpu" | "wasm";

type OutMsg =
  | { type: "loading" }
  | { type: "ready"; backend: Backend }
  | { type: "audio"; id: number; audio: Float32Array; samplingRate: number }
  | { type: "error"; id: number; message: string };

type InMsg =
  | { type: "speak"; id: number; text: string; voice: string; speed: number }
  | { type: "stop" };

// Most-recent request id. A newer "speak" or a "stop" supersedes any in-flight
// synthesis so it can bail out early. -1 means "stopped, nothing active".
let latestId = -1;

// Backend we're currently loading/loaded with. We prefer WebGPU (uses the GPU
// via the Chromium webview) and fall back to wasm + the quantized model.
let backend: Backend = "webgpu";
let modelPromise: Promise<KokoroTTS> | null = null;

// WebGPU's first inference compiles many shaders; on older GPUs it can be slow
// or hang outright. If the warmup doesn't finish in this window we give up on
// WebGPU and fall back to wasm.
const WARMUP_TIMEOUT_MS = 30000;

// Resolve to "__timeout__" if `p` doesn't settle within `ms` (rejections pass through).
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | "__timeout__"> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve("__timeout__"), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function loadModel(which: Backend): Promise<KokoroTTS> {
  post({ type: "loading" });
  const opts =
    which === "webgpu"
      ? ({ dtype: "fp32", device: "webgpu" } as const)
      : ({ dtype: "q8", device: "wasm" } as const);
  return KokoroTTS.from_pretrained(MODEL_ID, opts).then(async (model) => {
    // Warm up with a tiny synthesis: this triggers shader compilation / backend
    // init now, and — crucially for WebGPU on Pascal-era GPUs — lets us detect a
    // hung backend via timeout before the user ever hits Read Aloud.
    console.log(`[tts] ${which}: warming up…`);
    const warm = model.generate("Warm up.", { voice: WARMUP_VOICE });
    if (which === "webgpu") {
      const r = await withTimeout(warm, WARMUP_TIMEOUT_MS);
      if (r === "__timeout__") throw new Error("WebGPU warmup timed out");
    } else {
      await warm;
    }
    backend = which;
    console.log(`[tts] ${which}: ready`);
    post({ type: "ready", backend: which });
    return model;
  });
}

// Prefer WebGPU; if it can't load, warms up too slowly, or hangs, fall back to
// wasm + the quantized model so the app still works.
async function loadWithFallback(): Promise<KokoroTTS> {
  try {
    return await loadModel("webgpu");
  } catch (err) {
    console.warn("[tts] WebGPU unavailable/too slow, falling back to wasm:", err);
    return await loadModel("wasm");
  }
}

function getModel(): Promise<KokoroTTS> {
  if (!modelPromise) modelPromise = loadWithFallback();
  return modelPromise;
}

// Synthesize `text` to one mono Float32Array. Feeds a *closed* TextSplitterStream
// so long verses are split into sentence-sized pieces (avoiding the 512-token
// limit) and the iterator actually terminates — passing a raw string to stream()
// leaves the splitter open and the async iterator hangs forever.
async function synthesize(
  model: KokoroTTS,
  id: number,
  text: string,
  voice: string,
  speed: number,
): Promise<{ audio: Float32Array; samplingRate: number }> {
  const chunks: Float32Array[] = [];
  let samplingRate = 24000;
  const splitter = new TextSplitterStream();
  splitter.push(text);
  splitter.close();
  for await (const chunk of model.stream(splitter, { voice: voice as VoiceId, speed })) {
    if (latestId !== id) break; // superseded by a newer request or stop
    chunks.push(chunk.audio.audio);
    samplingRate = chunk.audio.sampling_rate;
  }
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const audio = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    audio.set(c, offset);
    offset += c.length;
  }
  return { audio, samplingRate };
}

async function handleSpeak(id: number, text: string, voice: string, speed: number) {
  try {
    // getModel() resolves only once a backend has warmed up successfully, so by
    // here the backend is known-good — no per-request fallback needed.
    const model = await getModel();
    console.log(`[tts] synthesizing (${backend}, ${voice}, ${speed}x):`, text.slice(0, 40));
    const { audio, samplingRate } = await synthesize(model, id, text, voice, speed);
    if (latestId !== id) return; // stopped while synthesizing
    post({ type: "audio", id, audio, samplingRate }, [audio.buffer]);
  } catch (err) {
    console.error("[tts] synthesis failed:", err);
    post({ type: "error", id, message: String(err) });
  }
}

function post(msg: OutMsg, transfer?: Transferable[]) {
  if (transfer) self.postMessage(msg, { transfer });
  else self.postMessage(msg);
}

// Warm up the model immediately so the first verse is fast.
getModel().catch((err) => post({ type: "error", id: -1, message: String(err) }));

self.addEventListener("message", (event: MessageEvent<InMsg>) => {
  const msg = event.data;
  if (msg.type === "stop") {
    latestId = -1;
    return;
  }
  if (msg.type === "speak") {
    latestId = msg.id;
    void handleSpeak(msg.id, msg.text, msg.voice, msg.speed);
  }
});
