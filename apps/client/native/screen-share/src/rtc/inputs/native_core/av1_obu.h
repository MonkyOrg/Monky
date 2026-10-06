#pragma once
#include <cstddef>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <vector>

namespace monky::screen_video {
struct Av1PacketInfo {
  bool sequence = false, picture = false, keyframe = false;
  std::vector<std::uint8_t> sequence_header;
};

inline Av1PacketInfo InspectAv1(std::span<const std::uint8_t> bytes) {
  if (bytes.empty() || bytes.size() > 4 * 1024 * 1024)
    throw std::runtime_error("AV1 packet is empty or exceeds its bound");
  Av1PacketInfo result;
  std::size_t cursor = 0, units = 0;
  while (cursor < bytes.size()) {
    const auto begin = cursor;
    const auto header = bytes[cursor++];
    const unsigned type = (header >> 3) & 15;
    if (++units > 4096 || (header & 0x81) || !(header & 2) ||
        (type != 1 && type != 2 && type != 3 && type != 4 && type != 5 && type != 6 && type != 15))
      throw std::runtime_error("Invalid or unsupported low-overhead AV1 OBU");
    if (header & 4) {
      if (cursor == bytes.size() || bytes[cursor++] != 0)
        throw std::runtime_error("AV1 screen transport supports only L1T1");
    }
    std::uint64_t length = 0;
    bool complete = false;
    for (unsigned shift = 0; shift < 56; shift += 7) {
      if (cursor == bytes.size()) throw std::runtime_error("Truncated AV1 OBU size");
      const auto part = bytes[cursor++];
      length |= std::uint64_t{part & 127u} << shift;
      if (!(part & 128)) { complete = true; break; }
    }
    if (!complete || length > bytes.size() - cursor || (!length && type != 2 && type != 15))
      throw std::runtime_error("Invalid AV1 OBU payload size");
    const auto payload = bytes.subspan(cursor, static_cast<std::size_t>(length));
    cursor += static_cast<std::size_t>(length);
    if (type == 1) {
      if (result.sequence || result.picture || (payload[0] >> 5) != 0 || (payload[0] & 8))
        throw std::runtime_error("AV1 requires a Main-profile video sequence before its picture");
      result.sequence = true;
      result.sequence_header.assign(bytes.begin() + begin, bytes.begin() + cursor);
    } else if (type == 3 || type == 6) {
      if (result.picture || (payload[0] & 128))
        throw std::runtime_error("AV1 requires one new displayed picture per packet");
      result.picture = true;
      result.keyframe = ((payload[0] >> 5) & 3) == 0;
      if (!(payload[0] & 16)) throw std::runtime_error("Hidden AV1 pictures are outside the zero-lag contract");
    } else if (type == 4 && !result.picture) {
      throw std::runtime_error("AV1 tile group preceded its frame header");
    }
  }
  return result;
}
}
