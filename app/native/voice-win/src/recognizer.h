// recognizer.h — public surface of the SAPI5 ISpRecognizer wrapper consumed
// by `sigmavoice_win.cc`. Implementation in `recognizer.cc`.

#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <napi.h>
#include "tsfn_bridge.h"
#include <functional>
#include <string>
#include <atomic>

namespace sigmavoice {

/** Singleton recognizer state. The N-API surface holds one of these for
 *  the lifetime of the addon; the SAPI5 session gets swapped in/out on
 *  each Start/Stop cycle.
 *
 *  Threading model:
 *   - All SAPI5 COM objects live on a dedicated STA worker thread.
 *   - JS calls (Start/Stop/RequestPermission) post work to that thread
 *     via PostThreadMessage or direct invocation under a mutex.
 *   - Recognition results are posted back to the JS event loop via
 *     Napi::ThreadSafeFunction (non-blocking). */
class Recognizer {
public:
  static Recognizer& Instance();

  void BindPartial(Napi::Function cb)  { partial_.Bind(cb, "voice-win.onPartial"); }
  void BindFinal(Napi::Function cb)    { final_.Bind(cb, "voice-win.onFinal"); }
  void BindError(Napi::Function cb)    { error_.Bind(cb, "voice-win.onError"); }
  void BindState(Napi::Function cb)    { state_.Bind(cb, "voice-win.onState"); }

  /**
   * Synchronous availability probe. Used only pre-STA-init (before Init()
   * runs). Returns false conservatively when the STA thread is live — use
   * IsAvailableAsync() for post-init queries (runs CoCreateInstance on STA).
   */
  bool IsAvailable();

  /**
   * Asynchronous availability probe. Posts WM_SAPI_PROBE to the STA thread;
   * CoCreateInstance(SpSharedRecognizer) runs there to avoid blocking the JS
   * event loop. Result delivered via TSFN → resolved into `deferred`.
   * Ownership of `deferred` is transferred.
   */
  void IsAvailableAsync(Napi::ThreadSafeFunction tsfn,
                        Napi::Promise::Deferred* deferred);

  /**
   * Returns one of: 'granted' | 'denied' | 'not-determined'.
   * On Windows the mic permission is checked by probing the Windows
   * microphone privacy registry key; actual denial surfaces at
   * ISpRecognizer::CreateRecoContext time as E_ACCESSDENIED.
   */
  std::string GetAuthStatus();

  /**
   * Probes mic permission. On Windows the OS prompts inline on first
   * ISpRecognizer use; this call checks the registry state and resolves
   * the supplied callback with 'granted' | 'denied' | 'not-determined'.
   */
  void RequestAuthorization(std::function<void(const std::string&)> onResult);

  /**
   * Begin continuous dictation capture. `onError` is the only failure
   * path; on success the state callback transitions to "listening" before
   * this function returns. Must be called on the STA worker thread.
   */
  void Start(const std::string& locale, bool onDevice, bool addPunctuation);

  /** Idempotent. Tears down the SAPI5 session. Must be called on the STA
   *  worker thread. */
  void Stop();

  /** True while a recognition session is in flight. */
  bool IsActive();

  // ---- internal: invoked from the SAPI5 event handler on the STA thread.
  void EmitPartial(const std::string& s) { partial_.Emit(s); }
  void EmitFinal(const std::string& s)   { final_.Emit(s); }
  void EmitError(const ErrorPayload& p)  { error_.Emit(p); }
  void EmitState(const std::string& s)   { state_.Emit(s); }

  // ---- STA thread lifecycle. Intentionally not part of the public API;
  //      only sigmavoice_win.cc (Init + env cleanup hook) should call these.
  //      Keeping them at the bottom of the public section (not truly private
  //      to allow the napi cleanup lambda access) but separated from the
  //      JS-facing surface by a comment barrier. (PR #53 caveat 4)
  /** Spin up the dedicated STA worker thread and message pump. */
  void StartSTAThread();
  /** Request a graceful shutdown of the STA thread. */
  void StopSTAThread();

private:
  Recognizer() = default;
  ~Recognizer() = default;
  Recognizer(const Recognizer&) = delete;
  Recognizer& operator=(const Recognizer&) = delete;

  StringEmitter partial_;
  StringEmitter final_;
  ErrorEmitter  error_;
  StringEmitter state_;

  std::atomic<bool> active_{false};

  // STA thread handle + thread id for PostThreadMessage.
  HANDLE sta_thread_{nullptr};
  DWORD  sta_tid_{0};
};

} // namespace sigmavoice
