cmake_minimum_required(VERSION 3.28)

if(CMAKE_HOST_APPLE AND NOT DEFINED CMAKE_OSX_DEPLOYMENT_TARGET)
  set(CMAKE_OSX_DEPLOYMENT_TARGET "12.0" CACHE STRING "Minimum supported macOS version")
endif()
project(MonkyLight LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(MSVC)
  set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded")
endif()

if(NOT WIN32 AND NOT CMAKE_SYSTEM_NAME STREQUAL "Darwin")
  message(FATAL_ERROR "The initial Monky Light targets are Windows x64 and macOS x64/arm64.")
endif()

set(MONKY_LIGHT_TARGET_ARCH "" CACHE STRING "Native target: x64 or arm64")
if(WIN32)
  if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8 OR NOT MONKY_LIGHT_TARGET_ARCH STREQUAL "x64")
    message(FATAL_ERROR "The Windows Monky Light target must be x64.")
  endif()
  if(CMAKE_VS_PLATFORM_NAME AND NOT CMAKE_VS_PLATFORM_NAME STREQUAL "x64")
    message(FATAL_ERROR "The Visual Studio platform must match the x64 Monky Light target.")
  endif()
elseif(NOT MONKY_LIGHT_TARGET_ARCH MATCHES "^(x64|arm64)$")
  message(FATAL_ERROR "Select macOS x64 or arm64 explicitly.")
elseif(CMAKE_OSX_DEPLOYMENT_TARGET VERSION_LESS "12.0")
  message(FATAL_ERROR "The pinned WebRTC SDK requires macOS 12.0 or newer.")
endif()

