// recognizer.cc — SAPI5 ISpRecognizer pipeline for SigmaVoice on Windows.
//
// Threading model:
//   - A single dedicated STA worker thread is created at addon init.
//   - CoInitialize(NULL) is called on that thread (STA).
//   - A hidden HWND_MESSAGE window receives WM_APP+1 recognition events
//     via ISpRecoContext::SetNotifyWindowMessage.
//   - GetMessage / DispatchMessage drives the COM event pump.
//   - Recognition results are forwarded back to the JS event loop via
//     Napi::ThreadSafeFunction (non-blocking).
//
// Memory: manual COM lifecycle — IUnknown::Release() calls are issued
// explicitly. No ATL / CComPtr to avoid dependency on MSVS ATL package.

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <sapi.h>
#include <sphelper.h>

#include "recognizer.h"
#include <atomic>
#include <mutex>
#include <string>
#include <functional>

// WM_APP+1 — posted by SAPI5 when a recognition event is ready.
static const UINT WM_SAPI_EVENT = WM_APP + 1;
// WM_APP+2 — posted to the STA thread to request Start.
static const UINT WM_SAPI_START = WM_APP + 2;
// WM_APP+3 — posted to the STA thread to request Stop.
static const UINT WM_SAPI_STOP  = WM_APP + 3;
// WM_APP+4 — posted to request STA thread exit.
static const UINT WM_SAPI_QUIT  = WM_APP + 4;

