// tsfn_bridge.mm — RAII helpers for ThreadSafeFunction-backed emitters.
// See tsfn_bridge.h for contract notes. These helpers are pure C++; they
// do not touch any Objective-C runtime — but the file is `.mm` because
// `recognizer.mm` (its only caller) needs the same translation unit
// language to keep linker symbols aligned with ARC.

#include "tsfn_bridge.h"

namespace sigmavoice {

void StringEmitter::Bind(Napi::Function cb, const std::string& name) {
  Release();
  // BUG-C1 — ThreadSafeFunction::New can throw on internal libuv / Napi
  // failures. With C++ exceptions enabled in binding.gyp, we let the
  // exception propagate to the N-API entry point (BindCallback<>) which
  // converts it to a JS exception via ThrowAsJavaScriptException. We
  // ensure the emitter stays in a known state (tsfn_ == nullptr) if the
  // call throws.
  tsfn_ = Napi::ThreadSafeFunction::New(
      cb.Env(),
      cb,
      name.c_str(),
      0,        // max_queue_size: 0 == unlimited; partials are coalesced upstream
      1         // initial_thread_count
  );
}

void StringEmitter::Release() {
  if (tsfn_) {
    tsfn_.Release();
    tsfn_ = nullptr;
  }
}

void StringEmitter::Emit(const std::string& payload) {
  if (!tsfn_) return;
  // Heap-copy the string so the JS callback can outlive this call frame.
  auto* copy = new std::string(payload);
  napi_status status = tsfn_.NonBlockingCall(copy, [](Napi::Env env, Napi::Function js, std::string* p) {
    if (env != nullptr && js != nullptr && p != nullptr) {
      js.Call({ Napi::String::New(env, *p) });
    }
    delete p;
  });
  if (status != napi_ok) {
    // Queue saturated or function closing — clean up the heap copy.
    delete copy;
  }
}

void ErrorEmitter::Bind(Napi::Function cb, const std::string& name) {
  Release();
  // BUG-C1 — see StringEmitter::Bind above. Same propagation contract.
  tsfn_ = Napi::ThreadSafeFunction::New(
      cb.Env(),
      cb,
      name.c_str(),
      0,
      1
  );
}

void ErrorEmitter::Release() {
  if (tsfn_) {
    tsfn_.Release();
    tsfn_ = nullptr;
  }
}

void ErrorEmitter::Emit(const ErrorPayload& payload) {
  if (!tsfn_) return;
  auto* copy = new ErrorPayload(payload);
  napi_status status = tsfn_.NonBlockingCall(copy, [](Napi::Env env, Napi::Function js, ErrorPayload* p) {
    if (env != nullptr && js != nullptr && p != nullptr) {
      Napi::Object obj = Napi::Object::New(env);
      obj.Set("code",       Napi::String::New(env, p->code));
      obj.Set("message",    Napi::String::New(env, p->message));
      obj.Set("nativeCode", Napi::Number::New(env, p->nativeCode));
      js.Call({ obj });
    }
    delete p;
  });
  if (status != napi_ok) {
    delete copy;
  }
}

} // namespace sigmavoice
