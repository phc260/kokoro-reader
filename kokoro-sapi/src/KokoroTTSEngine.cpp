#include "KokoroTTSEngine.h"
#include "StrConv.h"
#include "WorkerClient.h"
#include "Guids.h"
#include "Log.h"
#include <cmath>
#include <mutex>
#include <string>
#include <vector>
#include <algorithm>

// Global live-object counter (defined in Dll.cpp) so the DLL knows when it is
// safe to unload.
extern long g_cObjects;

namespace {

// Kokoro's native output rate. The engine never loads a model now — synthesis
// happens in the kokoro-reader app (WebGPU) reached over the pipe — so this is
// just the format we declare to the host.
constexpr int kSampleRate = 24000;

// The connection to the app's synthesis pipe. Synthesis is serialized by
// g_synthMutex (the app handles one request at a time per connection anyway).
WorkerClient g_worker;
std::mutex   g_synthMutex;

}  // namespace

KokoroTTSEngine::KokoroTTSEngine() : m_cRef(1), m_pToken(nullptr) {
    InterlockedIncrement(&g_cObjects);
}

KokoroTTSEngine::~KokoroTTSEngine() {
    if (m_pToken) m_pToken->Release();
    InterlockedDecrement(&g_cObjects);
}

// ---- IUnknown ------------------------------------------------------------

STDMETHODIMP KokoroTTSEngine::QueryInterface(REFIID riid, void** ppv) {
    if (!ppv) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_ISpTTSEngine)
        *ppv = static_cast<ISpTTSEngine*>(this);
    else if (riid == IID_ISpObjectWithToken)
        *ppv = static_cast<ISpObjectWithToken*>(this);
    else {
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    AddRef();
    return S_OK;
}

STDMETHODIMP_(ULONG) KokoroTTSEngine::AddRef() {
    return InterlockedIncrement(&m_cRef);
}

STDMETHODIMP_(ULONG) KokoroTTSEngine::Release() {
    LONG c = InterlockedDecrement(&m_cRef);
    if (c == 0) delete this;
    return c;
}

// ---- ISpObjectWithToken --------------------------------------------------

STDMETHODIMP KokoroTTSEngine::SetObjectToken(ISpObjectToken* pToken) {
    if (m_pToken) m_pToken->Release();
    m_pToken = pToken;
    if (m_pToken) m_pToken->AddRef();
    return S_OK;
}

STDMETHODIMP KokoroTTSEngine::GetObjectToken(ISpObjectToken** ppToken) {
    if (!ppToken) return E_POINTER;
    *ppToken = m_pToken;
    if (m_pToken) {
        m_pToken->AddRef();
        return S_OK;
    }
    return E_FAIL;
}

// ---- synth bring-up --------------------------------------------------------

// Connects to the app's synthesis pipe. Returns false if the app isn't running.
// The engine holds no narrator/speed/gain state — the app owns those (from its
// webview localStorage) and applies them itself, so there's nothing else to set
// up here.
bool KokoroTTSEngine::EnsureSynth() {
    std::lock_guard<std::mutex> lk(g_synthMutex);
    const bool up = g_worker.EnsureConnected();
    if (!up) KokoroLog("EnsureSynth: app pipe unavailable");
    return up;
}

// ---- ISpTTSEngine --------------------------------------------------------

// We declare 24 kHz / 16-bit / mono PCM — Kokoro's native rate — so SAPI
// inserts any converter a host needs.
STDMETHODIMP KokoroTTSEngine::GetOutputFormat(const GUID* /*pTargetFmtId*/,
    const WAVEFORMATEX* /*pTargetWaveFormatEx*/, GUID* pOutputFormatId,
    WAVEFORMATEX** ppCoMemOutputWaveFormatEx) {
    if (!pOutputFormatId || !ppCoMemOutputWaveFormatEx) return E_POINTER;

    WAVEFORMATEX* wfex =
        static_cast<WAVEFORMATEX*>(CoTaskMemAlloc(sizeof(WAVEFORMATEX)));
    if (!wfex) return E_OUTOFMEMORY;

    wfex->wFormatTag      = WAVE_FORMAT_PCM;
    wfex->nChannels       = 1;
    wfex->nSamplesPerSec  = kSampleRate;
    wfex->wBitsPerSample  = 16;
    wfex->nBlockAlign     = wfex->nChannels * (wfex->wBitsPerSample / 8);
    wfex->nAvgBytesPerSec = wfex->nSamplesPerSec * wfex->nBlockAlign;
    wfex->cbSize          = 0;

    *pOutputFormatId          = SPDFID_WaveFormatEx;
    *ppCoMemOutputWaveFormatEx = wfex;
    return S_OK;
}

