// recognizer.mm — SFSpeechRecognizer + AVAudioEngine pipeline for SigmaVoice.
//
// Threading model:
//   • Audio buffers arrive on a real-time CoreAudio thread (AVAudioEngine
//     input-node tap).
//   • SFSpeechRecognitionTask result handler fires on a private framework
//     queue.
//   • Both paths marshal into JS via Napi::ThreadSafeFunction (non-blocking)
//     so a slow JS handler can never stall the audio pipeline.
//
// Memory: ARC enabled (`-fobjc-arc`). The Objective-C state lives on a
// single SVRecognizerImpl instance that the C++ Recognizer singleton owns
// via __strong indirection.

#import <Speech/Speech.h>
#import <AVFoundation/AVFoundation.h>
#import <Foundation/Foundation.h>

#include "recognizer.h"
#include <atomic>
#include <string>

// ─── Objective-C wrapper around the recognizer state ────────────────────────

@interface SVRecognizerImpl : NSObject
@property (nonatomic, strong) SFSpeechRecognizer *recognizer;
@property (nonatomic, strong) SFSpeechAudioBufferRecognitionRequest *request;
@property (nonatomic, strong) SFSpeechRecognitionTask *task;
@property (nonatomic, strong) AVAudioEngine *engine;
@property (nonatomic, assign) BOOL active;
@end

@implementation SVRecognizerImpl
@end

namespace sigmavoice {

namespace {

/** Process-wide singleton state. */
SVRecognizerImpl* g_impl() {
  static SVRecognizerImpl* impl = [[SVRecognizerImpl alloc] init];
  return impl;
}

std::atomic<bool> g_active{false};

std::string AuthStatusToString(SFSpeechRecognizerAuthorizationStatus s) {
  switch (s) {
    case SFSpeechRecognizerAuthorizationStatusAuthorized:    return "granted";
    case SFSpeechRecognizerAuthorizationStatusDenied:        return "denied";
    case SFSpeechRecognizerAuthorizationStatusRestricted:    return "restricted";
    case SFSpeechRecognizerAuthorizationStatusNotDetermined: return "not-determined";
  }
  return "not-determined";
}

std::string NSStringToStd(NSString* s) {
  if (s == nil) return std::string();
  return std::string([s UTF8String]);
}

} // namespace

Recognizer& Recognizer::Instance() {
  static Recognizer inst;
  return inst;
}

bool Recognizer::IsAvailable() {
  // Probe for at least one supported locale. If Speech.framework is loaded
  // but the device has no installed recogniser (rare on modern macOS, but
  // possible on stripped-down builds), we report unavailable.
  @autoreleasepool {
    NSSet<NSLocale*>* locales = [SFSpeechRecognizer supportedLocales];
    if (locales == nil) return false;
    return [locales count] > 0;
  }
}

std::string Recognizer::GetAuthStatus() {
  @autoreleasepool {
    return AuthStatusToString([SFSpeechRecognizer authorizationStatus]);
  }
}

void Recognizer::RequestAuthorization(std::function<void(const std::string&)> onResult) {
  // SFSpeechRecognizer.requestAuthorization invokes its handler on an
  // arbitrary queue. We forward to the caller-supplied trampoline; the
  // wrapper in `sigmavoice_mac.mm` is responsible for resolving the JS
  // promise on the JS thread (it does so via TSFN).
  [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
    onResult(AuthStatusToString(status));
  }];
}

bool Recognizer::IsActive() {
  return g_active.load();
}

void Recognizer::Stop() {
  SVRecognizerImpl* impl = g_impl();
  if (!impl.active) {
    g_active.store(false);
    return;
  }
  @autoreleasepool {
    @try {
      if (impl.engine != nil) {
        if (impl.engine.isRunning) {
          [impl.engine stop];
        }
        AVAudioInputNode* input = [impl.engine inputNode];
        if (input != nil) {
          @try {
            [input removeTapOnBus:0];
          } @catch (NSException* _) { /* tap may already be gone */ }
        }
      }
      if (impl.request != nil) {
        [impl.request endAudio];
      }
      if (impl.task != nil) {
        [impl.task cancel];
      }
    } @catch (NSException* ex) {
      ErrorPayload p;
      p.code = "audio-engine-failure";
      p.message = NSStringToStd([ex reason]);
      EmitError(p);
    }
    impl.task = nil;
    impl.request = nil;
    impl.engine = nil;
    impl.active = NO;
  }
  g_active.store(false);
  EmitState("idle");
}

