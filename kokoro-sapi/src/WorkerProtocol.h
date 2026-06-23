#pragma once
// Wire protocol between clients (the 32-bit SAPI engine, the kokoro-reader
// Tauri backend) and the 64-bit synthesis worker over a byte-mode named pipe.
//
// Every request starts with a one-byte command:
//
//   kCmdSynth ('S'):
//     -> [float rate][u32 textBytes][utf8 text]      (the WHOLE utterance)
//     <- a STREAM of frames, one per synthesized chunk:
//          [u32 nSamples][float gain][float samples...]   (24 kHz mono, [-1, 1])
//        terminated by a marker frame whose leading u32 is:
//          kStreamEnd  -> the utterance is complete (no gain/samples follow)
//          kSynthError -> a chunk failed; playback stops (no gain/samples follow)
//     The host (the kokoro-reader app) now owns ALL chunking: it splits the text
//     into sentence chunks, synthesizes them with a prefetch pipeline and streams
//     the PCM back frame by frame. The engine is a pure sink — it pumps each
//     frame to the SAPI site in ~250 ms blocks and aborts by closing the pipe.
//     `rate` is the host's rate-derived speed multiplier (1 = the host's normal
//     rate). The host owns the narrator voice and folds in the user's own speed
//     multiplier, so those don't cross the wire. `gain` (the user's volume, 1 =
//     unity, read from "tts-gain") rides along in each frame — fresh per chunk so
//     a slider move lands within the playing chunk rather than being frozen into
//     prefetched samples — and the engine applies it (× the host volume) when it
//     converts to int16. The per-chunk sentence count ("tts-chunk") is also read
//     by the host now, so there's no separate config round-trip.
//
//   kCmdInfo ('I'):
//     -> (nothing)
//     <- [u16 jsonBytes][utf8 json]  e.g. {"provider":"DirectML","voice":"af_heart"}
//
// The host streams a whole utterance per 'S' request and handles chunking, gain
// and prefetch; the engine handles abort (by closing the pipe). The worker stays
// alive between requests (model stays warm) and exits after kIdleTimeoutMs.
#include <windows.h>
#include <cstdint>

namespace kokoro_ipc {

constexpr wchar_t kPipeName[]     = L"\\\\.\\pipe\\KokoroSapiSynth";
constexpr uint8_t kCmdSynth       = 'S';
constexpr uint8_t kCmdInfo        = 'I';
// Frame-stream markers for the 'S' response (a leading u32 >= kStreamEnd is a
// control marker, never a real sample count — that'd be ~16 GB of PCM).
constexpr uint32_t kStreamEnd     = 0xFFFFFFFEu;  // utterance complete
constexpr uint32_t kSynthError    = 0xFFFFFFFFu;  // a chunk failed
constexpr uint32_t kMaxTextBytes  = 1u << 20;   // sanity cap (1 MB)
constexpr uint32_t kIdleTimeoutMs = 5 * 60 * 1000;

// Byte-mode pipes may deliver partial reads/writes; both ends use these.
inline bool ReadExact(HANDLE pipe, void* buf, DWORD n) {
    auto* p = static_cast<char*>(buf);
    while (n) {
        DWORD got = 0;
        if (!ReadFile(pipe, p, n, &got, nullptr) || got == 0) return false;
        p += got;
        n -= got;
    }
    return true;
}

inline bool WriteExact(HANDLE pipe, const void* buf, DWORD n) {
    auto* p = static_cast<const char*>(buf);
    while (n) {
        DWORD put = 0;
        if (!WriteFile(pipe, p, n, &put, nullptr)) return false;
        p += put;
        n -= put;
    }
    return true;
}

}  // namespace kokoro_ipc
