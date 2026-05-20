// sigmavoice_win.cc — N-API entry point. Exposes the singleton Recognizer
// to JavaScript via the contract documented in `index.d.ts`.
//
// Exposed surface (mirrors voice-mac):
//   isAvailable, getAuthStatus, requestPermission,
//   start, stop, onPartial, onFinal, onError, onState

#include <napi.h>
#include "recognizer.h"

namespace {

using sigmavoice::Recognizer;

/**
 * isAvailable() → Promise<boolean>
 *
 * Posts WM_SAPI_PROBE to the STA thread so CoCreateInstance(SpSharedRecognizer)
 * runs there and does not block the JS event loop (PR #53 caveat 2).
 * Falls back to the synchronous probe when called before Init() (STA not yet
 * running), resolving the promise immediately.
 */
Napi::Value IsAvailable(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

  // Create a one-shot TSFN to marshal the result back from the STA thread.
  Napi::ThreadSafeFunction tsfn;
  try {
    tsfn = Napi::ThreadSafeFunction::New(
        env,
        Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
        "voice-win.isAvailable",
        0,
        1
    );
  } catch (const Napi::Error& e) {
    deferred.Reject(Napi::Error::New(env,
        std::string("voice-win: isAvailable TSFN: ") + e.Message()).Value());
    return deferred.Promise();
  }

  auto* deferredHeap = new Napi::Promise::Deferred(deferred);
  Recognizer::Instance().IsAvailableAsync(std::move(tsfn), deferredHeap);
  return deferred.Promise();
}

Napi::Value GetAuthStatus(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return Napi::String::New(env, Recognizer::Instance().GetAuthStatus());
}

/**
 * Returns a Promise<AuthStatus>. On Windows, SAPI5 will prompt the user
 * for microphone access inline on first ISpRecognizer::CreateRecoContext.
 * This call probes the Windows privacy registry key and resolves
 * immediately — no blocking dialog is shown here.
 */
Napi::Value RequestPermission(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

  Napi::ThreadSafeFunction* tsfn = nullptr;
  Napi::Promise::Deferred* deferredHeap = nullptr;
  try {
    tsfn = new Napi::ThreadSafeFunction(Napi::ThreadSafeFunction::New(
        env,
        Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
        "voice-win.requestPermission",
        0,
        1
    ));
    deferredHeap = new Napi::Promise::Deferred(deferred);
  } catch (const Napi::Error& e) {
    delete tsfn;
    delete deferredHeap;
    deferred.Reject(Napi::Error::New(env,
        std::string("voice-win: failed to create TSFN: ") + e.Message()).Value());
    return deferred.Promise();
  } catch (const std::exception& e) {
    delete tsfn;
    delete deferredHeap;
    deferred.Reject(Napi::Error::New(env,
        std::string("voice-win: ") + e.what()).Value());
    return deferred.Promise();
  }

  Recognizer::Instance().RequestAuthorization([tsfn, deferredHeap](const std::string& status) {
    auto* copy = new (std::nothrow) std::string(status);
    if (!copy) {
      tsfn->Release();
      delete tsfn;
      delete deferredHeap;
      return;
    }
    napi_status rc = tsfn->NonBlockingCall(copy,
        [deferredHeap](Napi::Env e, Napi::Function, std::string* s) {
      deferredHeap->Resolve(Napi::String::New(e, *s));
      delete s;
      delete deferredHeap;
    });
    if (rc != napi_ok) {
      delete copy;
      delete deferredHeap;
    }
    tsfn->Release();
    delete tsfn;
  });

  return deferred.Promise();
}

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

  std::string locale = "en-US";
  bool onDevice = true;
  bool addPunctuation = true;

  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();
    if (opts.Has("locale") && opts.Get("locale").IsString()) {
      locale = opts.Get("locale").As<Napi::String>().Utf8Value();
    }
    if (opts.Has("onDevice") && opts.Get("onDevice").IsBoolean()) {
      onDevice = opts.Get("onDevice").As<Napi::Boolean>().Value();
    }
    if (opts.Has("addPunctuation") && opts.Get("addPunctuation").IsBoolean()) {
      addPunctuation = opts.Get("addPunctuation").As<Napi::Boolean>().Value();
    }
  }

  if (Recognizer::Instance().IsActive()) {
    Napi::Error err = Napi::Error::New(env, "voice-busy");
    deferred.Reject(err.Value());
    return deferred.Promise();
  }

  Recognizer::Instance().Start(locale, onDevice, addPunctuation);

  // Recognizer::Start dispatches to the STA thread and emits its own
  // `error` callback for permission / engine failures. We resolve
  // immediately and let the JS-side error emitter drive rejection paths.
  deferred.Resolve(env.Undefined());
  return deferred.Promise();
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);
  Recognizer::Instance().Stop();
  deferred.Resolve(env.Undefined());
  return deferred.Promise();
}

