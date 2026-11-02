#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace monky::light {

// A server invitation link, as the desktop app and the website create them
// (packages/shared/src/serverInvites.ts): https://monkyorg.github.io/Monky/convite/#~<token>
// or monky://#~<token>. The token is a compact binary record; an invitation made for
// server-key-auth (#821) also carries the server's identity key.
struct ServerInvite {
  // Normalized like the desktop's URL parser: a lowercase name, dotted IPv4 or [compressed IPv6].
  std::string host;
  std::uint16_t port = 3000;
  std::optional<std::string> name;
  std::optional<std::string> password;
  // Lowercase Ed25519 SPKI DER hex.
  std::optional<std::string> serverKey;
  std::optional<std::string> eventId;

  // The WebSocket address the desktop app dials for this invitation.
  std::string serverUrl() const;
};

// Whether the value is meant as an invitation (and not as a ws[s]:// address).
bool looksLikeServerInvite(std::string_view value);

// Throws std::invalid_argument for anything the desktop app would not accept as an invitation.
ServerInvite parseServerInviteLink(std::string_view link);

}  // namespace monky::light
