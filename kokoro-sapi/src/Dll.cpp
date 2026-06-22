// In-process COM server for the Kokoro SAPI5 voice.
//
// This file is the bridge between Windows and KokoroTTSEngine:
//   * the class factory SAPI uses to instantiate the engine,
//   * the four exported entry points regsvr32 / COM call
//     (DllGetClassObject, DllCanUnloadNow, DllRegisterServer, DllUnregisterServer),
//   * self-registration that (a) registers the CLSID as an in-proc server and
//     (b) creates the SAPI voice token so the voice appears in the system list.
//
// IMPORTANT: this DLL must be built x86 (32-bit). Kindle.exe is a 32-bit
// full-trust process and loads the engine in-process via ISpVoice, so the COM
// server's bitness must match the host. See kokoro_sapi.def for the undecorated
// exports regsvr32 looks up, and build.ps1 for the 32-bit build invocation.
#include "KokoroTTSEngine.h"
#include "Guids.h"
#include "Log.h"
#include <objbase.h>
#include <olectl.h>   // SELFREG_E_CLASS / SELFREG_E_TYPELIB
#include <strsafe.h>
#include <new>

// Live engine objects (incremented/decremented by KokoroTTSEngine's ctor/dtor)
// and explicit class-factory locks. The DLL may unload only when both are zero.
// g_hInst is shared with KokoroTTSEngine.cpp (locating models next to the DLL).
long      g_cObjects = 0;
HINSTANCE g_hInst    = nullptr;
static long g_cLocks = 0;

// ---- registry layout -----------------------------------------------------
static const wchar_t kTokenKeyPath[] =
    L"SOFTWARE\\Microsoft\\Speech\\Voices\\Tokens\\KokoroTTS";
static const wchar_t kFriendlyName[] = L"Kokoro (SAPI5)";

