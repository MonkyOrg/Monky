#include "server_invite.hpp"

#include <algorithm>
#include <array>
#include <cstddef>
#include <stdexcept>
#include <utility>
#include <vector>

namespace monky::light {
namespace {

// The limits and constants of packages/shared/src/serverInvites.ts.
constexpr std::size_t kMaxInviteLength = 16384;
constexpr std::size_t kMaxInviteBytes = 4800;
constexpr std::uint16_t kDefaultPort = 3000;
constexpr std::size_t kServerKeyBytes = 32;
constexpr std::array<std::uint8_t, 3> kExtensionMarker{0x4d, 0x4b, 1};
constexpr std::size_t kExtensionTail = 2 + kExtensionMarker.size();
constexpr std::uint8_t kExtensionTls = 1;
constexpr std::uint8_t kExtensionServerKey = 2;
constexpr std::string_view kSpkiPrefix = "302a300506032b6570032100";
constexpr std::array<std::string_view, 12> kWebPaths{
    "/Monky", "/Monky/", "/Monky/index.html", "/Monky/en", "/Monky/en/", "/Monky/en/index.html",
    "/Monky/convite", "/Monky/convite/", "/Monky/convite/index.html",
    "/Monky/en/convite", "/Monky/en/convite/", "/Monky/en/convite/index.html"};

using Bytes = std::vector<std::uint8_t>;

[[noreturn]] void invalid(const char* reason) {
  throw std::invalid_argument(std::string("Invalid server invitation: ") + reason);
}

char lower(char value) {
  return value >= 'A' && value <= 'Z' ? static_cast<char>(value - 'A' + 'a') : value;
}

std::string lowercase(std::string_view value) {
  std::string result(value);
  std::transform(result.begin(), result.end(), result.begin(), lower);
  return result;
}

constexpr char kHex[] = "0123456789abcdef";

std::string hex(const std::uint8_t* bytes, std::size_t size) {
  std::string result;
  result.reserve(size * 2);
  for (std::size_t index = 0; index < size; ++index) {
    result.push_back(kHex[bytes[index] >> 4]);
    result.push_back(kHex[bytes[index] & 15]);
  }
  return result;
}

// Raw DEFLATE (RFC 1951), bounded like the shared decoder: the output stays below
// kMaxInviteBytes, and data after the final block is ignored, as fflate does.
class Inflater final {
 public:
  Inflater(const std::uint8_t* data, std::size_t size) : data_(data), size_(size) {}

  Bytes run() {
    bool last = false;
    while (!last) {
      last = bits(1) == 1;
      const auto type = bits(2);
      if (type == 0) stored();
      else if (type == 1) fixed();
      else if (type == 2) dynamic();
      else invalid("unknown deflate block");
    }
    return std::move(out_);
  }

 private:
  struct Huffman {
    std::array<std::uint16_t, 16> count{};
    std::vector<std::uint16_t> symbol;
  };

  unsigned bits(unsigned need) {
    if (need == 0) return 0;
    std::uint32_t value = buffer_;
    while (count_ < need) {
      if (position_ >= size_) invalid("truncated deflate stream");
      value |= static_cast<std::uint32_t>(data_[position_++]) << count_;
      count_ += 8;
    }
    buffer_ = value >> need;
    count_ -= need;
    return static_cast<unsigned>(value & ((1u << need) - 1u));
  }

  void emit(std::uint8_t value) {
    if (out_.size() + 1 >= kMaxInviteBytes) invalid("decoded invitation is too large");
    out_.push_back(value);
  }

  void stored() {
    buffer_ = 0;
    count_ = 0;
    if (size_ - position_ < 4) invalid("truncated stored block");
    const unsigned length = data_[position_] | (static_cast<unsigned>(data_[position_ + 1]) << 8);
    const unsigned check = data_[position_ + 2] | (static_cast<unsigned>(data_[position_ + 3]) << 8);
    position_ += 4;
    if (length != (~check & 0xffffu)) invalid("stored block length mismatch");
    if (size_ - position_ < length) invalid("truncated stored block");
    for (unsigned index = 0; index < length; ++index) emit(data_[position_++]);
  }

