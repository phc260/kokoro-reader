#include "KokoroTTSEngine.h"
#include "StrConv.h"
#include "WorkerClient.h"
#include "Guids.h"
#include "Log.h"
#include <cmath>
#include <future>
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

// Split text into chunks for sentence-streaming. We ramp up: the FIRST chunk is
// a single sentence (so audio starts quickly), then chunks coalesce 4 sentences
// each (fewer round-trips / inter-chunk seams; synthesis runs ~3x realtime so it
// stays ahead of playback). Boundaries are . ! ? (followed by whitespace / a
// closing quote / end) and newlines; decimals ("3.14") and ellipses are not
// boundaries; a sentence longer than the hard cap is broken on a word boundary.
// The app (kokoro-js) sub-splits anything past its token limit anyway.
std::vector<std::wstring> SplitText(const std::wstring& text) {
    constexpr size_t kFirstSentences = 1;     // small first chunk -> each page starts fast
    constexpr size_t kSentences      = 4;     // then 4 sentences per chunk
    constexpr size_t kHardCap        = 2000;  // run-on safety (break on a word boundary)
    std::vector<std::wstring> chunks;
    const size_t n = text.size();

    auto isSpace = [](wchar_t c) {
        return c == L' ' || c == L'\t' || c == L'\r' || c == L'\n' || c == L'\f' || c == L'\v';
    };
    auto isDigit = [](wchar_t c) { return c >= L'0' && c <= L'9'; };
    auto isCloser = [](wchar_t c) {
        return c == L'"' || c == L'\'' || c == L')' || c == L']' || c == L'}' ||
               c == L'”' || c == L'’';  // closing curly quotes
    };

    size_t start = 0, sentences = 0;
    auto flush = [&](size_t end) {
        size_t a = start, b = end;
        while (a < b && isSpace(text[a])) ++a;
        while (b > a && isSpace(text[b - 1])) --b;
        if (b > a) chunks.emplace_back(text.substr(a, b - a));
        start = end;
        sentences = 0;
    };
    auto target = [&]() { return chunks.empty() ? kFirstSentences : kSentences; };

    size_t i = 0;
    while (i < n) {
        const wchar_t c = text[i];

        // Find a sentence/paragraph boundary at i; boundaryEnd = position after it.
        size_t boundaryEnd = 0;
        if (c == L'\n') {
            boundaryEnd = i + 1;
        } else if (c == L'.' || c == L'!' || c == L'?') {
            bool isBoundary = true;
            if (c == L'.') {
                const bool decimal =
                    i > 0 && isDigit(text[i - 1]) && i + 1 < n && isDigit(text[i + 1]);
                const bool ellipsis =
                    (i + 1 < n && text[i + 1] == L'.') || (i > 0 && text[i - 1] == L'.');
                if (decimal || ellipsis) isBoundary = false;
            }
            if (isBoundary) {
                size_t j = i + 1;  // swallow trailing terminators + closers (?!" or .")
                while (j < n && (text[j] == L'.' || text[j] == L'!' || text[j] == L'?' ||
                                 isCloser(text[j])))
                    ++j;
                if (j >= n || isSpace(text[j])) boundaryEnd = j;
            }
        }

        if (boundaryEnd) {
            // Count the sentence; emit once we've collected `target()` of them.
            if (++sentences >= target()) {
                flush(boundaryEnd);
                i = start;
            } else {
                i = boundaryEnd;
            }
            continue;
        }

        if (i - start >= kHardCap) {  // run-on with no boundary: break at a word boundary
            size_t brk = i;
            while (brk > start && !isSpace(text[brk - 1])) --brk;
            if (brk <= start) brk = i;  // one long token: hard cut
            flush(brk);
            i = start;
            continue;
        }
        ++i;
    }
    flush(n);  // trailing text
    return chunks;
}

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

// Render the utterance: concatenate speakable fragments, ask the app to
// synthesize the whole thing (it chunks internally), then stream the PCM to the
// host in ~250 ms blocks with abort checks between them. The app applies its own
// sentence splitting, so the engine no longer chunks.
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
    // multiplier and gain; the engine only forwards the host's live rate slider
    // and applies its volume slider. Speed/voice/gain no longer cross the pipe.
    USHORT volume = 100;
    pOutputSite->GetVolume(&volume);
    long rate = 0;
    pOutputSite->GetRate(&rate);
    // Host SAPI rate -10..10 -> speed 1/3x..3x (log). The app multiplies this by
    // the user's own speed setting before synthesizing.
    float speed = std::pow(3.0f, static_cast<float>(rate) / 10.0f);

    const std::vector<std::wstring> chunks = SplitText(text);
    if (chunks.empty()) return S_OK;
    const size_t kBlock = kSampleRate / 4;  // ~250 ms

    // Prefetch pipeline: synthesize the NEXT chunk on a worker thread while the
    // current one plays, so synthesis time is hidden behind playback and there's
    // no gap at chunk boundaries (SAPI's own buffering isn't enough). Synthesis
    // is serialized by g_synthMutex; on stop we close the pipe to interrupt the
    // in-flight synth, and the next Speak reconnects.
    auto launch = [&](size_t k, float spd) {
        return std::async(std::launch::async, [&chunks, k, spd]() {
            std::vector<float> pcm;
            const std::string utf8 = Narrow(chunks[k]);
            std::lock_guard<std::mutex> lk(g_synthMutex);
            if (!g_worker.Synthesize(utf8, spd, pcm))
                (void)(g_worker.EnsureConnected() && g_worker.Synthesize(utf8, spd, pcm));
            return pcm;  // empty on failure
        });
    };

    std::future<std::vector<float>> pending = launch(0, speed);
    HRESULT result = S_OK;
    for (size_t k = 0; k < chunks.size(); ++k) {
        std::vector<float> pcm = pending.get();

        // Kick off the next chunk's synthesis before writing this one.
        if (k + 1 < chunks.size()) {
            const DWORD a = pOutputSite->GetActions();
            if (a & SPVES_RATE) {
                pOutputSite->GetRate(&rate);
                speed = std::pow(3.0f, static_cast<float>(rate) / 10.0f);
            }
            if (a & SPVES_VOLUME) pOutputSite->GetVolume(&volume);
            pending = launch(k + 1, speed);
        }

        if (pOutputSite->GetActions() & SPVES_ABORT) break;  // stop between chunks
        if (pcm.empty()) {                                   // synthesis failed
            KokoroLog("Speak: synthesis failed (app pipe)");
            result = E_FAIL;
            break;
        }

        // float [-1,1] -> int16 with the host volume applied (the app already
        // applied the user's gain to the PCM). Clamped below.
        const float vol = volume / 100.0f;
        std::vector<short> out(pcm.size());
        for (size_t i = 0; i < pcm.size(); ++i) {
            float s = pcm[i] * vol;
            s = s < -1.f ? -1.f : (s > 1.f ? 1.f : s);
            out[i] = static_cast<short>(s * 32767.f);
        }

        bool aborted = false;
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

    // If a prefetch is still in flight (we stopped early), interrupt it by
    // closing the pipe so the future's destructor returns promptly.
    if (pending.valid()) g_worker.Close();
    return result;
}