// ─── v1.5.1-B: getFrontmostAppExePath() ─────────────────────────────────────

/**
 * Returns the full executable path of the currently foreground window's
 * owning process using Win32 APIs:
 *   GetForegroundWindow → GetWindowThreadProcessId → QueryFullProcessImageNameW
 *
 * Replaces the 60-120 ms PowerShell cold-start spawn used by output-router.ts
 * (PR #52 caveat 3). Cluster C wires this into output-router.ts; we only
 * ADD the export here.
 *
 * Returns an empty string when the foreground window is the desktop, a
 * UAC-elevated process we cannot open, or when any Win32 call fails.
 */
Napi::Value GetFrontmostAppExePath(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  HWND hwnd = GetForegroundWindow();
  if (!hwnd) {
    return Napi::String::New(env, "");
  }

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid == 0) {
    return Napi::String::New(env, "");
  }

  HANDLE proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!proc) {
    return Napi::String::New(env, "");
  }

  wchar_t buf[MAX_PATH + 1] = {};
  DWORD size = MAX_PATH;
  BOOL ok = QueryFullProcessImageNameW(proc, 0, buf, &size);
  CloseHandle(proc);

  if (!ok || size == 0) {
    return Napi::String::New(env, "");
  }

  // Convert WCHAR path to UTF-8.
  int needed = WideCharToMultiByte(CP_UTF8, 0, buf, static_cast<int>(size),
                                   nullptr, 0, nullptr, nullptr);
  if (needed <= 0) {
    return Napi::String::New(env, "");
  }
  std::string utf8;
  utf8.resize(static_cast<size_t>(needed));
  WideCharToMultiByte(CP_UTF8, 0, buf, static_cast<int>(size),
                      utf8.data(), needed, nullptr, nullptr);
  return Napi::String::New(env, utf8);
}

template <void (Recognizer::*Bind)(Napi::Function)>
Napi::Value BindCallback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "callback must be a function").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Function cb = info[0].As<Napi::Function>();
  // BUG-C1 — ThreadSafeFunction::New (inside Bind) can throw on libuv /
  // queue allocation failure. Catch and surface as a JS exception.
  try {
    (Recognizer::Instance().*Bind)(cb);
  } catch (const Napi::Error& e) {
    Napi::Error::New(env, std::string("voice-win: bind failed: ") + e.Message())
        .ThrowAsJavaScriptException();
    return env.Undefined();
  } catch (const std::exception& e) {
    Napi::Error::New(env, std::string("voice-win: ") + e.what())
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  // Returns an unsubscribe stub. The native side keeps a single binding per
  // channel; calling onPartial(cb) again just rebinds.
  Napi::Function unsubscribe = Napi::Function::New(env,
      [](const Napi::CallbackInfo& ci) -> Napi::Value {
    return ci.Env().Undefined();
  });
  return unsubscribe;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // Spin up the dedicated STA COM thread at module init.
  Recognizer::Instance().StartSTAThread();

  // PR #53 caveat 5: register an env cleanup hook so the STA thread is
  // gracefully torn down on Napi::Env destruction (HMR / dev-reload).
  // Without this the STA thread leaks on hot module replacement because
  // NODE_API_MODULE's destructor is not called on env teardown alone.
  // StopSTAThread() is private (PR #53 caveat 4); Init is declared friend.
  napi_add_env_cleanup_hook(env, [](void* /*arg*/) {
    // Invoke via the friend-accessible path: Init is the friend of Recognizer,
    // so we call the private StopSTAThread through a file-local helper defined
    // in this translation unit which is the friend.
    Recognizer::Instance().StopSTAThread();
  }, nullptr);

  exports.Set("isAvailable",              Napi::Function::New(env, IsAvailable));
  exports.Set("getAuthStatus",            Napi::Function::New(env, GetAuthStatus));
  exports.Set("requestPermission",        Napi::Function::New(env, RequestPermission));
  exports.Set("start",                    Napi::Function::New(env, Start));
  exports.Set("stop",                     Napi::Function::New(env, Stop));
  exports.Set("onPartial",                Napi::Function::New(env, BindCallback<&Recognizer::BindPartial>));
  exports.Set("onFinal",                  Napi::Function::New(env, BindCallback<&Recognizer::BindFinal>));
  exports.Set("onError",                  Napi::Function::New(env, BindCallback<&Recognizer::BindError>));
  exports.Set("onState",                  Napi::Function::New(env, BindCallback<&Recognizer::BindState>));
  // v1.5.1-B — foreground app path helper for output-router (PR #52 caveat 3)
  exports.Set("getFrontmostAppExePath",   Napi::Function::New(env, GetFrontmostAppExePath));
  return exports;
}

} // namespace

NODE_API_MODULE(sigmavoice_win, Init)
