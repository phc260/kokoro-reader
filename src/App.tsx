import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Box,
  Button,
  CircularProgress,
  FormControl,
  IconButton,
  ListSubheader,
  Menu,
  MenuItem,
  Select,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import Brightness7Icon from "@mui/icons-material/Brightness7Rounded";
import Brightness4Icon from "@mui/icons-material/Brightness4Rounded";
import ContrastIcon from "@mui/icons-material/ContrastRounded";
import ThermostatIcon from "@mui/icons-material/ThermostatRounded";
import GraphicEqIcon from "@mui/icons-material/GraphicEqRounded";
import PlayArrowIcon from "@mui/icons-material/PlayArrowRounded";
import NotesIcon from "@mui/icons-material/NotesRounded";
import TimerIcon from "@mui/icons-material/TimerRounded";
import GrainIcon from "@mui/icons-material/GrainRounded";
import RecordVoiceOverIcon from "@mui/icons-material/RecordVoiceOverRounded";
import SpeedIcon from "@mui/icons-material/SpeedRounded";
import StopIcon from "@mui/icons-material/StopRounded";
import VolumeUpIcon from "@mui/icons-material/VolumeUpRounded";
import VolumeOffIcon from "@mui/icons-material/VolumeOffRounded";
import { invoke } from "@tauri-apps/api/core";
import { initTTS, stopTTS, synthesize } from "./tts";
import { VOICES, loadVoice, voiceIntro } from "./voices";
import { useColorMode } from "./theme";
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
  // Sentences coalesced per steady-state chunk for the Kindle path. Bigger =
  // fewer seams but slower per-chunk start / coarser stop granularity. The split
  // happens in pipe_server.rs, which reads this over the pipe via bridge.ts's
  // stream-config handler ("tts-chunk", clamped 2–8).
  const [chunk, setChunk] = useState(() => loadNum("tts-chunk", 2));
  // Kindle-path streaming/pacing knobs (also read by pipe_server.rs per utterance,
  // for tuning volume responsiveness across machines). `lead` = ms of audio kept
  // buffered ahead of the speaker (lower = snappier volume changes but riskier
  // underruns/gaps); `subframe` = ms granularity at which gain/volume is re-read.
  const [lead, setLead] = useState(() => loadNum("tts-lead", 500));
  const [subframe, setSubframe] = useState(() => loadNum("tts-subframe", 250));
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
  // App-wide light/dark theme + page warmth (see theme.tsx).
  const { mode, toggle: toggleColorMode, temperature, setTemperature } =
    useColorMode();
  // Anchor for the top-right Appearance menu (light/dark + temperature).
  const [appearanceAnchor, setAppearanceAnchor] = useState<HTMLElement | null>(
    null,
  );


  const audioRef = useRef<HTMLAudioElement | null>(null);
  const urlRef = useRef<string>("");
  // Web Audio graph for preview: <audio> → MediaElementSource → GainNode →
  // destination. Unlike HTMLMediaElement.volume (clamped to [0,1]), GainNode.gain
  // is unbounded, so the slider's 100–200% boost range works in preview too.
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  // Gain to restore when un-muting (the level the slider held before it was
  // clicked to 0). Clicking the volume icon toggles between 0 and this.
  const preMuteGainRef = useRef(1);

  // Clicking the volume icon mutes (gain → 0) or restores the pre-mute level.
  // Like the sliders, this writes `tts-gain`, so it drives both the in-app
  // preview and the Kindle path (gain rides back per PCM frame).
  const toggleMute = () => {
    if (gain > 0) {
      preMuteGainRef.current = gain;
      setGain(0);
    } else {
      setGain(preMuteGainRef.current > 0 ? preMuteGainRef.current : 1);
    }
  };

  useEffect(() => {
    initTTS((b) => {
      setReady(true);
      setBackend(b);
    });
    // The voice-agency toggle initializes from localStorage ("kindle-agency",
    // set on a successful switch below) — see the `agency` state initializer.
    return () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      void audioCtxRef.current?.close();
    };
  }, []);

  // Live-update the preview gain so moving the Volume slider during playback
  // takes effect immediately (the node persists across previews).
  useEffect(() => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = gain;
  }, [gain]);

  // Persist narrator/speed/gain to localStorage. The SAPI bridge (bridge.ts)
  // reads these same keys when synthesizing for Kindle, so they drive Kindle too
  // without any app→engine file — the webview is the single source of truth.
  useEffect(() => {
    localStorage.setItem("tts-voice", voice);
    localStorage.setItem("tts-speed", String(speed));
    localStorage.setItem("tts-gain", String(gain));
    localStorage.setItem("tts-chunk", String(chunk));
    localStorage.setItem("tts-lead", String(lead));
    localStorage.setItem("tts-subframe", String(subframe));
  }, [voice, speed, gain, chunk, lead, subframe]);

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
      // Build the gain graph once: createMediaElementSource is one-shot per
      // element, so we reuse the same <audio> + AudioContext for every preview.
      if (!audioCtxRef.current) {
        const ctx = new AudioContext();
        const gainNode = ctx.createGain();
        ctx.createMediaElementSource(audio).connect(gainNode).connect(ctx.destination);
        audioCtxRef.current = ctx;
        gainNodeRef.current = gainNode;
      }
      gainNodeRef.current!.gain.value = gain; // full 0–200% range (no [0,1] clamp)
      if (audioCtxRef.current.state === "suspended") await audioCtxRef.current.resume();
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
    <>
      <Box sx={{ display: "flex", justifyContent: "flex-end", px: 1, pt: 1 }}>
        <Tooltip title="Appearance">
          <IconButton
            aria-label="Appearance"
            onClick={(e) => setAppearanceAnchor(e.currentTarget)}
          >
            <ContrastIcon fontSize="medium" />
          </IconButton>
        </Tooltip>
        <Menu
          anchorEl={appearanceAnchor}
          open={Boolean(appearanceAnchor)}
          onClose={() => setAppearanceAnchor(null)}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
          <Box sx={{ px: 2.5, py: 1.5, width: 240 }}>
            <Typography variant="subtitle2" gutterBottom>
              Appearance
            </Typography>
            <ToggleButtonGroup
              exclusive
              size="small"
              fullWidth
              value={mode}
              onChange={(_, val) => {
                if (val && val !== mode) toggleColorMode();
              }}
              aria-label="Appearance"
              sx={{ mb: 2 }}
            >
              <ToggleButton value="light" aria-label="Light mode">
                <Brightness7Icon fontSize="small" sx={{ mr: 0.75 }} />
                Light
              </ToggleButton>
              <ToggleButton value="dark" aria-label="Dark mode">
                <Brightness4Icon fontSize="small" sx={{ mr: 0.75 }} />
                Dark
              </ToggleButton>
            </ToggleButtonGroup>

            <Typography variant="subtitle2" gutterBottom>
              Color temperature
            </Typography>
            <Box sx={{ display: "flex", alignItems: "center", gap: 1.5 }}>
              <Tooltip title="Cooler ← → warmer">
                <ThermostatIcon fontSize="small" color="action" />
              </Tooltip>
              <Slider
                size="small"
                sx={SLIDER_SX}
                aria-label="Color temperature"
                value={temperature}
                min={0}
                max={1}
                step={0.05}
                onChange={(_, v) => setTemperature(v as number)}
              />
            </Box>
          </Box>
        </Menu>
      </Box>

      <Box sx={{ display: "flex", flexDirection: "column", gap: 2, px: 3, pb: 3, pt: 1 }}>
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
            <FormControl size="small" fullWidth>
              <Select
                aria-label="Narrator"
                value={voice}
                onChange={(e) => {
                  stop(); // halt any in-flight/playing preview of the old voice
                  setVoice(e.target.value);
                }}
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
            <Tooltip title={gain > 0 ? "Mute" : "Unmute"}>
              <IconButton
                size="small"
                onClick={toggleMute}
                disabled={!kokoro}
                aria-label={gain > 0 ? "Mute" : "Unmute"}
                sx={{ p: 0 }}
              >
                {gain > 0 ? (
                  <VolumeUpIcon fontSize="medium" color="action" />
                ) : (
                  <VolumeOffIcon fontSize="medium" color="action" />
                )}
              </IconButton>
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
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Tooltip title="Sentences per chunk (Kindle streaming): higher is smoother but starts slower">
              <NotesIcon fontSize="medium" color="action" />
            </Tooltip>
            <Box sx={{ width: 220 }}>
              <Slider
                size="small"
                sx={SLIDER_SX}
                value={chunk}
                min={1}
                max={6}
                step={1}
                marks
                disabled={!kokoro}
                valueLabelDisplay="auto"
                valueLabelFormat={(v) => `${v}`}
                onChange={(_, v) => setChunk(v as number)}
              />
            </Box>
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Tooltip title="Pacing lead (ms, Kindle streaming): audio kept buffered ahead — lower = snappier volume changes but riskier gaps/underruns">
              <TimerIcon fontSize="medium" color="action" />
            </Tooltip>
            <Box sx={{ width: 220 }}>
              <Slider
                size="small"
                sx={SLIDER_SX}
                value={lead}
                min={50}
                max={1500}
                step={50}
                disabled={!kokoro}
                valueLabelDisplay="auto"
                valueLabelFormat={(v) => `${v} ms`}
                onChange={(_, v) => setLead(v as number)}
              />
            </Box>
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Tooltip title="Sub-frame size (ms, Kindle streaming): how finely gain/volume is re-read — smaller = finer response, more overhead">
              <GrainIcon fontSize="medium" color="action" />
            </Tooltip>
            <Box sx={{ width: 220 }}>
              <Slider
                size="small"
                sx={SLIDER_SX}
                value={subframe}
                min={50}
                max={500}
                step={25}
                disabled={!kokoro}
                valueLabelDisplay="auto"
                valueLabelFormat={(v) => `${v} ms`}
                onChange={(_, v) => setSubframe(v as number)}
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
    </>
  );
}

export default App;