namespace sigmavoice {

namespace {

// ─── COM helpers ─────────────────────────────────────────────────────────────

/** HRESULT → std::string for error reporting. */
static std::string HRStr(HRESULT hr) {
  char buf[64];
  snprintf(buf, sizeof(buf), "HRESULT 0x%08lX", static_cast<unsigned long>(hr));
  return std::string(buf);
}

// ─── Process-wide SAPI5 COM state ────────────────────────────────────────────

struct SpState {
  ISpRecognizer*  recognizer  = nullptr;
  ISpRecoContext* context     = nullptr;
  ISpRecoGrammar* grammar     = nullptr;
  HWND            hwnd        = nullptr;
  std::string     locale;
  bool            active      = false;
};

static SpState g_sp;

// ─── Mic privacy check (Windows 10+) ─────────────────────────────────────────

/** Query the Windows microphone privacy setting from the registry.
 *  Key: HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager
 *       \ConsentStore\microphone
 *  Value: "Value" REG_SZ — "Allow" | "Deny"
 *  Returns 'granted' | 'denied' | 'not-determined'. */
static std::string QueryMicPrivacy() {
  HKEY hKey = nullptr;
  const wchar_t* kPath =
    L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager"
    L"\\ConsentStore\\microphone";
  LONG rc = RegOpenKeyExW(HKEY_CURRENT_USER, kPath, 0, KEY_READ, &hKey);
  if (rc != ERROR_SUCCESS) {
    // Key absent on older Windows or non-standard configurations.
    return "not-determined";
  }
  wchar_t valueBuf[64] = {};
  DWORD valueSize = sizeof(valueBuf);
  DWORD valueType = REG_SZ;
  rc = RegQueryValueExW(hKey, L"Value", nullptr, &valueType,
                        reinterpret_cast<LPBYTE>(valueBuf), &valueSize);
  RegCloseKey(hKey);
  if (rc != ERROR_SUCCESS) return "not-determined";
  // Normalise: "Allow" → "granted", "Deny" → "denied".
  if (wcscmp(valueBuf, L"Allow") == 0) return "granted";
  if (wcscmp(valueBuf, L"Deny")  == 0) return "denied";
  return "not-determined";
}

// ─── SAPI5 event draining ─────────────────────────────────────────────────────

/** Drain the SAPI5 recognition event queue; called on the STA thread
 *  when WM_SAPI_EVENT arrives. */
static void DrainEvents() {
  if (!g_sp.context) return;

  Recognizer& rec = Recognizer::Instance();

  SPEVENT ev{};
  ULONG   fetched = 0;

  while (SUCCEEDED(g_sp.context->GetEvents(1, &ev, &fetched)) && fetched > 0) {
    if (ev.eEventId == SPEI_RECOGNITION || ev.eEventId == SPEI_FALSE_RECOGNITION) {
      ISpRecoResult* result = reinterpret_cast<ISpRecoResult*>(ev.lParam);
      if (result) {
        if (ev.eEventId == SPEI_FALSE_RECOGNITION) {
          // False recognition — no usable text; stay in listening state.
          result->Release();
          continue;
        }
        // Retrieve the best-guess phrase text.
        wchar_t* pwszText = nullptr;
        HRESULT hr = result->GetText(SP_GETWHOLEPHRASE, SP_GETWHOLEPHRASE,
                                     TRUE, &pwszText, nullptr);
        if (SUCCEEDED(hr) && pwszText) {
          // Convert WCHAR → UTF-8.
          int needed = WideCharToMultiByte(CP_UTF8, 0, pwszText, -1,
                                           nullptr, 0, nullptr, nullptr);
          std::string utf8;
          if (needed > 0) {
            utf8.resize(static_cast<size_t>(needed) - 1);
            WideCharToMultiByte(CP_UTF8, 0, pwszText, -1,
                                utf8.data(), needed, nullptr, nullptr);
          }
          CoTaskMemFree(pwszText);
          rec.EmitFinal(utf8);
          rec.EmitState("final");
          rec.EmitState("listening"); // continuous: stay in listening after each phrase
        } else {
          CoTaskMemFree(pwszText);
        }
        result->Release();
      }
    } else if (ev.eEventId == SPEI_HYPOTHESIS) {
      // Partial (hypothesis) — emit as partial transcript.
      ISpRecoResult* result = reinterpret_cast<ISpRecoResult*>(ev.lParam);
      if (result) {
        wchar_t* pwszText = nullptr;
        HRESULT hr = result->GetText(SP_GETWHOLEPHRASE, SP_GETWHOLEPHRASE,
                                     TRUE, &pwszText, nullptr);
        if (SUCCEEDED(hr) && pwszText) {
          int needed = WideCharToMultiByte(CP_UTF8, 0, pwszText, -1,
                                           nullptr, 0, nullptr, nullptr);
          std::string utf8;
          if (needed > 0) {
            utf8.resize(static_cast<size_t>(needed) - 1);
            WideCharToMultiByte(CP_UTF8, 0, pwszText, -1,
                                utf8.data(), needed, nullptr, nullptr);
          }
          CoTaskMemFree(pwszText);
          rec.EmitPartial(utf8);
          rec.EmitState("partial");
        } else {
          CoTaskMemFree(pwszText);
        }
        result->Release();
      }
    } else if (ev.eEventId == SPEI_END_SR_STREAM) {
      // Stream ended — session torn down externally.
      rec.EmitState("idle");
    }
    // Free any string data attached to the event (SPEI_TRANSLATION etc).
    SpClearEvent(&ev);
  }
}

// ─── STA thread: Start a SAPI5 dictation session ─────────────────────────────

static void DoStart(const std::string& locale) {
  Recognizer& rec = Recognizer::Instance();

  // --- 1. Create shared recogniser ---
  ISpRecognizer* recognizer = nullptr;
  HRESULT hr = CoCreateInstance(CLSID_SpSharedRecognizer, nullptr,
                                CLSCTX_LOCAL_SERVER,
                                IID_ISpRecognizer,
                                reinterpret_cast<void**>(&recognizer));
  if (FAILED(hr)) {
    ErrorPayload p;
    p.code = (hr == E_ACCESSDENIED) ? "no-permission" : "audio-engine-failure";
    p.message = "CoCreateInstance(SpSharedRecognizer): " + HRStr(hr);
    p.nativeCode = static_cast<int>(hr);
    rec.EmitError(p);
    return;
  }

  // --- 2. Create reco context ---
  ISpRecoContext* context = nullptr;
  hr = recognizer->CreateRecoContext(&context);
  if (FAILED(hr)) {
    recognizer->Release();
    ErrorPayload p;
    p.code = (hr == static_cast<HRESULT>(0x80070005L)) ? "no-permission" : "audio-engine-failure";
    p.message = "ISpRecognizer::CreateRecoContext: " + HRStr(hr);
    p.nativeCode = static_cast<int>(hr);
    rec.EmitError(p);
    return;
  }

  // --- 3. Create dictation grammar ---
  ISpRecoGrammar* grammar = nullptr;
  hr = context->CreateGrammar(0, &grammar);
  if (FAILED(hr)) {
    context->Release();
    recognizer->Release();
    ErrorPayload p;
    p.code = "audio-engine-failure";
    p.message = "ISpRecoContext::CreateGrammar: " + HRStr(hr);
    p.nativeCode = static_cast<int>(hr);
    rec.EmitError(p);
    return;
  }

  hr = grammar->LoadDictation(nullptr, SPLO_STATIC);
  if (FAILED(hr)) {
    grammar->Release();
    context->Release();
    recognizer->Release();
    ErrorPayload p;
    p.code = "audio-engine-failure";
    p.message = "ISpRecoGrammar::LoadDictation: " + HRStr(hr);
    p.nativeCode = static_cast<int>(hr);
    rec.EmitError(p);
    return;
  }

  hr = grammar->SetDictationState(SPRS_ACTIVE);
  if (FAILED(hr)) {
    grammar->Release();
    context->Release();
    recognizer->Release();
    ErrorPayload p;
    p.code = "audio-engine-failure";
    p.message = "ISpRecoGrammar::SetDictationState(ACTIVE): " + HRStr(hr);
    p.nativeCode = static_cast<int>(hr);
    rec.EmitError(p);
    return;
  }

  // --- 4. Subscribe to recognition + hypothesis events ---
  const ULONGLONG eventMask =
      SPFEI(SPEI_RECOGNITION)      |
      SPFEI(SPEI_FALSE_RECOGNITION)|
      SPFEI(SPEI_HYPOTHESIS)       |
      SPFEI(SPEI_END_SR_STREAM);
  hr = context->SetInterest(eventMask, eventMask);
  if (FAILED(hr)) {
    grammar->Release();
    context->Release();
    recognizer->Release();
    ErrorPayload p;
    p.code = "audio-engine-failure";
    p.message = "ISpRecoContext::SetInterest: " + HRStr(hr);
    p.nativeCode = static_cast<int>(hr);
    rec.EmitError(p);
    return;
  }

  // --- 5. Wire recognition events to the message-only window ---
  hr = context->SetNotifyWindowMessage(g_sp.hwnd, WM_SAPI_EVENT, 0, 0);
  if (FAILED(hr)) {
    grammar->Release();
    context->Release();
    recognizer->Release();
    ErrorPayload p;
    p.code = "audio-engine-failure";
    p.message = "ISpRecoContext::SetNotifyWindowMessage: " + HRStr(hr);
    p.nativeCode = static_cast<int>(hr);
    rec.EmitError(p);
    return;
  }

  // --- Store state ---
  g_sp.recognizer = recognizer;
  g_sp.context    = context;
  g_sp.grammar    = grammar;
  g_sp.locale     = locale;
  g_sp.active     = true;

  rec.EmitState("listening");
}

// ─── STA thread: Stop the SAPI5 session ──────────────────────────────────────

static void DoStop() {
  if (!g_sp.active) return;

  if (g_sp.grammar) {
    g_sp.grammar->SetDictationState(SPRS_INACTIVE);
    g_sp.grammar->Release();
    g_sp.grammar = nullptr;
  }
  if (g_sp.context) {
    g_sp.context->Release();
    g_sp.context = nullptr;
  }
  if (g_sp.recognizer) {
    g_sp.recognizer->Release();
    g_sp.recognizer = nullptr;
  }
  g_sp.active = false;
  Recognizer::Instance().EmitState("idle");
}

// ─── STA thread struct for WM_SAPI_START payload ─────────────────────────────

struct StartParams {
  std::string locale;
};

// ─── STA hidden window procedure ─────────────────────────────────────────────

static LRESULT CALLBACK STAWndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp) {
  switch (msg) {
    case WM_SAPI_EVENT:
      DrainEvents();
      return 0;
    default:
      return DefWindowProcW(hwnd, msg, wp, lp);
  }
}

// ─── STA thread entry point ───────────────────────────────────────────────────

struct STAThreadState {
  DWORD  main_tid; // JS thread id (not used for PostMessage but kept for symmetry)
};

static DWORD WINAPI STAThreadProc(LPVOID param) {
  // 1. Initialise COM as STA.
  HRESULT hr = CoInitialize(nullptr);
  if (FAILED(hr)) {
    // Cannot proceed without COM.
    return 1;
  }

  // 2. Register a minimal window class for the message-only window.
  WNDCLASSEXW wc = {};
  wc.cbSize        = sizeof(wc);
  wc.lpfnWndProc   = STAWndProc;
  wc.hInstance     = GetModuleHandleW(nullptr);
  wc.lpszClassName = L"SigmaVoiceWinMsgWnd";
  RegisterClassExW(&wc); // Ignore failure — may already be registered.

  // 3. Create the hidden message-only window.
  g_sp.hwnd = CreateWindowExW(
      0,
      L"SigmaVoiceWinMsgWnd",
      L"",
      0,
      0, 0, 0, 0,
      HWND_MESSAGE,
      nullptr,
      GetModuleHandleW(nullptr),
      nullptr);

  // 4. Run the message pump.
  MSG m;
  bool running = true;
  while (running && GetMessageW(&m, nullptr, 0, 0) > 0) {
    if (m.message == WM_SAPI_START) {
      // lParam carries a heap-allocated StartParams*.
      StartParams* sp = reinterpret_cast<StartParams*>(m.lParam);
      if (sp) {
        DoStart(sp->locale);
        delete sp;
      }
    } else if (m.message == WM_SAPI_STOP) {
      DoStop();
    } else if (m.message == WM_SAPI_QUIT) {
      DoStop();
      running = false;
    } else {
      TranslateMessage(&m);
      DispatchMessageW(&m);
    }
  }

  // 5. Clean up.
  if (g_sp.hwnd) {
    DestroyWindow(g_sp.hwnd);
    g_sp.hwnd = nullptr;
  }
  CoUninitialize();
  delete static_cast<STAThreadState*>(param);
  return 0;
}

} // namespace