void Recognizer::Start(const std::string& locale, bool onDevice, bool addPunctuation) {
  if (g_active.load()) {
    ErrorPayload p;
    p.code = "voice-busy";
    p.message = "voice-mac already has an active session";
    EmitError(p);
    return;
  }

  @autoreleasepool {
    NSString* loc = [NSString stringWithUTF8String:locale.c_str()];
    NSLocale* nsLocale = [NSLocale localeWithLocaleIdentifier:loc];
    SFSpeechRecognizer* recognizer = [[SFSpeechRecognizer alloc] initWithLocale:nsLocale];

    if (recognizer == nil || !recognizer.isAvailable) {
      ErrorPayload p;
      p.code = "unsupported-locale";
      p.message = std::string("locale not available: ") + locale;
      EmitError(p);
      return;
    }

    // On-device support varies by locale; if requested but unsupported,
    // fall through to server mode and emit a soft warning rather than
    // failing — the dispatcher only cares about the final transcript.
    BOOL requireOnDevice = onDevice;
    if (onDevice) {
      if (@available(macOS 10.15, *)) {
        if (!recognizer.supportsOnDeviceRecognition) {
          requireOnDevice = NO;
        }
      } else {
        requireOnDevice = NO;
      }
    }

    SFSpeechAudioBufferRecognitionRequest* request =
        [[SFSpeechAudioBufferRecognitionRequest alloc] init];
    request.shouldReportPartialResults = YES;
    if (@available(macOS 10.15, *)) {
      request.requiresOnDeviceRecognition = requireOnDevice;
    }
    if (@available(macOS 13.0, *)) {
      request.addsPunctuation = addPunctuation ? YES : NO;
    }

    AVAudioEngine* engine = [[AVAudioEngine alloc] init];
    AVAudioInputNode* input = [engine inputNode];
    AVAudioFormat* fmt = [input outputFormatForBus:0];

    SVRecognizerImpl* impl = g_impl();
    impl.recognizer = recognizer;
    impl.request = request;
    impl.engine = engine;
    impl.active = YES;

    [input installTapOnBus:0
                bufferSize:1024
                    format:fmt
                     block:^(AVAudioPCMBuffer * _Nonnull buffer, AVAudioTime * _Nonnull when) {
      // Audio thread; minimal work.
      SFSpeechAudioBufferRecognitionRequest* req = impl.request;
      if (req != nil) {
        [req appendAudioPCMBuffer:buffer];
      }
    }];

    [engine prepare];
    NSError* engineErr = nil;
    if (![engine startAndReturnError:&engineErr]) {
      ErrorPayload p;
      p.code = "audio-engine-failure";
      p.message = NSStringToStd([engineErr localizedDescription]);
      p.nativeCode = (int)[engineErr code];
      impl.engine = nil;
      impl.request = nil;
      impl.active = NO;
      EmitError(p);
      return;
    }

    g_active.store(true);
    EmitState("listening");

    impl.task = [recognizer recognitionTaskWithRequest:request
                                         resultHandler:^(SFSpeechRecognitionResult * _Nullable result,
                                                         NSError * _Nullable error) {
      if (error != nil) {
        ErrorPayload p;
        // SFSpeech can fire benign "cancelled" errors when we tear the
        // task down via Stop(). Translate domain 209 / -1 into a
        // dedicated code so the JS layer can ignore it.
        NSInteger code = [error code];
        NSString* domain = [error domain];
        bool cancelled = ([domain isEqualToString:@"kAFAssistantErrorDomain"] && (code == 203 || code == 209))
                      || ([domain isEqualToString:NSCocoaErrorDomain] && code == NSUserCancelledError);
        p.code = cancelled ? "recognizer-cancelled" : "unknown";
        p.message = NSStringToStd([error localizedDescription]);
        p.nativeCode = (int)code;
        EmitError(p);
        return;
      }
      if (result == nil) return;
      NSString* transcript = result.bestTranscription.formattedString ?: @"";
      std::string utf8 = NSStringToStd(transcript);
      if (result.isFinal) {
        EmitFinal(utf8);
        EmitState("final");
      } else {
        EmitPartial(utf8);
        EmitState("partial");
      }
    }];
  }
}

} // namespace sigmavoice
