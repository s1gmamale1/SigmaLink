{
  "targets": [
    {
      "target_name": "sigmavoice_mac",
      "sources": [],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": [ "NAPI_VERSION=8" ],
      "conditions": [
        [ "OS==\"mac\"", {
          "sources": [
            "src/sigmavoice_mac.mm",
            "src/recognizer.mm",
            "src/tsfn_bridge.mm"
          ],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "10.15",
            "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
            "OTHER_CPLUSPLUSFLAGS": [
              "-std=c++17",
              "-stdlib=libc++",
              "-fobjc-arc",
              "-fobjc-arc-exceptions",
              "-fexceptions"
            ],
            "OTHER_LDFLAGS": [
              "-framework Speech",
              "-framework AVFoundation",
              "-framework Foundation",
              "-framework AudioToolbox"
            ]
          }
        }]
      ]
    }
  ]
}
