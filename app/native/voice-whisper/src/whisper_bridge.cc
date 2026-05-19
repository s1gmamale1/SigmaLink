// whisper_bridge.cc — N-API entry point for the voice-whisper native module.
//
// Exposes a single async function `transcribe(audioFloat32, modelPath, opts)`
// that runs whisper.cpp inference on a Float32Array of PCM audio (16 kHz,
// mono) and resolves with `{ text, segments }` once complete.
//
// Threading model: inference runs on a libuv thread-pool worker so the JS
// event loop is never blocked during the (potentially multi-second) CPU/GPU
// pass. Results are marshalled back to the main thread via a Napi::AsyncWorker.
//
// Platform notes:
//   - macOS: compiled with GGML_USE_METAL for GPU acceleration.
//   - Windows/Linux: CPU-only (no CUDA dep for v1.4.9).
//   The module compiles on all three platforms; on win/linux the Metal paths
//   are guarded by preprocessor so the same source compiles cleanly.
//
// Build requirement: whisper.cpp vendored at vendor/whisper.cpp (git
// submodule pinned to v1.7.4). The binding.gyp sources list is the minimal
// set that satisfies a ggml-only CPU + Metal build.

#include <napi.h>
#include <string>
#include <vector>
#include <cstdint>
#include <cstring>

// whisper.cpp public C header
#ifdef __has_include
#  if __has_include("whisper.h")
#    include "whisper.h"
#  else
#    include "whisper.cpp/include/whisper.h"
#  endif
#else
#  include "whisper.h"
#endif

// ---------------------------------------------------------------------------
// Transcription result structures
// ---------------------------------------------------------------------------

struct Segment {
  int64_t t0;   // start time in ms
  int64_t t1;   // end time in ms
  std::string text;
};

struct TranscribeResult {
  std::string text;
  std::vector<Segment> segments;
  std::string error; // non-empty on failure
};

// ---------------------------------------------------------------------------
// Options parsed from JS opts object
// ---------------------------------------------------------------------------

struct TranscribeOpts {
  std::string language   = "en";
  bool        translate  = false;
  int         threads    = 4;
  int         beam_size  = -1; // -1 = default
  bool        word_thold = false;
  float       temperature = 0.0f;
};

static TranscribeOpts ParseOpts(const Napi::Object& obj) {
  TranscribeOpts o;
  if (obj.Has("language") && obj.Get("language").IsString())
    o.language = obj.Get("language").As<Napi::String>().Utf8Value();
  if (obj.Has("translate") && obj.Get("translate").IsBoolean())
    o.translate = obj.Get("translate").As<Napi::Boolean>().Value();
  if (obj.Has("threads") && obj.Get("threads").IsNumber())
    o.threads = obj.Get("threads").As<Napi::Number>().Int32Value();
  if (obj.Has("beamSize") && obj.Get("beamSize").IsNumber())
    o.beam_size = obj.Get("beamSize").As<Napi::Number>().Int32Value();
  if (obj.Has("temperature") && obj.Get("temperature").IsNumber())
    o.temperature = obj.Get("temperature").As<Napi::Number>().FloatValue();
  return o;
}

// ---------------------------------------------------------------------------
// AsyncWorker — inference runs off the event loop
// ---------------------------------------------------------------------------

class TranscribeWorker : public Napi::AsyncWorker {
public:
  TranscribeWorker(
    Napi::Promise::Deferred deferred,
    std::vector<float>      audio,
    std::string             modelPath,
    TranscribeOpts          opts
  )
    : Napi::AsyncWorker(deferred.Env()),
      deferred_(std::move(deferred)),
      audio_(std::move(audio)),
      modelPath_(std::move(modelPath)),
      opts_(std::move(opts))
  {}

