import { useEffect, useRef, useState } from "react";
import {
  Box,
  Button,
  CircularProgress,
  MenuItem,
  Slider,
  TextField,
  Typography,
} from "@mui/material";
import { invoke } from "@tauri-apps/api/core";
import { initTTS, stopTTS, synthesize } from "./tts";
import { VOICES, loadVoice } from "./voices";
import "./App.css";

const SAMPLE_TEXT =
  "Kokoro reader is alive! This text is synthesized locally in the browser by " +
  "the Kokoro model running through kokoro.js. Pick a voice, then press play.";

type Backend = "webgpu" | "wasm";

function loadNum(key: string, def: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? "");
  return Number.isFinite(v) ? v : def;
}

function App() {
  const [text, setText] = useState(SAMPLE_TEXT);
  const [voice, setVoice] = useState(loadVoice());
  const [speed, setSpeed] = useState(() => loadNum("tts-speed", 1));
  const [gain, setGain] = useState(() => loadNum("tts-gain", 1));
  const [ready, setReady] = useState(false);
  const [backend, setBackend] = useState<Backend | "">("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string>("");

  useEffect(() => {
    initTTS((b) => {
      setReady(true);
      setBackend(b);
    });
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  // Persist the controls and push them to the SAPI engine (controls.ini), so the
  // narrator/speed/gain also drive Kindle. Ignored if the voice isn't registered.
  useEffect(() => {
    localStorage.setItem("tts-voice", voice);
    localStorage.setItem("tts-speed", String(speed));
    localStorage.setItem("tts-gain", String(gain));
    invoke("set_controls", { voice, speed, gain }).catch((e) =>
      console.debug("[controls] set_controls skipped:", e),
    );
  }, [voice, speed, gain]);

  async function play() {
    setError("");
    setBusy(true);
    try {
      const url = await synthesize(text, voice, speed);
      if (!url) return; // superseded or stopped
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.src = url;
      audio.volume = Math.min(gain, 1); // preview gain (media volume can't boost > 1)
      await audio.play();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function stop() {
    stopTTS();
    audioRef.current?.pause();
    setBusy(false);
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, p: 3 }}>
      <Typography variant="h5">kokoro-reader</Typography>

      <TextField
        multiline
        minRows={6}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Paste text to read aloud…"
        fullWidth
      />

      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
        <TextField
          select
          label="Narrator"
          size="small"
          value={voice}
          onChange={(e) => setVoice(e.target.value)}
          sx={{ minWidth: 220 }}
          disabled={!ready}
        >
          {VOICES.map((v) => (
            <MenuItem key={v.id} value={v.id}>
              {v.name} — {v.group}
            </MenuItem>
          ))}
        </TextField>

        <Button
          variant="contained"
          onClick={play}
          disabled={!ready || busy}
          startIcon={busy ? <CircularProgress size={18} color="inherit" /> : undefined}
        >
          {busy ? "Synthesizing…" : "▶ Play"}
        </Button>
        <Button variant="outlined" onClick={stop} disabled={!ready}>
          ■ Stop
        </Button>
      </Box>

      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        <Box sx={{ width: 220 }}>
          <Typography variant="caption" color="text.secondary">
            Speed — {speed.toFixed(2)}×
          </Typography>
          <Slider
            size="small"
            value={speed}
            min={0.5}
            max={2}
            step={0.05}
            onChange={(_, v) => setSpeed(v as number)}
          />
        </Box>
        <Box sx={{ width: 220 }}>
          <Typography variant="caption" color="text.secondary">
            Volume — {gain.toFixed(2)}×
          </Typography>
          <Slider
            size="small"
            value={gain}
            min={0}
            max={2}
            step={0.05}
            onChange={(_, v) => setGain(v as number)}
          />
        </Box>
      </Box>

      <Typography variant="body2" color={error ? "error" : "text.secondary"}>
        {error
          ? error
          : ready
            ? `engine: kokoro.js (${backend})`
            : "loading model…"}
      </Typography>
    </Box>
  );
}

export default App;
