#pragma once

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace monky::light {

// The push-to-talk key, by a platform-neutral name saved in the profile. Each
// platform maps the name onto its own key codes. Keys whose state the system
// keeps (Caps Lock, Num Lock) are left out: holding them would toggle it.
struct PushToTalkKey {
  enum class Kind { keyboard, mouse };
  Kind kind = Kind::keyboard;
  std::string name;
  // Windows virtual-key code (VK_*), or the XBUTTON number for the mouse.
  std::uint16_t windows = 0;
  // macOS virtual key code (kVK_*), or the NSEvent buttonNumber for the mouse.
  // Absent when macOS cannot report that key.
  std::optional<std::uint16_t> mac;
};

namespace push_to_talk_detail {

struct Named {
  std::string_view name;
  std::uint16_t windows;
  std::optional<std::uint16_t> mac;
};

// Windows VK_* and macOS kVK_* (Carbon Events.h) values, written out so this
// header stays platform-free. F21-F24 and Pause have no macOS key code.
inline constexpr std::array<Named, 66> kKeys{{
    {"A", 0x41, 0x00}, {"B", 0x42, 0x0B}, {"C", 0x43, 0x08}, {"D", 0x44, 0x02},
    {"E", 0x45, 0x0E}, {"F", 0x46, 0x03}, {"G", 0x47, 0x05}, {"H", 0x48, 0x04},
    {"I", 0x49, 0x22}, {"J", 0x4A, 0x26}, {"K", 0x4B, 0x28}, {"L", 0x4C, 0x25},
    {"M", 0x4D, 0x2E}, {"N", 0x4E, 0x2D}, {"O", 0x4F, 0x1F}, {"P", 0x50, 0x23},
    {"Q", 0x51, 0x0C}, {"R", 0x52, 0x0F}, {"S", 0x53, 0x01}, {"T", 0x54, 0x11},
    {"U", 0x55, 0x20}, {"V", 0x56, 0x09}, {"W", 0x57, 0x0D}, {"X", 0x58, 0x07},
    {"Y", 0x59, 0x10}, {"Z", 0x5A, 0x06},
    {"0", 0x30, 0x1D}, {"1", 0x31, 0x12}, {"2", 0x32, 0x13}, {"3", 0x33, 0x14},
    {"4", 0x34, 0x15}, {"5", 0x35, 0x17}, {"6", 0x36, 0x16}, {"7", 0x37, 0x1A},
    {"8", 0x38, 0x1C}, {"9", 0x39, 0x19},
    {"F1", 0x70, 0x7A},  {"F2", 0x71, 0x78},  {"F3", 0x72, 0x63},  {"F4", 0x73, 0x76},
    {"F5", 0x74, 0x60},  {"F6", 0x75, 0x61},  {"F7", 0x76, 0x62},  {"F8", 0x77, 0x64},
    {"F9", 0x78, 0x65},  {"F10", 0x79, 0x6D}, {"F11", 0x7A, 0x67}, {"F12", 0x7B, 0x6F},
    {"F13", 0x7C, 0x69}, {"F14", 0x7D, 0x6B}, {"F15", 0x7E, 0x71}, {"F16", 0x7F, 0x6A},
    {"F17", 0x80, 0x40}, {"F18", 0x81, 0x4F}, {"F19", 0x82, 0x50}, {"F20", 0x83, 0x5A},
    {"F21", 0x84, std::nullopt}, {"F22", 0x85, std::nullopt},
    {"F23", 0x86, std::nullopt}, {"F24", 0x87, std::nullopt},
    {"RightControl", 0xA3, 0x3E}, {"RightAlt", 0xA5, 0x3D}, {"RightShift", 0xA1, 0x3C},
    {"Backquote", 0xC0, 0x32}, {"Insert", 0x2D, 0x72}, {"Pause", 0x13, std::nullopt},
}};

}  // namespace push_to_talk_detail

// Returns the key for a saved or typed name, or nullopt when it is unknown.
// A key the current platform cannot report is still a valid name: a profile
// moved between systems keeps it, and the interface says it is unusable.
inline std::optional<PushToTalkKey> parsePushToTalkKey(std::string_view name) {
  // Mouse 4 and 5 are the side buttons: XBUTTON1/2, NSEvent buttons 3/4.
  if (name == "Mouse4") return PushToTalkKey{PushToTalkKey::Kind::mouse, std::string(name), 1, 3};
  if (name == "Mouse5") return PushToTalkKey{PushToTalkKey::Kind::mouse, std::string(name), 2, 4};
  for (const auto& key : push_to_talk_detail::kKeys) {
    if (key.name == name) {
      return PushToTalkKey{PushToTalkKey::Kind::keyboard, std::string(name), key.windows, key.mac};
    }
  }
  return std::nullopt;
}

}  // namespace monky::light
