import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  ListSubheader,
  MenuItem,
  Select,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import GraphicEqIcon from "@mui/icons-material/GraphicEq";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RecordVoiceOverIcon from "@mui/icons-material/RecordVoiceOver";
import SpeedIcon from "@mui/icons-material/Speed";
import StopIcon from "@mui/icons-material/Stop";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import { invoke } from "@tauri-apps/api/core";
import { initTTS, stopTTS, synthesize } from "./tts";
import { VOICES, loadVoice, voiceIntro } from "./voices";
import "./App.css";

type Backend = "webgpu" | "wasm";

function loadNum(key: string, def: number): number {
  const v = parseFloat(localStorage.getItem(key) ?? "");
  return Number.isFinite(v) ? v : def;
}

// Shared slider styling: a chunkier rail/track + larger thumb than the MUI
// "small" default, so the speed/volume bars are easier to grab.
const SLIDER_SX = {
  "& .MuiSlider-rail, & .MuiSlider-track": { height: 4, borderRadius: 2 },
  "& .MuiSlider-thumb": { width: 14, height: 14 },
};

// Icon-only transport button: an outlined Button wrapped in a Tooltip, with the
// icon as children. The span keeps the Tooltip working while the button is
// disabled (MUI can't attach a listener to a disabled control directly).
function ControlButton({
  label,
  onClick,
  disabled,
  color = "primary",
  children,
}: {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  color?: "primary" | "warning" | "error";
  children: ReactNode;
}) {
  return (
    <Tooltip title={label}>
      <span>
        <Button
          variant="outlined"
          color={color}
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          sx={{ minWidth: 0, p: 1, borderRadius: 1 }}
        >
          {children}
        </Button>
      </span>
    </Tooltip>
  );
}