  static Huffman build(const std::uint8_t* lengths, std::size_t size) {
    Huffman result;
    result.symbol.assign(size, 0);
    for (std::size_t index = 0; index < size; ++index) ++result.count[lengths[index]];
    if (result.count[0] == size) return result;
    int left = 1;
    for (std::size_t length = 1; length < 16; ++length) {
      left <<= 1;
      left -= result.count[length];
      if (left < 0) invalid("oversubscribed Huffman code");
    }
    std::array<std::uint16_t, 16> offsets{};
    for (std::size_t length = 1; length < 15; ++length) {
      offsets[length + 1] = static_cast<std::uint16_t>(offsets[length] + result.count[length]);
    }
    for (std::size_t index = 0; index < size; ++index) {
      if (lengths[index] != 0) result.symbol[offsets[lengths[index]]++] = static_cast<std::uint16_t>(index);
    }
    return result;
  }

  unsigned decode(const Huffman& huffman) {
    int code = 0;
    int first = 0;
    int index = 0;
    for (std::size_t length = 1; length < 16; ++length) {
      code |= static_cast<int>(bits(1));
      const int count = huffman.count[length];
      if (code - count < first) return huffman.symbol[static_cast<std::size_t>(index + (code - first))];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    invalid("invalid Huffman code");
  }

  void codes(const Huffman& lengths, const Huffman& distances) {
    static constexpr std::array<std::uint16_t, 29> lengthBase{
        3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258};
    static constexpr std::array<std::uint8_t, 29> lengthExtra{
        0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0};
    static constexpr std::array<std::uint16_t, 30> distanceBase{
        1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
        4097, 6145, 8193, 12289, 16385, 24577};
    static constexpr std::array<std::uint8_t, 30> distanceExtra{
        0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13};
    for (;;) {
      auto symbol = decode(lengths);
      if (symbol < 256) {
        emit(static_cast<std::uint8_t>(symbol));
        continue;
      }
      if (symbol == 256) return;
      symbol -= 257;
      if (symbol >= lengthBase.size()) invalid("invalid length code");
      const std::size_t length = lengthBase[symbol] + bits(lengthExtra[symbol]);
      const auto distanceSymbol = decode(distances);
      if (distanceSymbol >= distanceBase.size()) invalid("invalid distance code");
      const std::size_t distance = distanceBase[distanceSymbol] + bits(distanceExtra[distanceSymbol]);
      if (distance > out_.size()) invalid("distance before the output");
      for (std::size_t copied = 0; copied < length; ++copied) emit(out_[out_.size() - distance]);
    }
  }

  void fixed() {
    std::array<std::uint8_t, 288> lengths{};
    for (std::size_t index = 0; index < lengths.size(); ++index) {
      lengths[index] = index < 144 ? 8 : index < 256 ? 9 : index < 280 ? 7 : 8;
    }
    std::array<std::uint8_t, 30> distances{};
    distances.fill(5);
    codes(build(lengths.data(), lengths.size()), build(distances.data(), distances.size()));
  }

  void dynamic() {
    static constexpr std::array<std::uint8_t, 19> order{16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15};
    const std::size_t lengthCount = bits(5) + 257;
    const std::size_t distanceCount = bits(5) + 1;
    const std::size_t codeCount = bits(4) + 4;
    if (lengthCount > 286 || distanceCount > 30) invalid("too many deflate codes");
    std::array<std::uint8_t, 19> codeLengths{};
    for (std::size_t index = 0; index < codeCount; ++index) codeLengths[order[index]] = static_cast<std::uint8_t>(bits(3));
    const auto lengthCode = build(codeLengths.data(), codeLengths.size());
    std::array<std::uint8_t, 316> lengths{};
    std::size_t index = 0;
    while (index < lengthCount + distanceCount) {
      const auto symbol = decode(lengthCode);
      if (symbol < 16) {
        lengths[index++] = static_cast<std::uint8_t>(symbol);
        continue;
      }
      std::uint8_t value = 0;
      std::size_t repeat = 0;
      if (symbol == 16) {
        if (index == 0) invalid("repeat without a previous length");
        value = lengths[index - 1];
        repeat = 3 + bits(2);
      } else if (symbol == 17) {
        repeat = 3 + bits(3);
      } else {
        repeat = 11 + bits(7);
      }
      if (index + repeat > lengthCount + distanceCount) invalid("too many code lengths");
      while (repeat-- > 0) lengths[index++] = value;
    }
    if (lengths[256] == 0) invalid("missing end-of-block code");
    codes(build(lengths.data(), lengthCount), build(lengths.data() + lengthCount, distanceCount));
  }

  const std::uint8_t* data_;
  std::size_t size_;
  std::size_t position_ = 0;
  std::uint32_t buffer_ = 0;
  unsigned count_ = 0;
  Bytes out_;
};

int base64Value(char value) {
  if (value >= 'A' && value <= 'Z') return value - 'A';
  if (value >= 'a' && value <= 'z') return value - 'a' + 26;
  if (value >= '0' && value <= '9') return value - '0' + 52;
  if (value == '-') return 62;
  if (value == '_') return 63;
  return -1;
}

// Unpadded base64url, canonical only, as the shared decoder requires.
Bytes base64Url(std::string_view text) {
  if (text.empty() || text.size() % 4 == 1) invalid("malformed token");
  Bytes result;
  result.reserve(text.size() * 3 / 4);
  std::uint32_t buffer = 0;
  unsigned count = 0;
  for (const char character : text) {
    const int value = base64Value(character);
    if (value < 0) invalid("malformed token");
    buffer = (buffer << 6) | static_cast<std::uint32_t>(value);
    count += 6;
    if (count >= 8) {
      count -= 8;
      result.push_back(static_cast<std::uint8_t>((buffer >> count) & 0xffu));
    }
  }
  if ((buffer & ((1u << count) - 1u)) != 0) invalid("non-canonical token");
  return result;
}

// UTF-8 decoded strictly (no overlong forms or surrogates); returns the UTF-16 length,
// which is what the shared schema's string limits count.
std::size_t utf16Length(std::string_view text) {
  std::size_t units = 0;
  for (std::size_t index = 0; index < text.size();) {
    const auto lead = static_cast<std::uint8_t>(text[index]);
    std::size_t extra = 0;
    std::uint32_t point = 0;
    if (lead < 0x80) point = lead;
    else if ((lead & 0xe0) == 0xc0) { extra = 1; point = lead & 0x1fu; }
    else if ((lead & 0xf0) == 0xe0) { extra = 2; point = lead & 0x0fu; }
    else if ((lead & 0xf8) == 0xf0) { extra = 3; point = lead & 0x07u; }
    else invalid("invalid UTF-8");
    if (index + extra >= text.size()) invalid("truncated UTF-8");
    for (std::size_t next = 1; next <= extra; ++next) {
      const auto byte = static_cast<std::uint8_t>(text[index + next]);
      if ((byte & 0xc0) != 0x80) invalid("invalid UTF-8");
      point = (point << 6) | (byte & 0x3fu);
    }
    static constexpr std::array<std::uint32_t, 4> minimum{0, 0x80, 0x800, 0x10000};
    if (point < minimum[extra] || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) invalid("invalid UTF-8");
    units += point >= 0x10000 ? 2 : 1;
    index += extra + 1;
  }
  return units;
}

std::string ipv6(const std::array<std::uint16_t, 8>& pieces) {
  // RFC 5952 / WHATWG URL: the first longest run of two or more zero pieces becomes "::".
  std::size_t bestStart = pieces.size();
  std::size_t bestLength = 1;
  for (std::size_t start = 0; start < pieces.size();) {
    if (pieces[start] != 0) {
      ++start;
      continue;
    }
    std::size_t end = start;
    while (end < pieces.size() && pieces[end] == 0) ++end;
    if (end - start > bestLength) {
      bestStart = start;
      bestLength = end - start;
    }
    start = end;
  }
  std::string result = "[";
  for (std::size_t index = 0; index < pieces.size(); ++index) {
    if (index == bestStart) {
      result += index == 0 ? "::" : ":";
      index += bestLength - 1;
      continue;
    }
    std::string piece;
    for (int shift = 12; shift >= 0; shift -= 4) {
      const auto digit = (pieces[index] >> shift) & 15;
      if (!piece.empty() || digit != 0 || shift == 0) piece.push_back(kHex[digit]);
    }
    result += piece;
    if (index + 1 < pieces.size()) result.push_back(':');
  }
  result.push_back(']');
  return result;
}

std::array<std::uint16_t, 8> parseIpv6(std::string_view text) {
  std::array<std::uint16_t, 8> pieces{};
  const auto gap = text.find("::");
  if (gap != std::string_view::npos && text.find("::", gap + 1) != std::string_view::npos) invalid("invalid IPv6 host");
  const auto parsePart = [](std::string_view part, std::vector<std::uint16_t>& into) {
    if (part.empty()) return;
    std::size_t start = 0;
    for (;;) {
      const auto end = part.find(':', start);
      const auto group = part.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start);
      if (group.empty() || group.size() > 4) invalid("invalid IPv6 host");
      std::uint16_t value = 0;
      for (const char character : group) {
        const auto position = std::string_view(kHex).find(lower(character));
        if (position == std::string_view::npos) invalid("invalid IPv6 host");
        value = static_cast<std::uint16_t>((static_cast<std::size_t>(value) << 4) | position);
      }
      into.push_back(value);
      if (end == std::string_view::npos) return;
      start = end + 1;
    }
  };
  std::vector<std::uint16_t> head;
  std::vector<std::uint16_t> tail;
  parsePart(gap == std::string_view::npos ? text : text.substr(0, gap), head);
  if (gap != std::string_view::npos) parsePart(text.substr(gap + 2), tail);
  if (gap == std::string_view::npos ? head.size() != 8 : head.size() + tail.size() > 7) invalid("invalid IPv6 host");
  std::copy(head.begin(), head.end(), pieces.begin());
  std::copy(tail.begin(), tail.end(), pieces.end() - static_cast<std::ptrdiff_t>(tail.size()));
  return pieces;
}

// A host written as text in the invitation, normalized as the desktop's URL parser does
// for the hosts invitations hold: lowercase ASCII names and IPv4, or a bracketed IPv6.
std::string textHost(const std::string& value) {
  if (value.size() > 2 && value.front() == '[' && value.back() == ']') {
    return ipv6(parseIpv6(std::string_view(value).substr(1, value.size() - 2)));
  }
  if (value.empty() || value.size() > 255) invalid("invalid host");
  for (const char character : value) {
    const char folded = lower(character);
    if (!((folded >= 'a' && folded <= 'z') || (folded >= '0' && folded <= '9') || folded == '-' || folded == '.')) {
      invalid("unsupported host");
    }
  }
  return lowercase(value);
}

class Reader final {
 public:
  explicit Reader(const Bytes& body) : body_(body) {}
  const std::uint8_t* take(std::size_t size) {
    if (body_.size() - offset_ < size) invalid("truncated invitation");
    const auto* bytes = body_.data() + offset_;
    offset_ += size;
    return bytes;
  }
  std::size_t length() {
    const auto first = *take(1);
    if (first < 128) return first;
    const auto next = *take(1);
    if (next == 0 || next >= 128) invalid("invalid field length");
    return static_cast<std::size_t>(first & 127) | (static_cast<std::size_t>(next) << 7);
  }
  std::string text() {
    const auto size = length();
    const auto* bytes = take(size);
    std::string value(reinterpret_cast<const char*>(bytes), size);
    utf16Length(value);
    return value;
  }
  bool finished() const { return offset_ == body_.size(); }