  // Runs on the thread-pool (NOT the JS thread)
  void Execute() override {
    whisper_context_params cparams = whisper_context_default_params();
    // Metal acceleration where available (macOS only; no-op on win/linux)
#if defined(GGML_USE_METAL)
    cparams.use_gpu = true;
#else
    cparams.use_gpu = false;
#endif

    whisper_context* ctx = whisper_init_from_file_with_params(modelPath_.c_str(), cparams);
    if (!ctx) {
      SetError("whisper_bridge: failed to load model from " + modelPath_);
      return;
    }

    whisper_full_params params = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
    params.language         = opts_.language.c_str();
    params.translate        = opts_.translate;
    params.n_threads        = opts_.threads;
    params.print_progress   = false;
    params.print_realtime   = false;
    params.print_timestamps = false;
    params.single_segment   = false;
    if (opts_.temperature > 0.0f) {
      params.temperature = opts_.temperature;
    }
    if (opts_.beam_size > 0) {
      params.strategy = WHISPER_SAMPLING_BEAM_SEARCH;
      params.beam_search.beam_size = opts_.beam_size;
    }

    int rc = whisper_full(ctx, params,
                          audio_.data(),
                          static_cast<int>(audio_.size()));
    if (rc != 0) {
      whisper_free(ctx);
      SetError("whisper_bridge: inference failed (rc=" + std::to_string(rc) + ")");
      return;
    }

    const int n_segments = whisper_full_n_segments(ctx);
    for (int i = 0; i < n_segments; ++i) {
      Segment seg;
      seg.t0   = whisper_full_get_segment_t0(ctx, i) * 10; // centiseconds → ms
      seg.t1   = whisper_full_get_segment_t1(ctx, i) * 10;
      const char* txt = whisper_full_get_segment_text(ctx, i);
      seg.text = txt ? std::string(txt) : "";
      result_.segments.push_back(std::move(seg));
    }

    // Concatenate all segments for the top-level text field
    for (const auto& s : result_.segments) {
      if (!s.text.empty() && s.text[0] == ' ')
        result_.text += s.text;
      else
        result_.text += ' ' + s.text;
    }
    // Trim leading space
    if (!result_.text.empty() && result_.text[0] == ' ')
      result_.text = result_.text.substr(1);

    whisper_free(ctx);
  }

  // Runs on the JS thread after Execute completes
  void OnOK() override {
    Napi::Env env = Env();
    Napi::Object out = Napi::Object::New(env);
    out.Set("text", Napi::String::New(env, result_.text));

    Napi::Array segs = Napi::Array::New(env, result_.segments.size());
    for (size_t i = 0; i < result_.segments.size(); ++i) {
      Napi::Object s = Napi::Object::New(env);
      s.Set("t0",   Napi::Number::New(env, static_cast<double>(result_.segments[i].t0)));
      s.Set("t1",   Napi::Number::New(env, static_cast<double>(result_.segments[i].t1)));
      s.Set("text", Napi::String::New(env, result_.segments[i].text));
      segs[i] = s;
    }
    out.Set("segments", segs);
    deferred_.Resolve(out);
  }

  void OnError(const Napi::Error& e) override {
    deferred_.Reject(e.Value());
  }

private:
  Napi::Promise::Deferred deferred_;
  std::vector<float>      audio_;
  std::string             modelPath_;
  TranscribeOpts          opts_;
  TranscribeResult        result_;
};

// ---------------------------------------------------------------------------
// JS-visible `transcribe(audioFloat32, modelPath, opts?) → Promise<{text, segments}>`
// ---------------------------------------------------------------------------

static Napi::Value Transcribe(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  Napi::Promise::Deferred deferred = Napi::Promise::Deferred::New(env);

  // Arg 0: Float32Array of 16 kHz mono PCM
  if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsString()) {
    deferred.Reject(
      Napi::TypeError::New(env,
        "whisper_bridge: transcribe(Float32Array, modelPath[, opts]) required")
      .Value());
    return deferred.Promise();
  }

  Napi::TypedArray typed = info[0].As<Napi::TypedArray>();
  if (typed.TypedArrayType() != napi_float32_array) {
    deferred.Reject(
      Napi::TypeError::New(env, "whisper_bridge: first arg must be Float32Array").Value());
    return deferred.Promise();
  }

  Napi::Float32Array f32 = typed.As<Napi::Float32Array>();
  std::vector<float> audio(f32.Data(), f32.Data() + f32.ElementLength());

  std::string modelPath = info[1].As<Napi::String>().Utf8Value();

  TranscribeOpts opts;
  if (info.Length() > 2 && info[2].IsObject()) {
    opts = ParseOpts(info[2].As<Napi::Object>());
  }

  // Spawn the async worker — execution moves to libuv thread pool
  TranscribeWorker* worker = new TranscribeWorker(
    std::move(deferred), std::move(audio), std::move(modelPath), std::move(opts)
  );
  worker->Queue();

  return deferred.Promise();
}

// ---------------------------------------------------------------------------
// Module init
// ---------------------------------------------------------------------------

static Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("transcribe", Napi::Function::New(env, Transcribe));
  return exports;
}

NODE_API_MODULE(whisper_bridge, Init)
