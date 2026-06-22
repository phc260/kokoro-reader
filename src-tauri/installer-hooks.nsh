; NSIS installer hooks for kokoro-reader.
;
; Registers the bundled x86 SAPI engine (resources\KokoroSapi.dll) so
; "Kokoro (SAPI5)" appears in the Windows voice list and 32-bit hosts like
; Kindle can narrate with it. The engine is connect-only — it forwards each
; Speak to the running app over a named pipe — so registering it just creates
; the COM server + SAPI voice token; no synthesis deps are installed.
;
; Why these specifics (see CLAUDE.md / Dll.cpp):
;   * x86 regsvr32 only. Kindle is 32-bit and loads the DLL in-process by
;     registry path, so it must be registered with C:\Windows\SysWOW64\regsvr32.
;   * Elevation required. DllRegisterServer writes HKLM (WOW64-redirected to
;     WOW6432Node). The installer is therefore perMachine (set in tauri.conf.json).
;   * No shared settings file. Narrator/speed/gain live in the app's webview
;     localStorage and are applied during synthesis, so there's no controls.ini
;     to seed and no writable AssetDir to grant.

!macro NSIS_HOOK_POSTINSTALL
  ; Register the COM server + voice token. /s = silent (no message boxes).
  nsExec::ExecToLog '"$WINDIR\SysWOW64\regsvr32.exe" /s "$INSTDIR\resources\KokoroSapi.dll"'

  ; Make Kokoro the Kindle default now that the KokoroTTS token exists. The guard
  ; reg-loads Kindle's MSIX hive (needs admin -> fine, the installer is elevated)
  ; and one-shots DefaultTokenId to Kokoro. It self-skips if the hive is absent
  ; (Kindle not installed), so it never fails the install.
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\kindle-voice-guard.ps1" -Set kokoro'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Revert Kindle's default voice to Microsoft David BEFORE we delete the token,
  ; so we don't leave Kindle's MSIX hive pointing DefaultTokenId at a KokoroTTS
  ; token that no longer exists. Runs while the guard script still exists in
  ; resources\; self-skips if Kindle's hive is absent (Kindle not installed).
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\kindle-voice-guard.ps1" -Set david'

  ; Unregister while the DLL still exists — DllUnregisterServer deletes the HKLM
  ; CLSID + voice token. Runs before files are removed.
  nsExec::ExecToLog '"$WINDIR\SysWOW64\regsvr32.exe" /u /s "$INSTDIR\resources\KokoroSapi.dll"'
!macroend
