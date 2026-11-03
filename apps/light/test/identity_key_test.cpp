#include "identity_key.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <iostream>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <type_traits>
#include <vector>

namespace {

using monky::light::IdentityKey;
using monky::light::IdentitySeed;

struct SeedScope final {
  IdentitySeed value{};
  SeedScope() { monky::light::generateIdentitySeed(value); }
  ~SeedScope() { monky::light::clearIdentitySeed(value); }
};

void require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void checkKey() {
  static_assert(!std::is_copy_constructible_v<IdentityKey>);
  static_assert(!std::is_move_constructible_v<IdentityKey>);
  SeedScope seed;
  IdentityKey key(seed.value);
  IdentityKey restored(seed.value);
  require(key.publicKeyHex() == restored.publicKeyHex(), "A seed did not restore the same identity");
  require(key.publicKeyHex().size() == 88 &&
              key.publicKeyHex().starts_with("302a300506032b6570032100"),
          "Native identity is not Ed25519 SPKI DER");
  const std::string nonce(64, 'a');
  require(key.signChallenge(nonce).size() == 128, "Native signature has the wrong length");
  require(key.signChallenge(nonce) == restored.signChallenge(nonce), "Restored signing identity changed");
  require(key.signChallenge(nonce) == key.signChallenge(std::string(64, 'A')),
          "Signing used hex text rather than nonce bytes");
  std::array<std::uint8_t, 32> rawNonce{};
  rawNonce.fill(0xaa);
  require(key.signChallenge(rawNonce) == key.signChallenge(nonce),
          "Byte-oriented protocol signing differs from the hex nonce adapter");
  require(key.signChallenge(nonce) != key.signChallenge(std::string(64, 'b')),
          "Signing ignored the challenge");
  for (const auto& invalid : {std::string{}, std::string(63, 'a'), std::string(65, 'a'), std::string(64, 'z')}) {
    bool rejected = false;
    try {
      (void)key.signChallenge(invalid);
    } catch (const std::invalid_argument&) {
      rejected = true;
    }
    require(rejected, "Malformed nonce was accepted");
  }
  // server-key-auth (#821): a bound signature is never the bare-nonce one, and names its server.
  IdentityKey server(SeedScope{}.value);
  require(monky::light::isServerKeyHex(server.publicKeyHex()), "A server key is not recognized");
  require(!monky::light::isServerKeyHex(std::string(88, 'a')) &&
              !monky::light::isServerKeyHex("302A300506032B6570032100" + std::string(64, 'a')),
          "A malformed or uppercase server key was recognized");
  const auto bound = key.signServerChallenge(rawNonce, server.publicKeyHex());
  require(bound.size() == 128 && bound != key.signChallenge(rawNonce), "A bound signature equals the bare one");
  require(bound != key.signServerChallenge(rawNonce, key.publicKeyHex()), "A bound signature ignored its server");
  bool rejectedKey = false;
  try {
    (void)key.signServerChallenge(rawNonce, "not-a-key");
  } catch (const std::invalid_argument&) {
    rejectedKey = true;
  }
  require(rejectedKey, "A malformed server key was signed for");
  require(!monky::light::verifyServerChallenge(rawNonce, server.publicKeyHex(), bound),
          "A member signature passed as the server's proof");
  require(!monky::light::verifyServerChallenge(rawNonce, server.publicKeyHex(), std::string(128, 'z')),
          "A non-hexadecimal proof was accepted");
  const std::regex uuid("[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}");
  const auto first = monky::light::randomUuid();
  require(std::regex_match(first, uuid), "Installation identifier is not UUID v4");
  require(first != monky::light::randomUuid(), "Independent identifier generation repeated");
  monky::light::clearIdentitySeed(seed.value);
  require(std::all_of(seed.value.begin(), seed.value.end(), [](auto byte) { return byte == 0; }),
          "Seed cleanup did not clear the caller-owned buffer");
}

void signingFixture() {
  SeedScope seed;
  IdentityKey key(seed.value);
  std::cout << key.publicKeyHex() << std::endl;
  // "<nonce>" signs the bare nonce, "<nonce> <serverKey>" a sign-in bound to that server (#821),
  // and "verify <nonce> <serverKey> <signature>" checks a server's proof of its key.
  std::string line;
  while (std::getline(std::cin, line)) {
    std::istringstream words(line);
    std::vector<std::string> parts;
    for (std::string word; words >> word;) parts.push_back(word);
    if (parts.size() == 1) {
      std::cout << key.signChallenge(parts[0]) << std::endl;
      continue;
    }
    const bool verifying = parts.size() == 4 && parts[0] == "verify";
    require(parts.size() == 2 || verifying, "Unknown fixture command");
    const auto& nonceHex = verifying ? parts[1] : parts[0];
    require(nonceHex.size() == 64, "Fixture nonce must be 64 hexadecimal characters");
    std::array<std::uint8_t, 32> nonce{};
    for (std::size_t index = 0; index < nonce.size(); ++index) {
      nonce[index] = static_cast<std::uint8_t>(std::stoul(nonceHex.substr(index * 2, 2), nullptr, 16));
    }
    if (verifying) {
      std::cout << (monky::light::verifyServerChallenge(nonce, parts[2], parts[3]) ? "1" : "0") << std::endl;
    } else {
      std::cout << key.signServerChallenge(nonce, parts[1]) << std::endl;
    }
  }
  require(std::cin.eof(), "Fixture input failed");
}

}  // namespace

int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--signing-fixture") {
      signingFixture();
    } else {
      require(argc == 1, "Usage: monky-light-identity-test [--signing-fixture]");
      checkKey();
      std::cout << "Native identity key scenarios passed\n";
    }
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "Native identity key scenario failed: " << error.what() << '\n';
    return 1;
  }
}
