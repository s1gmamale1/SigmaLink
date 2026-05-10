// recognizer.h — public surface of the SFSpeechRecognizer wrapper consumed
// by `sigmavoice_mac.mm`. Implementation in `recognizer.mm`.

#pragma once

#include <napi.h>
#include "tsfn_bridge.h"

namespace sigmavoice {

/** Singleton recognizer state. The N-API surface holds one of these for
 *  the lifetime of the addon; the audio engine + recognition task get
 *  swapped in/out on each Start/Stop cycle. */
class Recognizer {
public:
  static Recognizer& Instance();

  void BindPartial(Napi::Function cb)  { partial_.Bind(cb, "voice-mac.onPartial"); }
  void BindFinal(Napi::Function cb)    { final_.Bind(cb, "voice-mac.onFinal"); }
  void BindError(Napi::Function cb)    { error_.Bind(cb, "voice-mac.onError"); }
  void BindState(Napi::Function cb)    { state_.Bind(cb, "voice-mac.onState"); }

  /**
   * Returns true when the binary loaded *and* SFSpeechRecognizer is
   * available on the host OS. Cheap probe — safe to call at startup.
   */
  bool IsAvailable();

  /** Returns one of: 'granted' | 'denied' | 'restricted' | 'not-determined'. */
  std::string GetAuthStatus();

  /** Triggers SFSpeechRecognizer.requestAuthorization on the main queue.
   *  `onResult` is invoked once with the resolved status. */
  void RequestAuthorization(std::function<void(const std::string&)> onResult);

  /** Begin continuous capture. `onError` is the only failure path; on
   *  success the state callback transitions to "listening" before this
   *  function returns. */
  void Start(const std::string& locale, bool onDevice, bool addPunctuation);

  /** Idempotent. Resumes when the audio engine has fully torn down. */
  void Stop();

  /** True while a recognition task is in flight. Used to enforce single-session. */
  bool IsActive();

  // ---- internal: invoked from the SFSpeechRecognitionTask result handler.
  void EmitPartial(const std::string& s) { partial_.Emit(s); }
  void EmitFinal(const std::string& s)   { final_.Emit(s); }
  void EmitError(const ErrorPayload& p)  { error_.Emit(p); }
  void EmitState(const std::string& s)   { state_.Emit(s); }

private:
  Recognizer() = default;
  ~Recognizer() = default;
  Recognizer(const Recognizer&) = delete;
  Recognizer& operator=(const Recognizer&) = delete;

  StringEmitter partial_;
  StringEmitter final_;
  ErrorEmitter  error_;
  StringEmitter state_;
};

} // namespace sigmavoice
