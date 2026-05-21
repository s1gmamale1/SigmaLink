// tsfn_bridge.mm — RAII helpers for ThreadSafeFunction-backed emitters.
// See tsfn_bridge.h for contract notes. These helpers are pure C++; they
// do not touch any Objective-C runtime — but the file is `.mm` because
// `recognizer.mm` (its only caller) needs the same translation unit
// language to keep linker symbols aligned with ARC.

#include "tsfn_bridge.h"
#include <algorithm>
#include <vector>

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

void PcmEmitter::Bind(Napi::Function cb, const std::string& name) {
  Release();
  tsfn_ = Napi::ThreadSafeFunction::New(
      cb.Env(),
      cb,
      name.c_str(),
      0,  // max_queue_size: 0 == unlimited
      1   // initial_thread_count
  );
}

void PcmEmitter::Release() {
  if (tsfn_) {
    tsfn_.Release();
    tsfn_ = nullptr;
  }
}

// A1: PcmChunk carries both the samples and the hardware sample rate.
struct PcmChunk {
  std::vector<float> samples;
  double sampleRate;
};

void PcmEmitter::Emit(const float* data, size_t count, double sampleRate) {
  if (!tsfn_ || count == 0) return;
  // Heap-copy the PCM samples; the audio thread's AVAudioPCMBuffer is
  // recycled by CoreAudio immediately after the tap block returns.
  auto* chunk = new PcmChunk{ std::vector<float>(data, data + count), sampleRate };
  napi_status status = tsfn_.NonBlockingCall(chunk,
      [](Napi::Env env, Napi::Function js, PcmChunk* p) {
    if (env != nullptr && js != nullptr && p != nullptr) {
      // A1: deliver { samples: Float32Array, sampleRate: number } to JS so
      // the whisper resampler can use the actual hardware rate instead of
      // assuming 48 kHz.
      Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, p->samples.size() * sizeof(float));
      float* dst = reinterpret_cast<float*>(ab.Data());
      std::copy(p->samples.begin(), p->samples.end(), dst);
      Napi::Float32Array fa = Napi::Float32Array::New(env, p->samples.size(), ab, 0);
      Napi::Object payload = Napi::Object::New(env);
      payload.Set("samples", fa);
      payload.Set("sampleRate", Napi::Number::New(env, p->sampleRate));
      js.Call({ payload });
    }
    delete p;
  });
  if (status != napi_ok) {
    delete chunk;
  }
}

} // namespace sigmavoice
