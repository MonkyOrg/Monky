{
  "targets": [
    {
      "target_name": "screen_audio",
      "cflags!": ["-fno-exceptions"],
      "cflags_cc!": ["-fno-exceptions"],
      "defines": ["NAPI_DISABLE_CPP_EXCEPTIONS"],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "sources": ["src/screen_audio.cc"],
      "conditions": [
        [
          "OS=='win'",
          {
            "configurations": {
              "Release": {
                "msbuild_toolset": "v143",
                "msvs_settings": {
                  "VCCLCompilerTool": { "RuntimeLibrary": 2, "RuntimeTypeInfo": "true" }
                }
              },
              "Debug": {
                "msbuild_toolset": "v143",
                "msvs_settings": {
                  "VCCLCompilerTool": { "RuntimeTypeInfo": "true" }
                }
              }
            },
            "sources": [
              "src/win/wasapi_loopback.cpp",
              "src/win/wasapi_capture.cpp",
              "src/win/wasapi_format.cpp",
              "src/win/packet_capture.cpp",
              "src/win/window_enum.cpp",
              "src/win/keyboard_layout.cpp"
            ],
            "defines!": ["_HAS_EXCEPTIONS=0"],
            "defines": ["NAPI_VERSION=8", "_HAS_EXCEPTIONS=1", "WIN32_LEAN_AND_MEAN", "NOMINMAX"],
            "libraries": [
              "-lMmdevapi",
              "-lOle32",
              "-lAvrt",
              "-lKsuser",
              "-lUser32",
              "-lDwmapi"
            ],
            "msvs_settings": {
              "VCCLCompilerTool": {
                "ExceptionHandling": 1,
                "RuntimeTypeInfo": "true",
                "AdditionalOptions": ["/std:c++17"]
              }
            }
          }
        ],
        [
          "OS=='mac'",
          {
            "sources": ["src/mac/sc_capture.mm", "src/mac/window_owners.mm"],
            "xcode_settings": {
              "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
              "CLANG_ENABLE_OBJC_ARC": "YES",
              "OTHER_CPLUSPLUSFLAGS": ["-std=c++17"],
              "OTHER_LDFLAGS": [
                "-framework ScreenCaptureKit",
                "-framework CoreMedia",
                "-framework AVFoundation",
                "-framework Foundation",
                "-framework CoreGraphics",
                "-framework AppKit",
                "-framework CoreAudio"
              ]
            },
            "defines": ["__MACOS__"]
          }
        ]
      ]
    }
  ]
}
