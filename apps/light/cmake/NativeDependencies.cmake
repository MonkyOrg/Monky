include(FetchContent)
include("${CMAKE_CURRENT_LIST_DIR}/VerifiedDownload.cmake")

if(CMAKE_VERSION VERSION_GREATER_EQUAL "4.0")
  message(FATAL_ERROR "The pinned SDP dependency requires CMake 3.x; use the qualified 3.31 series.")
endif()

file(READ "${CMAKE_CURRENT_LIST_DIR}/../dependencies.json" MONKY_DEPENDENCY_LOCK)
if(WIN32)
  set(MONKY_SDK_TARGET "windows-${MONKY_LIGHT_TARGET_ARCH}")
else()
  set(MONKY_SDK_TARGET "macos-${MONKY_LIGHT_TARGET_ARCH}")
endif()

foreach(field url sha256 libraryDirectory libraryName)
  string(JSON MONKY_SDK_${field} GET "${MONKY_DEPENDENCY_LOCK}" webrtc targets "${MONKY_SDK_TARGET}" "${field}")
endforeach()

FetchContent_Declare(monky_webrtc_sdk
  URL "${MONKY_SDK_url}"
  URL_HASH "SHA256=${MONKY_SDK_sha256}"
  DOWNLOAD_DIR "${CMAKE_CURRENT_SOURCE_DIR}/build/downloads/${MONKY_SDK_TARGET}"
  TLS_VERIFY TRUE
  DOWNLOAD_EXTRACT_TIMESTAMP FALSE)
FetchContent_MakeAvailable(monky_webrtc_sdk)

set(MONKY_WEBRTC_INCLUDE "${monky_webrtc_sdk_SOURCE_DIR}/include")
set(MONKY_WEBRTC_ORIGINAL_LIBRARY
  "${monky_webrtc_sdk_SOURCE_DIR}/${MONKY_SDK_libraryDirectory}/${MONKY_SDK_libraryName}")
foreach(required
    "${MONKY_WEBRTC_INCLUDE}/api/create_peerconnection_factory.h"
    "${MONKY_WEBRTC_INCLUDE}/api/audio/create_audio_device_module.h"
    "${MONKY_WEBRTC_ORIGINAL_LIBRARY}"
    "${monky_webrtc_sdk_SOURCE_DIR}/NOTICE"
    "${monky_webrtc_sdk_SOURCE_DIR}/VERSION")
  if(NOT EXISTS "${required}")
    message(FATAL_ERROR "The verified WebRTC archive has an unexpected layout: ${required}")
  endif()
endforeach()