// ─── Recognizer public API ────────────────────────────────────────────────────

Recognizer& Recognizer::Instance() {
  static Recognizer inst;
  return inst;
}

void Recognizer::StartSTAThread() {
  if (sta_thread_ != nullptr) return;
  auto* state = new STAThreadState{GetCurrentThreadId()};
  sta_thread_ = CreateThread(
      nullptr, 0, STAThreadProc, state, 0, &sta_tid_);
  // Give the STA thread a moment to initialise COM and create the window
  // before any Start() call can arrive. 50 ms is generous; the window
  // creation is synchronous within the first GetMessage spin.
  Sleep(50);
}

void Recognizer::StopSTAThread() {
  if (sta_thread_ == nullptr) return;
  PostThreadMessageW(sta_tid_, WM_SAPI_QUIT, 0, 0);
  WaitForSingleObject(sta_thread_, 5000);
  CloseHandle(sta_thread_);
  sta_thread_ = nullptr;
  sta_tid_    = 0;
}

bool Recognizer::IsAvailable() {
  // Probe: can we CoCreateInstance SpSharedRecognizer?
  // We attempt a quick instantiation on the calling thread (which is the
  // main STA thread of the node process during module init — COM is not yet
  // initialised here, so we use a temporary CoInitialize guard).
  HRESULT comInit = CoInitialize(nullptr);
  bool avail = false;
  {
    ISpRecognizer* probe = nullptr;
    HRESULT hr = CoCreateInstance(CLSID_SpSharedRecognizer, nullptr,
                                  CLSCTX_LOCAL_SERVER,
                                  IID_ISpRecognizer,
                                  reinterpret_cast<void**>(&probe));
    if (SUCCEEDED(hr) && probe) {
      probe->Release();
      avail = true;
    }
  }
  if (SUCCEEDED(comInit)) {
    CoUninitialize();
  }
  return avail;
}