function App() {
  const [voice, setVoice] = useState(loadVoice());
  const [speed, setSpeed] = useState(() => loadNum("tts-speed", 1));
  const [gain, setGain] = useState(() => loadNum("tts-gain", 1));
  const [ready, setReady] = useState(false);
  const [backend, setBackend] = useState<Backend | "">("");
  const [busy, setBusy] = useState(false); // synthesizing
  const [playing, setPlaying] = useState(false); // audio is sounding
  // Which voice agency Kindle is set to: "none" (unset — neither segment shown),
  // "microsoft", or "kokoro". Drives the toggle and gates the Kokoro controls.
  const [agency, setAgency] = useState(
    () => localStorage.getItem("kindle-agency") ?? "none",
  );
  const kokoro = agency === "kokoro";
  const [error, setError] = useState("");

  // Label for the narrator tooltip: the selected voice's name + group (accent /
  // gender), so the current pick is legible without opening the dropdown.
  const current = VOICES.find((v) => v.id === voice);
  const narratorLabel = current
    ? `${current.name} · ${current.group}`
    : "Narrator";

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string>("");

  useEffect(() => {
    initTTS((b) => {
      setReady(true);
      setBackend(b);
    });
    // The voice-agency toggle initializes from localStorage ("kindle-agency",
    // set on a successful switch below) — see the `agency` state initializer.
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  // Persist narrator/speed/gain to localStorage. The SAPI bridge (bridge.ts)
  // reads these same keys when synthesizing for Kindle, so they drive Kindle too
  // without any app→engine file — the webview is the single source of truth.
  useEffect(() => {
    localStorage.setItem("tts-voice", voice);
    localStorage.setItem("tts-speed", String(speed));
    localStorage.setItem("tts-gain", String(gain));
  }, [voice, speed, gain]);

  async function play() {
    setError("");
    setBusy(true);
    try {
      const url = await synthesize(voiceIntro(voice), voice, speed);
      if (!url) return; // superseded or stopped
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = url;
      const audio = audioRef.current ?? new Audio();
      audioRef.current = audio;
      audio.src = url;
      audio.volume = Math.min(gain, 1); // preview gain (media volume can't boost > 1)
      audio.onended = () => setPlaying(false);
      await audio.play();
      setPlaying(true);
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
    setPlaying(false);
  }

  // Switch Kindle's voice agency to "microsoft" or "kokoro". The backend runs the
  // guard elevated (UAC) and resolves only once it succeeds, so we apply the
  // selection optimistically but revert it if the switch is cancelled or fails.
  // Kindle must be reopened to actually apply the change.
  function selectAgency(next: "microsoft" | "kokoro") {
    const prev = agency;
    if (next !== "kokoro") stop(); // Kokoro controls go inactive; halt any preview
    setAgency(next);
    invoke("set_kindle_voice", { kokoro: next === "kokoro" })
      .then(() => localStorage.setItem("kindle-agency", next))
      .catch((e) => {
        setAgency(prev); // UAC cancelled / guard failed
        setError(String(e));
      });
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 2, p: 3 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Tooltip title="Voice Mode">
          <GraphicEqIcon fontSize="medium" color="action" />
        </Tooltip>
        <ToggleButtonGroup
          exclusive
          size="small"
          color="primary"
          value={agency}
          onChange={(_, val) => {
            if (val !== null) selectAgency(val);
          }}
          sx={{
            "& .MuiToggleButton-root.Mui-selected": {
              bgcolor: "primary.main",
              color: "primary.contrastText",
              "&:hover": { bgcolor: "primary.dark" },
            },
          }}
        >
          <Tooltip title="Set Kindle's voice to Microsoft David">
            <ToggleButton value="microsoft">Microsoft</ToggleButton>
          </Tooltip>
          <Tooltip title="Set Kindle's voice to Kokoro">
            <ToggleButton value="kokoro">Kokoro</ToggleButton>
          </Tooltip>
        </ToggleButtonGroup>
      </Box>

      <Box sx={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 2 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, width: 220 }}>
          <Tooltip title="Narrator">
            <RecordVoiceOverIcon fontSize="medium" color="action" />
          </Tooltip>
          <Tooltip title={narratorLabel}>
            <FormControl size="small" fullWidth>
              <Select
                aria-label="Narrator"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                disabled={!ready || !kokoro}
                MenuProps={{ slotProps: { paper: { sx: { maxHeight: 360 } } } }}
              >
                {VOICES.flatMap((v, i) => {
                  const items = [];
                  if (i === 0 || v.group !== VOICES[i - 1].group) {
                    items.push(
                      <ListSubheader key={v.group}>{v.group}</ListSubheader>,
                    );
                  }
                  items.push(
                    <MenuItem key={v.id} value={v.id}>
                      {v.name}
                    </MenuItem>,
                  );
                  return items;
                })}
              </Select>
            </FormControl>
          </Tooltip>
        </Box>

        {busy || playing ? (
          <ControlButton
            label={busy ? "Synthesizing…" : "Stop"}
            onClick={stop}
            color={busy ? "primary" : "error"}
          >
            {busy ? <CircularProgress size={24} color="inherit" /> : <StopIcon />}
          </ControlButton>
        ) : (
          <ControlButton
            label="Preview"
            onClick={play}
            disabled={!ready || !kokoro}
          >
            <PlayArrowIcon />
          </ControlButton>
        )}
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Tooltip title="Reading speed">
            <SpeedIcon fontSize="medium" color="action" />
          </Tooltip>
          <Box sx={{ width: 220 }}>
            <Slider
              size="small"
              sx={SLIDER_SX}
              value={speed}
              min={0.5}
              max={2}
              step={0.05}
              disabled={!kokoro}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${Math.round(v * 100)}%`}
              onChange={(_, v) => setSpeed(v as number)}
            />
          </Box>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Tooltip title="Volume">
            <VolumeUpIcon fontSize="medium" color="action" />
          </Tooltip>
          <Box sx={{ width: 220 }}>
            <Slider
              size="small"
              sx={SLIDER_SX}
              value={gain}
              min={0}
              max={2}
              step={0.05}
              disabled={!kokoro}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${Math.round(v * 100)}%`}
              onChange={(_, v) => setGain(v as number)}
            />
          </Box>
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