get_filename_component(MONKY_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../.." ABSOLUTE)
find_program(MONKY_NODE_EXECUTABLE NAMES node REQUIRED)
set(MONKY_SHARED_DIST "${MONKY_ROOT}/packages/shared/dist")
foreach(contract_source constants.js protocol.js)
  if(NOT EXISTS "${MONKY_SHARED_DIST}/${contract_source}")
    message(FATAL_ERROR "Build @monky/shared first, or use npm run build:light from the repository root.")
  endif()
endforeach()

set(MONKY_GENERATED_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/generated")
set(MONKY_PROTOCOL_HEADER "${MONKY_GENERATED_DIRECTORY}/protocol.hpp")
add_custom_command(
  OUTPUT "${MONKY_PROTOCOL_HEADER}"
  COMMAND "${MONKY_NODE_EXECUTABLE}" "${MONKY_ROOT}/scripts/generate-light-contracts.js"
          --output "${MONKY_PROTOCOL_HEADER}"
  DEPENDS
    "${MONKY_ROOT}/scripts/generate-light-contracts.js"
    "${MONKY_SHARED_DIST}/constants.js"
    "${MONKY_SHARED_DIST}/protocol.js"
  VERBATIM
)
add_custom_target(monky_light_generate_contracts ALL DEPENDS "${MONKY_PROTOCOL_HEADER}")
add_library(monky_light_contracts INTERFACE)
add_dependencies(monky_light_contracts monky_light_generate_contracts)
target_include_directories(monky_light_contracts INTERFACE "${MONKY_GENERATED_DIRECTORY}")

option(MONKY_LIGHT_WITH_RTC "Build and qualify the pinned native RTC dependencies" ON)
if(MONKY_LIGHT_WITH_RTC)
  if(CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_CONFIGURATION_TYPES "Release" CACHE STRING "Qualified native SDK configuration" FORCE)
  elseif(NOT CMAKE_BUILD_TYPE STREQUAL "Release")
    message(FATAL_ERROR "The pinned native SDK is qualified with a Release consumer.")
  endif()
  include(cmake/NativeDependencies.cmake)
  add_executable(monky-light-sdk-check test/sdk_check.cpp)
  target_link_libraries(monky-light-sdk-check PRIVATE monky_light_rtc)
  target_include_directories(monky-light-sdk-check SYSTEM PRIVATE "${MONKY_BORINGSSL_INCLUDE}")
  add_library(monky_light_crypto STATIC src/identity_key.cpp)
  target_include_directories(monky_light_crypto PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
  target_include_directories(monky_light_crypto SYSTEM PRIVATE "${MONKY_BORINGSSL_INCLUDE}")
  target_link_libraries(monky_light_crypto PRIVATE monky_light_rtc)
  add_executable(monky-light-identity-test test/identity_key_test.cpp)
  target_link_libraries(monky-light-identity-test PRIVATE monky_light_crypto)
  add_library(monky_light_profile STATIC src/profile_identity.cpp)
  target_include_directories(monky_light_profile PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
  target_link_libraries(monky_light_profile PRIVATE
    monky_light_crypto monky_light_platform monky_light_json)
  add_executable(monky-light-profile-test test/profile_identity_test.cpp)
  target_link_libraries(monky-light-profile-test PRIVATE
    monky_light_profile monky_light_crypto monky_light_platform monky_light_json)
  set_target_properties(monky-light-profile-test PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/bin")
  add_library(monky_light_fixture_audio STATIC test/fixture_audio_device.cpp)
  target_include_directories(monky_light_fixture_audio PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/test")
  target_link_libraries(monky_light_fixture_audio PUBLIC monky_light_rtc)
  add_executable(monky-light-audio-fixture-test test/fixture_audio_device_test.cpp)
  target_link_libraries(monky-light-audio-fixture-test PRIVATE monky_light_fixture_audio)
  target_include_directories(monky-light-audio-fixture-test PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
  set_target_properties(monky-light-audio-fixture-test PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/bin")
  add_library(monky_light_session STATIC src/protocol_session.cpp)
  target_include_directories(monky_light_session PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
  target_link_libraries(monky_light_session PUBLIC monky_light_contracts monky_light_json)
  add_executable(monky-light-session-test test/protocol_session_test.cpp)
  target_link_libraries(monky-light-session-test PRIVATE monky_light_session)
  set_target_properties(monky-light-session-test PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/bin")
  add_library(monky_light_media STATIC src/media/voice_engine.cpp)
  target_include_directories(monky_light_media PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
  target_link_libraries(monky_light_media PUBLIC monky_light_contracts monky_light_rtc)
  add_executable(monky-light-media-lifecycle-test src/media/voice_engine_lifecycle_test.cpp)
  target_link_libraries(monky-light-media-lifecycle-test PRIVATE monky_light_media)
  add_executable(monky-light-media-loopback-test src/media/voice_engine_loopback_test.cpp)
  target_link_libraries(monky-light-media-loopback-test PRIVATE monky_light_media monky_light_fixture_audio)
  foreach(target monky-light-media-lifecycle-test monky-light-media-loopback-test)
    set_target_properties(${target} PROPERTIES
      RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
      RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/bin")
  endforeach()
  set_target_properties(monky-light-sdk-check PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/bin")
  set_target_properties(monky-light-identity-test PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/bin")
endif()

if(WIN32)
  add_library(monky_light_platform STATIC
    src/platform/identity_store_windows.cpp src/platform/websocket_windows.cpp
    src/platform/audio_device_watcher_windows.cpp)
  target_link_libraries(monky_light_platform PUBLIC Crypt32 Winhttp Ole32)
  target_compile_definitions(monky_light_platform PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
else()
  enable_language(OBJCXX)
  set(CMAKE_OBJCXX_STANDARD 20)
  set(CMAKE_OBJCXX_STANDARD_REQUIRED ON)
  find_library(MONKY_SECURITY_FRAMEWORK Security REQUIRED)
  find_library(MONKY_CORE_FOUNDATION_FRAMEWORK CoreFoundation REQUIRED)
  find_library(MONKY_FOUNDATION_FRAMEWORK Foundation REQUIRED)
  find_library(MONKY_AVFOUNDATION_FRAMEWORK AVFoundation REQUIRED)
  find_library(MONKY_COREAUDIO_FRAMEWORK CoreAudio REQUIRED)
  add_library(monky_light_platform STATIC
    src/platform/identity_store_macos.mm src/platform/websocket_macos.mm src/platform/microphone_access_macos.mm
    src/platform/audio_device_watcher_macos.mm)
  set_source_files_properties(src/platform/websocket_macos.mm src/platform/microphone_access_macos.mm
    src/platform/audio_device_watcher_macos.mm
    PROPERTIES COMPILE_OPTIONS "-fobjc-arc")
  target_link_libraries(monky_light_platform PUBLIC
    "${MONKY_SECURITY_FRAMEWORK}" "${MONKY_CORE_FOUNDATION_FRAMEWORK}" "${MONKY_FOUNDATION_FRAMEWORK}"
    "${MONKY_AVFOUNDATION_FRAMEWORK}" "${MONKY_COREAUDIO_FRAMEWORK}")
endif()
target_include_directories(monky_light_platform PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")

add_executable(monky-light-websocket-fixture test/websocket_fixture.cpp)
target_link_libraries(monky-light-websocket-fixture PRIVATE monky_light_platform)
set_target_properties(monky-light-websocket-fixture PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/bin")
if(APPLE)
  set_target_properties(monky-light-websocket-fixture PROPERTIES
    MACOSX_BUNDLE TRUE
    MACOSX_BUNDLE_GUI_IDENTIFIER "org.monky.light.websocket-fixture"
    MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/resources/Info.plist.in")
endif()

add_library(monky_light_loop STATIC src/application_loop.cpp)
target_include_directories(monky_light_loop PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
add_library(monky_light_console STATIC src/platform/console_control.cpp)
target_include_directories(monky_light_console PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
add_executable(monky-light-console-test test/console_control_test.cpp)
target_link_libraries(monky-light-console-test PRIVATE monky_light_console monky_light_loop)
set_target_properties(monky-light-console-test PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/bin")
add_executable(monky-light-loop-test test/application_loop_test.cpp)
target_link_libraries(monky-light-loop-test PRIVATE monky_light_loop)
set_target_properties(monky-light-loop-test PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/bin")

add_executable(monky-light-platform-test test/identity_store_test.cpp)
target_link_libraries(monky-light-platform-test PRIVATE monky_light_platform)
set_target_properties(monky-light-platform-test PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/bin")

foreach(target monky_light_platform monky-light-platform-test monky_light_loop monky-light-loop-test
    monky_light_console monky-light-console-test monky-light-websocket-fixture)
  if(MSVC)
    target_compile_options(${target} PRIVATE /W4 /WX /EHsc /utf-8 /permissive-)
  else()
    target_compile_options(${target} PRIVATE -Wall -Wextra -Werror)
  endif()
endforeach()
if(MONKY_LIGHT_WITH_RTC)
  add_library(monky_light_application STATIC src/headless_application.cpp)
  target_include_directories(monky_light_application PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/src")
  target_link_libraries(monky_light_application PUBLIC
    monky_light_media monky_light_session monky_light_profile monky_light_console monky_light_loop
    monky_light_platform)
  add_executable(monky-light src/main.cpp)
  target_link_libraries(monky-light PRIVATE monky_light_application)
  if(APPLE)
    set_target_properties(monky-light PROPERTIES
      MACOSX_BUNDLE TRUE
      MACOSX_BUNDLE_GUI_IDENTIFIER "org.monky.light"
      MACOSX_BUNDLE_INFO_PLIST "${CMAKE_CURRENT_SOURCE_DIR}/resources/Info.plist.in")
  endif()
  add_executable(monky-light-fixture test/headless_fixture_main.cpp)
  target_link_libraries(monky-light-fixture PRIVATE monky_light_application monky_light_fixture_audio)
  foreach(target monky-light monky-light-fixture)
    set_target_properties(${target} PROPERTIES
      RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/bin"
      RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_CURRENT_BINARY_DIR}/bin")
  endforeach()
  foreach(target monky_light_crypto monky-light-identity-test
      monky_light_profile monky-light-profile-test monky_light_fixture_audio monky-light-audio-fixture-test
      monky_light_session monky-light-session-test monky_light_media
      monky-light-media-lifecycle-test monky-light-media-loopback-test
      monky_light_application monky-light monky-light-fixture)
    if(MSVC)
      target_compile_options(${target} PRIVATE /W4 /WX /EHsc /utf-8 /permissive-)
    else()
      target_compile_options(${target} PRIVATE -Wall -Wextra -Werror)
    endif()
  endforeach()
endif()
