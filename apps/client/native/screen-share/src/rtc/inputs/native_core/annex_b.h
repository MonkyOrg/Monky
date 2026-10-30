#pragma once

// The one Annex B walk of H.264 access units: the capture host, the encoded-input source, the elementary-stream
// converter and the decoder adapters each keep their own policy (accepted NAL types, bounds and error codes) on top.

#include <cstddef>
#include <cstdint>
#include <span>

namespace monky::screen_video {

// The length of the start code (00 00 01 or 00 00 00 01) at `at`, or 0.
inline std::size_t AnnexBStartCode(std::span<const std::uint8_t> bytes, std::size_t at) {
  if (at > bytes.size() || bytes.size() - at < 3 || bytes[at] || bytes[at + 1]) return 0;
  if (bytes[at + 2] == 1) return 3;
  return bytes.size() - at >= 4 && !bytes[at + 2] && bytes[at + 3] == 1 ? 4 : 0;
}

enum class AnnexBError { kNone, kNoStartCode, kEmptyNal, kTooManyNals };

// Calls visit(nal) for each NAL, without its start code or the zero bytes that trail it. The walk stops at the first
// structural error, which is returned for the caller to report; exceptions from `visit` propagate unchanged.
template <typename Visit>
AnnexBError ForEachAnnexBNal(std::span<const std::uint8_t> bytes, std::size_t maximum, Visit&& visit) {
  if (!AnnexBStartCode(bytes, 0)) return AnnexBError::kNoStartCode;
  std::size_t position = 0, count = 0;
  while (position < bytes.size()) {
    const auto begin = position + AnnexBStartCode(bytes, position);
    if (++count > maximum) return AnnexBError::kTooManyNals;
    position = begin;
    while (position < bytes.size() && !AnnexBStartCode(bytes, position)) ++position;
    auto end = position;
    while (end > begin && bytes[end - 1] == 0) --end;
    if (end == begin) return AnnexBError::kEmptyNal;
    visit(bytes.subspan(begin, end - begin));
  }
  return AnnexBError::kNone;
}

}  // namespace monky::screen_video
