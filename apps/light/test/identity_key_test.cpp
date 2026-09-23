#include "identity_key.hpp"

#include <algorithm>
#include <iostream>
#include <regex>
#include <stdexcept>
#include <string>
#include <type_traits>

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
  std::string nonce;
  while (std::getline(std::cin, nonce)) {
    std::cout << key.signChallenge(nonce) << std::endl;
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