// Render the utterance: concatenate the speakable fragments and hand the whole
// text to the app, which now owns all chunking — it splits into sentence chunks,
// synthesizes them with a prefetch pipeline and streams the PCM back frame by
// frame (BeginSynth + ReadFrame). The engine is a pure sink: for each frame it
// applies the per-chunk gain (carried in the frame) × the host volume and writes
// ~250 ms blocks to the SAPI site, checking SPVES_ABORT. On stop it closes the
// pipe to interrupt the in-flight stream; the next Speak reconnects.
STDMETHODIMP KokoroTTSEngine::Speak(DWORD /*dwSpeakFlags*/, REFGUID /*rguidFormatId*/,
    const WAVEFORMATEX* /*pWaveFormatEx*/, const SPVTEXTFRAG* pTextFragList,
    ISpTTSEngineSite* pOutputSite) {
    if (!pOutputSite) return E_POINTER;
    KokoroLog("Speak called");
    if (!EnsureSynth()) return E_FAIL;

    std::wstring text;
    for (const SPVTEXTFRAG* f = pTextFragList; f != nullptr; f = f->pNext) {
        switch (f->State.eAction) {
            case SPVA_Speak:
            case SPVA_Pronounce:
            case SPVA_SpellOut:
                text.append(f->pTextStart, f->ulTextLen);
                text.push_back(L' ');
                break;
            default:  // bookmarks, silence, etc. -- not needed for reading
                break;
        }
    }
    if (text.empty()) return S_OK;

    // The app (its webview localStorage) owns the narrator, the user's speed
    // multiplier, gain and the per-chunk sentence count; the engine only forwards
    // the host's live rate slider and applies its volume slider. Host SAPI rate
    // -10..10 -> speed 1/3x..3x (log); the app multiplies this by the user's own
    // speed setting before synthesizing. Rate is fixed for the whole utterance —
    // a mid-utterance host rate change takes effect on the next Speak (pages are
    // short, and the stream can't be re-rated in flight).
    USHORT volume = 100;
    pOutputSite->GetVolume(&volume);
    long rate = 0;
    pOutputSite->GetRate(&rate);
    const float speed = std::pow(3.0f, static_cast<float>(rate) / 10.0f);

    const std::string utf8 = Narrow(text);

    // Open the stream (one 'S' request for the whole utterance). One reconnect
    // retry covers a pipe that went stale between EnsureSynth and here.
    {
        std::lock_guard<std::mutex> lk(g_synthMutex);
        if (!g_worker.BeginSynth(utf8, speed) &&
            !(g_worker.EnsureConnected() && g_worker.BeginSynth(utf8, speed))) {
            KokoroLog("Speak: BeginSynth failed (app pipe)");
            return E_FAIL;
        }
    }

    const size_t kBlock = kSampleRate / 4;  // ~250 ms
    HRESULT result = S_OK;
    bool aborted = false;
    for (;;) {
        if (pOutputSite->GetActions() & SPVES_ABORT) { aborted = true; break; }

        // Pull the next chunk's PCM (+ its fresh gain) off the stream.
        std::vector<float> pcm;
        float gain = 1.0f;
        WorkerClient::FrameStatus st;
        {
            std::lock_guard<std::mutex> lk(g_synthMutex);
            st = g_worker.ReadFrame(pcm, gain);
        }
        if (st == WorkerClient::FrameStatus::End) break;          // utterance done
        if (st == WorkerClient::FrameStatus::Error) {             // failed/broken
            KokoroLog("Speak: synthesis failed (app pipe)");
            result = E_FAIL;
            break;
        }

        // float [-1,1] -> int16 with the user's gain (from the frame) and the
        // host volume applied. Clamped below.
        if (pOutputSite->GetActions() & SPVES_VOLUME) pOutputSite->GetVolume(&volume);
        const float vol = volume / 100.0f;
        std::vector<short> out(pcm.size());
        for (size_t i = 0; i < pcm.size(); ++i) {
            float s = pcm[i] * gain * vol;
            s = s < -1.f ? -1.f : (s > 1.f ? 1.f : s);
            out[i] = static_cast<short>(s * 32767.f);
        }

        for (size_t off = 0; off < out.size(); off += kBlock) {
            if (pOutputSite->GetActions() & SPVES_ABORT) { aborted = true; break; }
            const size_t n = (std::min)(kBlock, out.size() - off);  // () dodges windows.h min macro
            ULONG written = 0;
            HRESULT hr = pOutputSite->Write(out.data() + off,
                                            static_cast<ULONG>(n * sizeof(short)), &written);
            if (FAILED(hr)) { result = hr; aborted = true; break; }
        }
        if (aborted) break;
    }

    // Stopped early while the app is still streaming: close the pipe to interrupt
    // it (its next frame write fails and it cancels the rest). Next Speak
    // reconnects. A clean End/Error leaves the pipe open for reuse.
    if (aborted) g_worker.Close();
    return result;
}
