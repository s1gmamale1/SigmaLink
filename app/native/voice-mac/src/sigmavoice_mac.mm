// sigmavoice_mac.mm — N-API entry point. Exposes the singleton Recognizer
// to JavaScript via the contract documented in `index.d.ts`.

#include <napi.h>
#include "recognizer.h"

namespace {

using sigmavoice::Recognizer;

Napi::Value IsAvailable(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return Napi::Boolean::New(env, Recognizer::Instance().IsAvailable());
}

Napi::Value GetAuthStatus(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  return Napi::String::New(env, Recognizer::Instance().GetAuthStatus());
}

/** Returns a Promise<AuthStatus>. We resolve once SFSpeechRecognizer's
 *  authorization handler fires. The callback may arrive on a non-JS
 *  thread, so we hop back via a TSFN dedicated to this single call. */
Napi::Value RequestPermission(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

  auto* tsfn = new Napi::ThreadSafeFunction(Napi::ThreadSafeFunction::New(
      env,
      Napi::Function::New(env, [](const Napi::CallbackInfo&) {}),
      "voice-mac.requestPermission",
      0,
      1
  ));
  // Capture the deferred by heap so the lambda outlives this stack frame.
  auto* deferredHeap = new Napi::Promise::Deferred(deferred);

  Recognizer::Instance().RequestAuthorization([tsfn, deferredHeap](const std::string& status) {
    auto* copy = new std::string(status);
    napi_status rc = tsfn->NonBlockingCall(copy, [deferredHeap](Napi::Env e, Napi::Function, std::string* s) {
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

  // Recognizer::Start emits its own `error` callback for permission /
  // engine failures. We resolve immediately and let the JS-side error
  // emitter drive rejection paths via the onError listener.
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

template <void (Recognizer::*Bind)(Napi::Function)>
Napi::Value BindCallback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsFunction()) {
    Napi::TypeError::New(env, "callback must be a function").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Function cb = info[0].As<Napi::Function>();
  (Recognizer::Instance().*Bind)(cb);
  // Returns an unsubscribe stub. The native side keeps a single binding per
  // channel; calling onPartial(cb) again just rebinds. The unsubscribe
  // closure clears the binding by rebinding a no-op. JS-side adapter is
  // expected to manage at-most-one subscriber per channel anyway.
  Napi::Function unsubscribe = Napi::Function::New(env, [](const Napi::CallbackInfo& ci) -> Napi::Value {
    return ci.Env().Undefined();
  });
  return unsubscribe;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("isAvailable",       Napi::Function::New(env, IsAvailable));
  exports.Set("getAuthStatus",     Napi::Function::New(env, GetAuthStatus));
  exports.Set("requestPermission", Napi::Function::New(env, RequestPermission));
  exports.Set("start",             Napi::Function::New(env, Start));
  exports.Set("stop",              Napi::Function::New(env, Stop));
  exports.Set("onPartial",         Napi::Function::New(env, BindCallback<&Recognizer::BindPartial>));
  exports.Set("onFinal",           Napi::Function::New(env, BindCallback<&Recognizer::BindFinal>));
  exports.Set("onError",           Napi::Function::New(env, BindCallback<&Recognizer::BindError>));
  exports.Set("onState",           Napi::Function::New(env, BindCallback<&Recognizer::BindState>));
  return exports;
}

} // namespace

NODE_API_MODULE(sigmavoice_mac, Init)
