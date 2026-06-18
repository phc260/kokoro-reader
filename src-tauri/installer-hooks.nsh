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
;   * Writable AssetDir. DllRegisterServer derives AssetDir = <dll dir>\..\models
;     = $INSTDIR\models. The app writes controls.ini (narrator/speed/gain) there
;     at runtime, non-elevated, so standard users need write access to it.

!macro NSIS_HOOK_POSTINSTALL
  ; AssetDir the voice token will point at. Create it and grant the local Users
  ; group (well-known SID S-1-5-32-545, locale-independent) modify rights so the
  ; non-elevated app can push controls.ini there.
  CreateDirectory "$INSTDIR\models"
  nsExec::ExecToLog 'icacls "$INSTDIR\models" /grant "*S-1-5-32-545:(OI)(CI)M"'

  ; Seed default narrator/speed/gain so Kindle has sane settings before the app
  ; first runs (the app's seed_controls would otherwise do this on startup).
  CopyFiles /SILENT "$INSTDIR\resources\controls.ini" "$INSTDIR\models\controls.ini"

  ; Register the COM server + voice token. /s = silent (no message boxes).
  nsExec::ExecToLog '"$WINDIR\SysWOW64\regsvr32.exe" /s "$INSTDIR\resources\KokoroSapi.dll"'

  ; Make Kokoro the Kindle default now that the KokoroTTS token exists. The guard
  ; reg-loads Kindle's MSIX hive (needs admin -> fine, the installer is elevated)
  ; and one-shots DefaultTokenId to Kokoro. It self-skips if the hive is absent
  ; (Kindle not installed), so it never fails the install.
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\kindle-voice-guard.ps1" -Set kokoro'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Unregister while the DLL still exists — DllUnregisterServer deletes the HKLM
  ; CLSID + voice token. Runs before files are removed.
  nsExec::ExecToLog '"$WINDIR\SysWOW64\regsvr32.exe" /u /s "$INSTDIR\resources\KokoroSapi.dll"'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; The models dir + controls.ini are created at runtime, not tracked by the
  ; installer, so remove them explicitly.
  RMDir /r "$INSTDIR\models"
!macroend
