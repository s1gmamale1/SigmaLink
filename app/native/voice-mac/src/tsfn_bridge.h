// tsfn_bridge.h — thin RAII wrapper around Napi::ThreadSafeFunction so
// `recognizer.mm` can post partial / final / error / state events from
// background queues onto the JS event loop without exception unwinding.

#pragma once

#include <napi.h>
#include <string>
#include <memory>

namespace sigmavoice {

/**
 * Holds a TSFN that delivers a single string payload to a JS callback.
 * `Emit()` is non-blocking — when the JS thread is busy and the queue is
 * full the call is dropped silently. This is intentional: dropping a
 * stale partial transcript is cheaper than stalling the audio engine.
 */
class StringEmitter {
public:
  StringEmitter() = default;
  ~StringEmitter() { Release(); }

  StringEmitter(const StringEmitter&) = delete;
  StringEmitter& operator=(const StringEmitter&) = delete;

  /** Bind a JS callback as the destination of `Emit()`. Acquires a TSFN. */
  void Bind(Napi::Function cb, const std::string& name);
  /** Drop the JS reference; subsequent `Emit()` calls are no-ops. */
  void Release();
  /** Send `payload` to the JS thread. No-op when not bound. */
  void Emit(const std::string& payload);
  bool IsBound() const { return tsfn_ != nullptr; }

private:
  Napi::ThreadSafeFunction tsfn_ = nullptr;
};

/**
 * Specialised emitter for the `onError` callback — delivers a {code, message,
 * nativeCode} triple instead of a single string. We keep the arguments as a
 * struct here so the audio thread does not have to allocate Napi::Objects.
 */
struct ErrorPayload {
  std::string code;
  std::string message;
  int nativeCode = 0;
};

class ErrorEmitter {
public:
  ErrorEmitter() = default;
  ~ErrorEmitter() { Release(); }

  ErrorEmitter(const ErrorEmitter&) = delete;
  ErrorEmitter& operator=(const ErrorEmitter&) = delete;

  void Bind(Napi::Function cb, const std::string& name);
  void Release();
  void Emit(const ErrorPayload& payload);
  bool IsBound() const { return tsfn_ != nullptr; }

private:
  Napi::ThreadSafeFunction tsfn_ = nullptr;
};

/**
 * Specialised emitter for raw PCM Float32 audio chunks — delivers a
 * std::vector<float> as a JS Float32Array to the bound callback.
 * Used by the AVAudioEngine PCM tap for whisper.cpp accumulation.
 */
class PcmEmitter {
public:
  PcmEmitter() = default;
  ~PcmEmitter() { Release(); }

  PcmEmitter(const PcmEmitter&) = delete;
  PcmEmitter& operator=(const PcmEmitter&) = delete;

  void Bind(Napi::Function cb, const std::string& name);
  void Release();
  /**
   * Enqueue `count` floats from `data` onto the JS event loop. Non-blocking;
   * drops silently when the queue is saturated (audio thread safety).
   *
   * A1 (hardware sample-rate detection): `sampleRate` is the actual hardware
   * rate reported by AVAudioFormat (fmt.sampleRate from the AVAudioEngine
   * input node). The JS callback receives `{ samples: Float32Array, sampleRate: number }`
   * so callers can resample accurately rather than assuming 48 kHz.
   */
  void Emit(const float* data, size_t count, double sampleRate);
  bool IsBound() const { return tsfn_ != nullptr; }

private:
  Napi::ThreadSafeFunction tsfn_ = nullptr;
};

} // namespace sigmavoice
