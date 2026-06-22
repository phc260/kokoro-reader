#include "WorkerClient.h"
#include "WorkerProtocol.h"
#include "Log.h"

using namespace kokoro_ipc;

bool WorkerClient::TryOpenPipe() {
    HANDLE h = CreateFileW(kPipeName, GENERIC_READ | GENERIC_WRITE, 0, nullptr,
                           OPEN_EXISTING, 0, nullptr);
    if (h == INVALID_HANDLE_VALUE) return false;
    m_pipe = h;
    return true;
}

bool WorkerClient::EnsureConnected() {
    if (m_pipe != INVALID_HANDLE_VALUE) return true;
    // Connect-only: the kokoro-reader app serves the pipe. If it isn't running,
    // there's nothing to spawn — the utterance is silently skipped.
    if (TryOpenPipe()) return true;
    KokoroLog("client: pipe not available (kokoro-reader app not running?)");
    return false;
}

bool WorkerClient::Synthesize(const std::string& utf8Text, float rate,
                              std::vector<float>& outSamples) {
    if (m_pipe == INVALID_HANDLE_VALUE) return false;
    if (utf8Text.empty()) return true;
    if (utf8Text.size() > kMaxTextBytes) return false;

    const uint8_t  cmd       = kCmdSynth;
    const uint32_t textBytes = static_cast<uint32_t>(utf8Text.size());
    if (!WriteExact(m_pipe, &cmd, sizeof(cmd)) ||
        !WriteExact(m_pipe, &rate, sizeof(rate)) ||
        !WriteExact(m_pipe, &textBytes, sizeof(textBytes)) ||
        !WriteExact(m_pipe, utf8Text.data(), textBytes)) {
        Close();  // broken pipe: next Speak() reconnects/respawns
        return false;
    }

    uint32_t n = 0;
    if (!ReadExact(m_pipe, &n, sizeof(n))) {
        Close();
        return false;
    }
    if (n == kSynthError) return false;

    const size_t base = outSamples.size();
    outSamples.resize(base + n);
    if (n && !ReadExact(m_pipe, outSamples.data() + base, n * sizeof(float))) {
        outSamples.resize(base);
        Close();
        return false;
    }
    return true;
}

void WorkerClient::Close() {
    // Atomic so it's safe to call from another thread to interrupt a blocked
    // Synthesize (cancel-by-close): only one caller gets the real handle.
    HANDLE h = static_cast<HANDLE>(
        InterlockedExchangePointer(reinterpret_cast<PVOID volatile*>(&m_pipe),
                                   INVALID_HANDLE_VALUE));
    if (h != INVALID_HANDLE_VALUE) CloseHandle(h);
}
