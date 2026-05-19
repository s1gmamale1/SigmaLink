{
  "targets": [
    {
      "target_name": "sigmavoice_win",
      "sources": [],
      "include_dirs": [
        "<!(node -p \"require('node-addon-api').include_dir\")"
      ],
      "defines": [ "NAPI_VERSION=8" ],
      "conditions": [
        [ "OS==\"win\"", {
          "sources": [
            "src/sigmavoice_win.cc",
            "src/recognizer.cc",
            "src/tsfn_bridge.cc"
          ],
          "msvs_settings": {
            "VCCLCompilerTool": {
              "ExceptionHandling": 1,
              "AdditionalOptions": [ "/std:c++17", "/EHsc" ]
            }
          },
          "libraries": [
            "-lsapi.lib",
            "-lole32.lib",
            "-loleaut32.lib"
          ]
        }]
      ]
    }
  ]
}
