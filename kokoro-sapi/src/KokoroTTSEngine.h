#pragma once
#include <windows.h>
#include <sapi.h>
#include <sapiddk.h>
#include <string>

// The SAPI5 voice engine. SAPI creates one of these (via the class factory in
// Dll.cpp) when an app such as Kindle selects the Kokoro voice, calls
// SetObjectToken() with the voice's registry token, then calls Speak() with the
// text fragments to render into audio.
//
// M0: Speak() emits a placeholder sine tone so we can prove the whole COM /
// registration / host-app pipeline before wiring in real Kokoro inference (M1).
class KokoroTTSEngine : public ISpTTSEngine, public ISpObjectWithToken {
public:
    KokoroTTSEngine();
    virtual ~KokoroTTSEngine();

    // IUnknown
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv);
    STDMETHODIMP_(ULONG) AddRef();
    STDMETHODIMP_(ULONG) Release();

    // ISpTTSEngine
    STDMETHODIMP Speak(DWORD dwSpeakFlags, REFGUID rguidFormatId,
        const WAVEFORMATEX* pWaveFormatEx, const SPVTEXTFRAG* pTextFragList,
        ISpTTSEngineSite* pOutputSite);
    STDMETHODIMP GetOutputFormat(const GUID* pTargetFmtId,
        const WAVEFORMATEX* pTargetWaveFormatEx, GUID* pOutputFormatId,
        WAVEFORMATEX** ppCoMemOutputWaveFormatEx);

    // ISpObjectWithToken
    STDMETHODIMP SetObjectToken(ISpObjectToken* pToken);
    STDMETHODIMP GetObjectToken(ISpObjectToken** ppToken);

private:
    // Connects to the running app's synthesis pipe (no local model/voice state).
    bool EnsureSynth();

    LONG            m_cRef;
    ISpObjectToken* m_pToken;  // the voice token SAPI handed us (owned, AddRef'd)
};