set(MONKY_WEBRTC_LINK_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/sdk-link")
file(MAKE_DIRECTORY "${MONKY_WEBRTC_LINK_DIRECTORY}")
# Upstream expects libwebrtc.lib; the verified Windows archive calls it webrtc.lib.
file(COPY_FILE "${MONKY_WEBRTC_ORIGINAL_LIBRARY}"
  "${MONKY_WEBRTC_LINK_DIRECTORY}/libwebrtc${CMAKE_STATIC_LIBRARY_SUFFIX}" ONLY_IF_DIFFERENT)
set(LIBWEBRTC_INCLUDE_PATH "${MONKY_WEBRTC_INCLUDE}")
set(LIBWEBRTC_BINARY_PATH "${MONKY_WEBRTC_LINK_DIRECTORY}")

string(JSON MONKY_SDP_REPOSITORY GET "${MONKY_DEPENDENCY_LOCK}" libsdptransform repository)
string(JSON MONKY_SDP_REVISION GET "${MONKY_DEPENDENCY_LOCK}" libsdptransform revision)
FetchContent_Declare(libsdptransform
  GIT_REPOSITORY "${MONKY_SDP_REPOSITORY}"
  GIT_TAG "${MONKY_SDP_REVISION}"
  EXCLUDE_FROM_ALL
  SYSTEM)
FetchContent_MakeAvailable(libsdptransform)
if(MSVC)
  # The upstream C++14 target also adds a GCC-only flag unconditionally.
  get_target_property(MONKY_SDP_OPTIONS sdptransform COMPILE_OPTIONS)
  if(MONKY_SDP_OPTIONS)
    list(REMOVE_ITEM MONKY_SDP_OPTIONS "-std=c++14")
    set_property(TARGET sdptransform PROPERTY COMPILE_OPTIONS "${MONKY_SDP_OPTIONS}")
  endif()
endif()

string(JSON MONKY_MEDIA_REPOSITORY GET "${MONKY_DEPENDENCY_LOCK}" libmediasoupclient repository)
string(JSON MONKY_MEDIA_REVISION GET "${MONKY_DEPENDENCY_LOCK}" libmediasoupclient revision)
FetchContent_Declare(monky_mediasoupclient
  GIT_REPOSITORY "${MONKY_MEDIA_REPOSITORY}"
  GIT_TAG "${MONKY_MEDIA_REVISION}"
  EXCLUDE_FROM_ALL
  SYSTEM)
set(MEDIASOUPCLIENT_BUILD_TESTS OFF)
set(MEDIASOUPCLIENT_LOG_TRACE OFF)
set(MEDIASOUPCLIENT_LOG_DEV OFF)
FetchContent_MakeAvailable(monky_mediasoupclient)

# Rejected video m-lines legitimately omit feedback/extensions. The upstream
# const operator[] lookup is undefined for missing keys, even in Release builds.
# Compile an exact, hash-checked correction without changing the vendor checkout.
foreach(field sourceSha256 patchedSha256)
  string(JSON MONKY_SDP_FIX_${field} GET "${MONKY_DEPENDENCY_LOCK}"
    libmediasoupclient optionalSdpFields "${field}")
endforeach()
file(READ "${monky_mediasoupclient_SOURCE_DIR}/src/sdp/Utils.cpp" MONKY_SDP_UTILS)
string(REPLACE "\r\n" "\n" MONKY_SDP_UTILS "${MONKY_SDP_UTILS}")
string(SHA256 MONKY_SDP_UTILS_HASH "${MONKY_SDP_UTILS}")
if(NOT MONKY_SDP_UTILS_HASH STREQUAL MONKY_SDP_FIX_sourceSha256)
  message(FATAL_ERROR "The optional SDP field correction does not match this libmediasoupclient source.")
endif()
foreach(field rtcpFb ext)
  string(REPLACE "m[\"${field}\"]" "m.value(\"${field}\", json::array())"
    MONKY_SDP_UTILS "${MONKY_SDP_UTILS}")
endforeach()
string(SHA256 MONKY_SDP_UTILS_HASH "${MONKY_SDP_UTILS}")
if(NOT MONKY_SDP_UTILS_HASH STREQUAL MONKY_SDP_FIX_patchedSha256)
  message(FATAL_ERROR "The corrected SDP capability parser does not match the qualified content.")
endif()
set(MONKY_SDP_FIXED_SOURCE "${CMAKE_CURRENT_BINARY_DIR}/vendor-fixes/mediasoup-sdp-utils.cpp")
set(MONKY_SDP_WRITE_SOURCE TRUE)
if(EXISTS "${MONKY_SDP_FIXED_SOURCE}")
  file(SHA256 "${MONKY_SDP_FIXED_SOURCE}" MONKY_SDP_FIXED_HASH)
  if(MONKY_SDP_FIXED_HASH STREQUAL MONKY_SDP_FIX_patchedSha256)
    set(MONKY_SDP_WRITE_SOURCE FALSE)
  endif()
endif()
if(MONKY_SDP_WRITE_SOURCE)
  file(WRITE "${MONKY_SDP_FIXED_SOURCE}" "${MONKY_SDP_UTILS}")
endif()
get_target_property(MONKY_MEDIA_SOURCES mediasoupclient SOURCES)
list(LENGTH MONKY_MEDIA_SOURCES MONKY_MEDIA_ORIGINAL_SOURCE_COUNT)
list(FILTER MONKY_MEDIA_SOURCES EXCLUDE REGEX "(^|/)src/sdp/Utils\\.cpp$")
list(LENGTH MONKY_MEDIA_SOURCES MONKY_MEDIA_SOURCE_COUNT)
math(EXPR MONKY_MEDIA_EXPECTED_SOURCE_COUNT "${MONKY_MEDIA_ORIGINAL_SOURCE_COUNT} - 1")
if(NOT MONKY_MEDIA_SOURCE_COUNT EQUAL MONKY_MEDIA_EXPECTED_SOURCE_COUNT)
  message(FATAL_ERROR "The libmediasoupclient SDP source registration changed unexpectedly.")
endif()
list(APPEND MONKY_MEDIA_SOURCES "${MONKY_SDP_FIXED_SOURCE}")
set_property(TARGET mediasoupclient PROPERTY SOURCES "${MONKY_MEDIA_SOURCES}")

# The SDK ships FieldTrials headers but omits this public API object from webrtc.lib.
# Compile the unchanged implementation from the exact same upstream revision.
foreach(field url sha256)
  string(JSON MONKY_FIELD_TRIALS_${field} GET "${MONKY_DEPENDENCY_LOCK}" webrtc fieldTrials "${field}")
endforeach()
set(MONKY_WEBRTC_EXTRA_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/_deps/webrtc-api")
file(MAKE_DIRECTORY "${MONKY_WEBRTC_EXTRA_DIRECTORY}")
set(MONKY_FIELD_TRIALS_CACHED
  "${CMAKE_CURRENT_SOURCE_DIR}/build/downloads/${MONKY_SDK_TARGET}/field_trials-${MONKY_FIELD_TRIALS_sha256}.cc")
set(MONKY_FIELD_TRIALS_SOURCE "${MONKY_WEBRTC_EXTRA_DIRECTORY}/field_trials.cc")
monky_download_verified("${MONKY_FIELD_TRIALS_url}" "${MONKY_FIELD_TRIALS_CACHED}" "${MONKY_FIELD_TRIALS_sha256}")
file(COPY_FILE "${MONKY_FIELD_TRIALS_CACHED}" "${MONKY_FIELD_TRIALS_SOURCE}" ONLY_IF_DIFFERENT)
target_sources(mediasoupclient PRIVATE "${MONKY_FIELD_TRIALS_SOURCE}")

target_include_directories(mediasoupclient SYSTEM INTERFACE
  "${monky_mediasoupclient_SOURCE_DIR}/include"
  "${MONKY_WEBRTC_INCLUDE}"
  "${MONKY_WEBRTC_INCLUDE}/third_party/abseil-cpp"
  "${libsdptransform_SOURCE_DIR}/include")

add_library(monky_light_json INTERFACE)
target_include_directories(monky_light_json SYSTEM INTERFACE "${libsdptransform_SOURCE_DIR}/include")

add_library(monky_light_rtc INTERFACE)
target_link_libraries(monky_light_rtc INTERFACE mediasoupclient)
if(WIN32)
  target_link_libraries(monky_light_rtc INTERFACE
    ws2_32 winmm iphlpapi secur32 crypt32 dmoguids wmcodecdspuuid amstrmid msdmo oleaut32 ole32)
  target_compile_definitions(monky_light_rtc INTERFACE _WIN32_WINNT=0x0A00 WINVER=0x0A00)
else()
  foreach(framework ApplicationServices AudioToolbox CoreAudio CoreGraphics Foundation Security)
    find_library(MONKY_${framework}_FRAMEWORK "${framework}" REQUIRED)
    target_link_libraries(monky_light_rtc INTERFACE "${MONKY_${framework}_FRAMEWORK}")
  endforeach()
endif()

set(MONKY_BORINGSSL_INCLUDE "${MONKY_WEBRTC_INCLUDE}/third_party/boringssl/src/include")
