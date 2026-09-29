#include "../src/mac/videoDecoder.mm"
#include <iostream>

int main() {
  using monky::screen::mac::DecoderHardwareObservation;
  try {
    const auto require = [](bool valid) {
      if (!valid) throw std::runtime_error("Unexpected decoder hardware observation.");
    };
    require(DecoderHardwareObservation(noErr, true) == true);
    require(DecoderHardwareObservation(noErr, false) == false);
    for (const auto observed : {std::optional<bool>{}, std::optional<bool>{true}, std::optional<bool>{false}})
      require(!DecoderHardwareObservation(kVTPropertyNotSupportedErr, observed).has_value());
    for (const auto status : {OSStatus(noErr), OSStatus(-50)}) {
      bool rejected = false;
      try { (void)DecoderHardwareObservation(status, std::nullopt); }
      catch (const std::runtime_error& error) {
        rejected = std::string(error.what()).starts_with("ERR_MAC_DECODE_HARDWARE_PROPERTY");
      }
      require(rejected);
    }
    bool rejected = false;
    try { (void)DecoderHardwareObservation(OSStatus(-50), true); }
    catch (const std::runtime_error& error) {
      rejected = std::string(error.what()).find("nativeStatus=-50") != std::string::npos;
    }
    require(rejected);
    std::cout << R"({"passed":true,"unsupportedIsUnknown":true,"otherErrorsRejected":true})" << '\n';
    return 0;
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