// ---- class factory --------------------------------------------------------
// A process-lifetime singleton: SAPI only ever needs one factory, so AddRef/
// Release are no-ops that keep it permanently alive (it has static storage).
class KokoroClassFactory : public IClassFactory {
public:
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        if (riid == IID_IUnknown || riid == IID_IClassFactory) {
            *ppv = static_cast<IClassFactory*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() override  { return 2; }
    STDMETHODIMP_(ULONG) Release() override { return 1; }

    STDMETHODIMP CreateInstance(IUnknown* pUnkOuter, REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        *ppv = nullptr;
        if (pUnkOuter) return CLASS_E_NOAGGREGATION;  // we don't support aggregation

        KokoroTTSEngine* engine = new (std::nothrow) KokoroTTSEngine();  // cRef == 1
        if (!engine) return E_OUTOFMEMORY;
        HRESULT hr = engine->QueryInterface(riid, ppv);
        engine->Release();  // QI took its own ref; release our creation ref
        KokoroLog("CreateInstance hr=0x%08lX", hr);
        return hr;
    }

    STDMETHODIMP LockServer(BOOL fLock) override {
        if (fLock) InterlockedIncrement(&g_cLocks);
        else       InterlockedDecrement(&g_cLocks);
        return S_OK;
    }
};

static KokoroClassFactory g_classFactory;

// ---- registry helpers -----------------------------------------------------
// Create (or open) key under HKLM and set one string value; pass name == nullptr
// for the key's (Default) value.
static LONG SetString(const wchar_t* subKey, const wchar_t* name, const wchar_t* value) {
    HKEY hKey = nullptr;
    LONG rc = RegCreateKeyExW(HKEY_LOCAL_MACHINE, subKey, 0, nullptr,
                              REG_OPTION_NON_VOLATILE, KEY_WRITE, nullptr, &hKey, nullptr);
    if (rc != ERROR_SUCCESS) return rc;
    rc = RegSetValueExW(hKey, name, 0, REG_SZ,
                        reinterpret_cast<const BYTE*>(value),
                        static_cast<DWORD>((wcslen(value) + 1) * sizeof(wchar_t)));
    RegCloseKey(hKey);
    return rc;
}

// ---- exported entry points ------------------------------------------------
STDAPI DllGetClassObject(REFCLSID rclsid, REFIID riid, void** ppv) {
    if (rclsid == CLSID_KokoroTTSEngine)
        return g_classFactory.QueryInterface(riid, ppv);
    if (ppv) *ppv = nullptr;
    return CLASS_E_CLASSNOTAVAILABLE;
}

STDAPI DllCanUnloadNow() {
    return (g_cObjects == 0 && g_cLocks == 0) ? S_OK : S_FALSE;
}

// Registers the engine as an in-proc COM server and creates the SAPI voice
// token. Writes to HKLM, so it must run elevated; under the 32-bit regsvr32
// (C:\Windows\SysWOW64\regsvr32.exe) WOW64 redirects these writes to
// WOW6432Node, which is exactly where 32-bit SAPI hosts like Kindle read them.
STDAPI DllRegisterServer() {
    wchar_t dllPath[MAX_PATH];
    if (GetModuleFileNameW(g_hInst, dllPath, MAX_PATH) == 0)
        return HRESULT_FROM_WIN32(GetLastError());

    wchar_t clsid[64];
    if (StringFromGUID2(CLSID_KokoroTTSEngine, clsid, ARRAYSIZE(clsid)) == 0)
        return E_FAIL;

    wchar_t key[256];

    // 1) CLSID\{guid}\InprocServer32 -> this DLL, free-threaded.
    StringCchPrintfW(key, ARRAYSIZE(key), L"SOFTWARE\\Classes\\CLSID\\%s", clsid);
    if (SetString(key, nullptr, kFriendlyName) != ERROR_SUCCESS)
        return SELFREG_E_CLASS;
    StringCchPrintfW(key, ARRAYSIZE(key), L"SOFTWARE\\Classes\\CLSID\\%s\\InprocServer32", clsid);
    if (SetString(key, nullptr, dllPath) != ERROR_SUCCESS ||
        SetString(key, L"ThreadingModel", L"Both") != ERROR_SUCCESS)
        return SELFREG_E_CLASS;

    // 2) SAPI voice token -> points back at our CLSID, plus the attributes the
    //    voice picker and language-matching logic read.
    if (SetString(kTokenKeyPath, nullptr, kFriendlyName) != ERROR_SUCCESS ||
        SetString(kTokenKeyPath, L"CLSID", clsid) != ERROR_SUCCESS)
        return SELFREG_E_TYPELIB;

    StringCchPrintfW(key, ARRAYSIZE(key), L"%s\\Attributes", kTokenKeyPath);
    SetString(key, L"Name",     kFriendlyName);
    SetString(key, L"Vendor",   L"kokoro-reader");
    SetString(key, L"Age",      L"Adult");
    SetString(key, L"Gender",   L"Female");
    SetString(key, L"Language", L"409");  // en-US (LCID 0x0409)

    // Informational default-narrator attribute. The engine no longer reads it —
    // the kokoro-reader app owns the narrator (webview localStorage) and applies
    // it during synthesis — so it carries no asset-dir path and nothing runtime.
    SetString(key, L"VoiceFile", L"af_heart");

    return S_OK;
}

STDAPI DllUnregisterServer() {
    wchar_t clsid[64];
    if (StringFromGUID2(CLSID_KokoroTTSEngine, clsid, ARRAYSIZE(clsid)) == 0)
        return E_FAIL;

    wchar_t key[256];
    StringCchPrintfW(key, ARRAYSIZE(key), L"SOFTWARE\\Classes\\CLSID\\%s", clsid);
    RegDeleteTreeW(HKEY_LOCAL_MACHINE, key);
    RegDeleteTreeW(HKEY_LOCAL_MACHINE, kTokenKeyPath);
    return S_OK;
}

BOOL WINAPI DllMain(HINSTANCE hInst, DWORD reason, LPVOID /*reserved*/) {
    if (reason == DLL_PROCESS_ATTACH) {
        g_hInst = hInst;
        DisableThreadLibraryCalls(hInst);
        wchar_t host[MAX_PATH] = L"?";
        GetModuleFileNameW(nullptr, host, MAX_PATH);
        KokoroLog("DLL_PROCESS_ATTACH host=%ls", host);
    }
    return TRUE;
}
