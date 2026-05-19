{
  "targets": [
    {
      "target_name": "whisper_bridge",
      "sources": [],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")",
        "vendor/whisper.cpp",
        "vendor/whisper.cpp/include",
        "vendor/whisper.cpp/ggml/include"
      ],
      "defines": [ "NAPI_VERSION=8" ],
      "conditions": [
        [ "OS==\"mac\"", {
          "sources": [
            "src/whisper_bridge.cc",
            "vendor/whisper.cpp/src/whisper.cpp",
            "vendor/whisper.cpp/ggml/src/ggml.c",
            "vendor/whisper.cpp/ggml/src/ggml-alloc.c",
            "vendor/whisper.cpp/ggml/src/ggml-backend.cpp",
            "vendor/whisper.cpp/ggml/src/ggml-metal.m",
            "vendor/whisper.cpp/ggml/src/ggml-quants.c",
            "vendor/whisper.cpp/ggml/src/ggml-aarch64.c",
            "vendor/whisper.cpp/ggml/src/ggml-cpu.c",
            "vendor/whisper.cpp/ggml/src/ggml-cpu.cpp"
          ],
          "defines": [
            "GGML_USE_METAL=1",
            "GGML_METAL_EMBED_LIBRARY",
            "WHISPER_NO_ENCODER_FALLBACK"
          ],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "11.0",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "CLANG_CXX_LIBRARY": "libc++",
            "OTHER_CFLAGS": [
              "-O3",
              "-march=native"
            ],
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++17",
              "-stdlib=libc++",
              "-O3",
              "-march=native",
              "-fexceptions"
            ],
            "OTHER_LDFLAGS": [
              "-framework Foundation",
              "-framework Metal",
              "-framework MetalKit",
              "-framework MetalPerformanceShaders",
              "-framework Accelerate",
              "-framework CoreML"
            ]
          }
        }],
        [ "OS==\"win\"", {
          "sources": [
            "src/whisper_bridge.cc",
            "vendor/whisper.cpp/src/whisper.cpp",
            "vendor/whisper.cpp/ggml/src/ggml.c",
            "vendor/whisper.cpp/ggml/src/ggml-alloc.c",
            "vendor/whisper.cpp/ggml/src/ggml-backend.cpp",
            "vendor/whisper.cpp/ggml/src/ggml-quants.c",
            "vendor/whisper.cpp/ggml/src/ggml-aarch64.c",
            "vendor/whisper.cpp/ggml/src/ggml-cpu.c",
            "vendor/whisper.cpp/ggml/src/ggml-cpu.cpp"
          ],
          "defines": [
            "GGML_USE_CUDA=0"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": ["/std:c++17", "/O2"]
            }
          }
        }],
        [ "OS==\"linux\"", {
          "sources": [
            "src/whisper_bridge.cc",
            "vendor/whisper.cpp/src/whisper.cpp",
            "vendor/whisper.cpp/ggml/src/ggml.c",
            "vendor/whisper.cpp/ggml/src/ggml-alloc.c",
            "vendor/whisper.cpp/ggml/src/ggml-backend.cpp",
            "vendor/whisper.cpp/ggml/src/ggml-quants.c",
            "vendor/whisper.cpp/ggml/src/ggml-aarch64.c",
            "vendor/whisper.cpp/ggml/src/ggml-cpu.c",
            "vendor/whisper.cpp/ggml/src/ggml-cpu.cpp"
          ],
          "cflags": ["-O3", "-std=c99", "-fexceptions"],
          "cflags_cc": ["-O3", "-std=c++17", "-fexceptions"]
        }]
      ]
    }
  ]
}