std::string Recognizer::GetAuthStatus() {
  return QueryMicPrivacy();
}

void Recognizer::RequestAuthorization(std::function<void(const std::string&)> onResult) {
  // Windows mic permission is granted inline by SAPI on first use.
  // We return the current registry state; the actual prompt (if any)
  // will appear when ISpRecognizer::CreateRecoContext is called.
  onResult(QueryMicPrivacy());
}

bool Recognizer::IsActive() {
  return active_.load();
}

void Recognizer::Start(const std::string& locale, bool /*onDevice*/, bool /*addPunctuation*/) {
  if (active_.exchange(true)) {
    ErrorPayload p;
    p.code = "voice-busy";
    p.message = "voice-win already has an active session";
    EmitError(p);
    return;
  }
  // Dispatch to the STA thread via PostThreadMessage.
  auto* sp = new StartParams{locale};
  if (!PostThreadMessageW(sta_tid_, WM_SAPI_START, 0,
                          reinterpret_cast<LPARAM>(sp))) {
    delete sp;
    active_.store(false);
    ErrorPayload p;
    p.code = "audio-engine-failure";
    p.message = "PostThreadMessage(WM_SAPI_START) failed";
    p.nativeCode = static_cast<int>(GetLastError());
    EmitError(p);
  }
}

void Recognizer::Stop() {
  if (!active_.load()) return;
  active_.store(false);
  PostThreadMessageW(sta_tid_, WM_SAPI_STOP, 0, 0);
}

} // namespace sigmavoice
