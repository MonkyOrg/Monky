#include "transport_parameters.h"
#include "peer_support.h"
#include "ortc.hpp"

#include <cctype>
#include <utility>

namespace monky::native_rtc::engine::sfu_detail {

using namespace peer_detail;

ReceiveMidReservations::Reservation::Reservation(Reservation&& other) noexcept
    : history_(std::exchange(other.history_, nullptr)), mid_(std::move(other.mid_)) {}

ReceiveMidReservations::Reservation::~Reservation() {
  if (history_) history_->erase(mid_);
}

ReceiveMidReservations::ReceiveMidReservations(std::size_t limit) : limit_(limit) {
  if (!limit_ || limit_ > kMaxMediaSections) Invalid("Invalid receive MID budget");
}

ReceiveMidReservations::Reservation ReceiveMidReservations::Reserve(Json& parameters) {
  std::string mid;
  if (parameters.contains("mid")) {
    mid = Token(parameters, "mid", 64);
    if (history_.contains(mid)) Invalid("RTP MID is already used by this transport");
  } else {
    for (std::size_t candidate = 0; candidate <= history_.size(); ++candidate) {
      mid = std::to_string(candidate);
      if (!history_.contains(mid)) break;
    }
  }
  if (history_.size() >= limit_)
    throw Error("ERR_RTC_LIMIT", "Receive MID budget exhausted; recreate the transport",
                MONKY_ENGINE_BUSY);
  history_.insert(mid);
  Reservation reservation(history_, std::move(mid));
  parameters["mid"] = reservation.Mid();
  return reservation;
}

void IceCandidates(Json& candidates) {
  if (!candidates.is_array() || candidates.empty() || candidates.size() > kMaxCandidates)
    Invalid("Expected a bounded nonempty ICE candidate array");
  for (auto& candidate : candidates) {
    Keys(candidate, {"foundation", "priority", "ip", "address", "protocol", "port", "type", "tcpType"});
    (void)Token(candidate, "foundation", 64);
    (void)Integer(candidate, "priority", 0, 4294967295ull);
    (void)Integer(candidate, "port", 1, 65535);
    if (candidate.contains("address")) {
      const auto address = Token(candidate, "address", 255);
      if (candidate.contains("ip") && Token(candidate, "ip", 255) != address)
        Invalid("ICE candidate ip/address aliases conflict");
      candidate["ip"] = address;
      candidate.erase("address");
    }
    (void)Token(candidate, "ip", 255);
    const auto protocol = Token(candidate, "protocol", 3);
    if (protocol != "udp" && protocol != "tcp") Invalid("Only UDP/TCP ICE is supported");
    const auto type = Token(candidate, "type", 8);
    if (type != "host" && type != "srflx" && type != "prflx" && type != "relay")
      Invalid("Unsupported ICE candidate type");
    if (protocol == "tcp" || candidate.contains("tcpType")) {
      const auto tcp_type = Token(candidate, "tcpType", 8);
      if (tcp_type != "active" && tcp_type != "passive" && tcp_type != "so")
        Invalid("Unsupported ICE TCP candidate type");
    }
  }
  mediasoupclient::ortc::validateIceCandidates(candidates);
}

void DtlsParameters(Json& parameters) {
  Keys(parameters, {"role", "fingerprints"});
  // role is optional in mediasoup's Node DTO but mandatory in the pinned C++ SDK.
  if (!parameters.contains("role")) parameters["role"] = "auto";
  const auto role = Token(parameters, "role", 8);
  if (role != "auto" && role != "client" && role != "server") Invalid("Unsupported DTLS role");
  if (!parameters.contains("fingerprints") || !parameters.at("fingerprints").is_array() ||
      parameters.at("fingerprints").empty() || parameters.at("fingerprints").size() > 16)
    Invalid("Invalid DTLS fingerprint array");
  Json strong = Json::array();
  for (const auto& fingerprint : parameters.at("fingerprints")) {
    Keys(fingerprint, {"algorithm", "value"});
    const auto algorithm = Token(fingerprint, "algorithm", 16);
    const std::size_t bytes = algorithm == "sha-1" ? 20 : algorithm == "sha-224" ? 28 :
        algorithm == "sha-256" ? 32 : algorithm == "sha-384" ? 48 : algorithm == "sha-512" ? 64 : 0;
    if (!bytes) Invalid("Unsupported DTLS fingerprint algorithm");
    const auto text = Token(fingerprint, "value", 191);
    if (text.size() != bytes * 3 - 1) Invalid("Invalid DTLS fingerprint length");
    for (std::size_t i = 0; i < text.size(); ++i) {
      if ((i % 3 == 2 && text[i] != ':') ||
          (i % 3 != 2 && !std::isxdigit(static_cast<unsigned char>(text[i]))))
        Invalid("Invalid DTLS fingerprint encoding");
    }
    if (bytes >= 32) strong.push_back(fingerprint);
  }
  if (strong.empty()) Unsupported("DTLS requires a SHA-256, SHA-384 or SHA-512 fingerprint");
  // The server also advertises legacy hashes; RemoteSdp selects the last entry.
  // Preserve strong advertised fingerprints without ever selecting a weak one.
  parameters["fingerprints"] = std::move(strong);
  mediasoupclient::ortc::validateDtlsParameters(parameters);
}

}  // namespace monky::native_rtc::engine::sfu_detail