 private:
  const Bytes& body_;
  std::size_t offset_ = 0;
};

ServerInvite readInvite(std::uint8_t header, const Bytes& body) {
  Reader reader(body);
  ServerInvite invite;
  switch (header & 7) {
    case 0: invite.host = textHost(reader.text()); break;
    case 1: {
      const auto* bytes = reader.take(4);
      invite.host = std::to_string(bytes[0]) + "." + std::to_string(bytes[1]) + "." + std::to_string(bytes[2]) + "." +
                    std::to_string(bytes[3]);
      break;
    }
    case 2: {
      const auto* bytes = reader.take(16);
      std::array<std::uint16_t, 8> pieces{};
      for (std::size_t index = 0; index < pieces.size(); ++index) {
        pieces[index] = static_cast<std::uint16_t>((bytes[index * 2] << 8) | bytes[index * 2 + 1]);
      }
      invite.host = ipv6(pieces);
      break;
    }
    case 3: invite.host = "localhost"; break;
    case 4: invite.host = "127.0.0.1"; break;
    case 5: invite.host = "[::1]"; break;
    default: invalid("unknown host encoding");
  }
  if (header & 8) {
    const auto* bytes = reader.take(2);
    invite.port = static_cast<std::uint16_t>((bytes[0] << 8) | bytes[1]);
  } else {
    invite.port = kDefaultPort;
  }
  if (invite.port == 0) invalid("invalid port");
  if (header & 16) {
    invite.name = reader.text();
    const auto units = utf16Length(*invite.name);
    if (units < 1 || units > 100) invalid("invalid name");
  }
  const unsigned passwordMode = (header >> 5) & 3u;
  if (passwordMode == 1) {
    invite.password = reader.text();
  } else if (passwordMode >= 2) {
    const auto digits = reader.length();
    if (digits > 1024) invalid("password is too large");
    const auto* bytes = reader.take((digits + 1) / 2);
    if (digits % 2 && (bytes[(digits + 1) / 2 - 1] & 15)) invalid("invalid hexadecimal padding");
    auto password = hex(bytes, (digits + 1) / 2).substr(0, digits);
    if (passwordMode == 3) {
      std::transform(password.begin(), password.end(), password.begin(), [](char character) {
        return character >= 'a' && character <= 'f' ? static_cast<char>(character - 'a' + 'A') : character;
      });
    }
    invite.password = std::move(password);
  }
  if (invite.password) {
    const auto units = utf16Length(*invite.password);
    if (units < 1 || units > 1024) invalid("invalid password");
    for (const char character : *invite.password) {
      const auto byte = static_cast<std::uint8_t>(character);
      if (byte < 0x20 || byte == 0x7f) invalid("invalid password");
    }
  }
  if (!reader.finished()) invalid("unexpected invitation data");
  return invite;
}

// The extension after the deflate stream (packages/shared/src/serverInvites.ts):
// fields | flags | fields length | "M" "K" | version. Each flag bit announces a field,
// in bit order; unknown bits are skipped, the length tells where the stream ends.
std::optional<ServerInvite> readExtendedInvite(const Bytes& bytes) {
  if (!(bytes[0] & 128) || bytes.size() < 1 + 2 + kExtensionTail ||
      !std::equal(kExtensionMarker.begin(), kExtensionMarker.end(), bytes.end() - kExtensionMarker.size())) {
    return std::nullopt;
  }
  const auto tail = bytes.size() - kExtensionTail;
  const std::uint8_t flags = bytes[tail];
  const std::size_t fieldsLength = bytes[tail + 1];
  if (tail < fieldsLength + 2) return std::nullopt;
  const auto fields = tail - fieldsLength;
  ServerInvite invite;
  try {
    // A stream cut short does not inflate: success means the extension really followed it.
    invite = readInvite(bytes[0], Inflater(bytes.data() + 1, fields - 1).run());
  } catch (const std::invalid_argument&) {
    // A plain invitation whose compressed bytes happen to end like the marker.
    return std::nullopt;
  }
  // A real extension that cannot be read refuses the invitation, rather than dropping a field.
  if (flags & kExtensionTls) invite.tls = true;
  if (flags & kExtensionServerKey) {
    if (fieldsLength < kServerKeyBytes) invalid("truncated invitation extension");
    invite.serverKey = std::string(kSpkiPrefix) + hex(bytes.data() + fields, kServerKeyBytes);
  }
  return invite;
}

ServerInvite decodeToken(std::string_view token) {
  if (token.empty() || token.front() != '~') invalid("missing token");
  std::vector<std::string_view> parts;
  for (std::size_t start = 0;;) {
    const auto end = token.find('.', start);
    parts.push_back(token.substr(start, end == std::string_view::npos ? std::string_view::npos : end - start));
    if (end == std::string_view::npos) break;
    start = end + 1;
  }
  std::optional<std::string> eventId;
  if (parts.size() == 3 && parts[1] == "event" && !parts[2].empty() && parts[2].size() <= 128 &&
      std::all_of(parts[2].begin(), parts[2].end(), [](char character) { return base64Value(character) >= 0; })) {
    eventId = std::string(parts[2]);
  } else if (parts.size() != 1) {
    invalid("unknown token suffix");
  }
  const auto bytes = base64Url(parts[0].substr(1));
  if (bytes.size() > kMaxInviteBytes) invalid("invitation is too large");
  auto keyed = readExtendedInvite(bytes);
  auto invite = keyed ? std::move(*keyed)
                      : readInvite(bytes[0], bytes[0] & 128 ? Inflater(bytes.data() + 1, bytes.size() - 1).run()
                                                            : Bytes(bytes.begin() + 1, bytes.end()));
  invite.eventId = std::move(eventId);
  return invite;
}

std::string_view trim(std::string_view value) {
  const auto blank = [](char character) {
    return character == ' ' || character == '\t' || character == '\n' || character == '\r' || character == '\f' ||
           character == '\v';
  };
  while (!value.empty() && blank(value.front())) value.remove_prefix(1);
  while (!value.empty() && blank(value.back())) value.remove_suffix(1);
  return value;
}

}  // namespace

std::string ServerInvite::serverUrl() const {
  return (tls ? "wss://" : "ws://") + host + ":" + std::to_string(port);
}

bool looksLikeServerInvite(std::string_view value) {
  const auto folded = lowercase(trim(value).substr(0, 32));
  return folded.rfind("monky:", 0) == 0 || folded.rfind("https://monkyorg.github.io/", 0) == 0;
}

ServerInvite parseServerInviteLink(std::string_view link) {
  link = trim(link);
  if (link.empty() || link.size() > kMaxInviteLength) invalid("missing or too long");
  const auto hash = link.find('#');
  if (hash == std::string_view::npos) invalid("missing token");
  const auto location = link.substr(0, hash);
  const auto folded = lowercase(location);
  bool accepted = folded == "monky:" || folded == "monky://" || folded == "monky:///";
  constexpr std::string_view origin = "https://monkyorg.github.io";
  if (!accepted && folded.rfind(origin, 0) == 0) {
    const auto path = location.substr(origin.size());
    accepted = std::find(kWebPaths.begin(), kWebPaths.end(), path) != kWebPaths.end();
  }
  if (!accepted) invalid("not a Monky invitation address");
  return decodeToken(link.substr(hash + 1));
}

}  // namespace monky::light
