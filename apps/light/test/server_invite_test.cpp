#include "server_invite.hpp"

#include <iostream>
#include <stdexcept>
#include <string>

namespace {

using monky::light::parseServerInviteLink;

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

bool rejected(const std::string& link) {
  try {
    (void)parseServerInviteLink(link);
  } catch (const std::invalid_argument&) {
    return true;
  }
  return false;
}

std::string hexText(const std::string& value) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result;
  for (const char character : value) {
    const auto byte = static_cast<unsigned char>(character);
    result.push_back(digits[byte >> 4]);
    result.push_back(digits[byte & 15]);
  }
  return result;
}

// Fixed invitations from packages/shared, so the decoder is checked without a JavaScript runtime.
void decodesKnownInvitations() {
  const auto bare = parseServerInviteLink("monky://#~Aw");
  require(bare.host == "localhost" && bare.port == 3000 && !bare.name && !bare.password && !bare.serverKey,
          "The smallest invitation did not decode");
  require(bare.serverUrl() == "ws://localhost:3000", "The invitation address is not the desktop's");
  // Behind a TLS reverse proxy (#829): the flag rides in the extension after the deflate stream.
  const auto tls = parseServerInviteLink("monky://#~iBPMzc_LrtRLrUjMLchJ1UvOz2XcDQABAE1LAQ");
  require(tls.tls && !tls.serverKey && tls.serverUrl() == "wss://monky.example.com:443",
          "A TLS invitation did not decode to a wss address");
  require(parseServerInviteLink("  https://monkyorg.github.io/Monky/en/convite/#~Aw.event.event-1  ").eventId ==
              std::optional<std::string>("event-1"),
          "A web invitation with an event did not decode");
  require(monky::light::looksLikeServerInvite("MONKY://#~Aw") &&
              monky::light::looksLikeServerInvite("https://monkyorg.github.io/Monky/convite/#~Aw") &&
              !monky::light::looksLikeServerInvite("ws://203.0.113.7:3000"),
          "Invitations and addresses are told apart");
  for (const auto* link : {"monky://#Aw", "monky://#~Aw.event.", "monky://#~Aw.other.x", "monky://#~A",
                           "monky://#~Ax", "monky://#~A*", "monky://host#~Aw", "https://example.com/Monky/#~Aw",
                           "https://monkyorg.github.io/Monky/other/#~Aw", "monky://#~Bw", "monky://#~"}) {
    require(rejected(link), link);
  }
}

void decodeFixture() {
  std::string line;
  while (std::getline(std::cin, line)) {
    try {
      const auto invite = parseServerInviteLink(line);
      std::cout << "ok " << invite.host << ' ' << invite.port << ' ' << (invite.name ? hexText(*invite.name) : "-")
                << ' ' << (invite.password ? hexText(*invite.password) : "-") << ' '
                << invite.serverKey.value_or("-") << ' ' << invite.eventId.value_or("-") << ' ' << invite.serverUrl()
                << std::endl;
    } catch (const std::invalid_argument&) {
      std::cout << "invalid" << std::endl;
    }
  }
  require(std::cin.eof(), "Fixture input failed");
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--decode-fixture") {
      decodeFixture();
    } else {
      require(argc == 1, "Usage: monky-light-invite-test [--decode-fixture]");
      decodesKnownInvitations();
      std::cout << "Server invitation scenarios passed\n";
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Server invitation scenario failed: " << error.what() << '\n';
    return 1;
  }
}
