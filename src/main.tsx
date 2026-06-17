import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { HashRouter, Navigate, Route, Routes } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import App from "./App";
import Setup from "./Setup";
import { startSapiBridge } from "./bridge";

// Serve Kindle's SAPI synth requests via WebGPU for the lifetime of the app.
startSapiBridge();

// Gates the "/" route: the TTS model must be present before the reader renders.
// Until then we redirect to the setup wizard, which navigates back here once
// `model_exists` is true.
function AppGate() {
  // null = still checking on launch; true/false = ready or not.
  const [ready, setReady] = useState<boolean | null>(null);

  useEffect(() => {
    invoke<boolean>("model_exists")
      .then(setReady)
      .catch(() => setReady(false));
  }, []);

  if (ready === null) return null; // brief readiness check; render nothing
  return ready ? <App /> : <Navigate to="/setup" replace />;
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <HashRouter>
      <Routes>
        <Route path="/" element={<AppGate />} />
        <Route path="/setup" element={<Setup />} />
      </Routes>
    </HashRouter>
  </React.StrictMode>,
);
