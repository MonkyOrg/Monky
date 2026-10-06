#pragma once
#include "av1_obu.h"
#include <string>
#include "third_party/dav1d/libdav1d/include/dav1d/dav1d.h"

namespace monky::screen_video {
inline Dav1dSequenceHeader ReadAv1Sequence(std::span<const std::uint8_t> bytes,
                                          unsigned width = 0, unsigned height = 0) {
  Dav1dSequenceHeader sequence{};
  if (bytes.empty() || bytes.size() > 4 * 1024 * 1024 ||
      dav1d_parse_sequence_header(&sequence, bytes.data(), bytes.size()) != 0)
    throw std::runtime_error("Invalid AV1 sequence header");
  if (sequence.profile != 0 || sequence.layout != DAV1D_PIXEL_LAYOUT_I420 || sequence.hbd ||
      sequence.color_range || sequence.pri != DAV1D_COLOR_PRI_BT709 ||
      sequence.trc != DAV1D_TRC_BT709 || sequence.mtrx != DAV1D_MC_BT709 ||
      sequence.still_picture || sequence.reduced_still_picture_header ||
      sequence.num_operating_points != 1 || sequence.operating_points[0].idc ||
      sequence.operating_points[0].tier || sequence.operating_points[0].major_level > 7)
    throw std::runtime_error("AV1 requires Main 8-bit 4:2:0 BT709 limited-range L1T1; profile=" +
        std::to_string(sequence.profile) + " layout=" + std::to_string(sequence.layout) +
        " hbd=" + std::to_string(sequence.hbd) + " color=" + std::to_string(sequence.pri) + "," +
        std::to_string(sequence.trc) + "," + std::to_string(sequence.mtrx) +
        " range=" + std::to_string(sequence.color_range) + " points=" +
        std::to_string(sequence.num_operating_points) + " idc=" +
        std::to_string(sequence.operating_points[0].idc) + " tier=" +
        std::to_string(sequence.operating_points[0].tier) + " level=" +
        std::to_string(sequence.operating_points[0].major_level));
  if (sequence.max_width < 4 || sequence.max_width > 3840 ||
      sequence.max_height < 2 || sequence.max_height > 2160 ||
      (sequence.max_width & 1) || (sequence.max_height & 1))
    throw std::runtime_error("AV1 sequence dimensions exceed the screen budget");
  // AMF may pad coded dimensions to eight pixels and signal the visible
  // dimensions in each frame's render size.
  if (width && (sequence.max_width < static_cast<int>(width) ||
      sequence.max_width > static_cast<int>((width + 7) & ~7u) ||
      sequence.max_height < static_cast<int>(height) ||
      sequence.max_height > static_cast<int>((height + 7) & ~7u)))
    throw std::runtime_error("AV1 sequence dimensions disagree with the capture profile");
  return sequence;
}
inline std::uint8_t Av1Level(const Dav1dSequenceHeader& sequence) {
  const auto& point = sequence.operating_points[0];
  return static_cast<std::uint8_t>((point.major_level - 2) * 4 + point.minor_level);
}
}
