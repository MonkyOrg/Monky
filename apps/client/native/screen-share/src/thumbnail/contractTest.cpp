#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include "contract.h"
#include "lifetime.h"
#include <iostream>
using namespace monky::thumbnail;
int main(int argc, char** argv) {
  try {
    if (argc == 2 && std::string_view(argv[1]) == "--watchdog-probe") {
      Lifetime lifetime;
      Sleep(INFINITE);
      return 1;
    }
    Require(argc == 1);
    unsigned checks = 0;
    const auto check = [&](bool value) { Require(value, "thumbnail contract regression"); ++checks; };
    const auto rejects = [&](auto action) {
      bool rejected = false;
      try { action(); } catch (const Failure&) { rejected = true; }
      check(rejected);
    };
    struct PreviewSession {
      bool required = true, refuse = false;
      unsigned changes = 0, reads = 0, starts = 0;
      void IsBorderRequired(bool value) { ++changes; if (!refuse) required = value; }
      bool IsBorderRequired() { ++reads; return required; }
      void StartCapture() { Require(!required); ++starts; }
    };
    for (const auto [supported, allowed] : {std::pair{false, false}, std::pair{false, true}, std::pair{true, false}}) {
      PreviewSession session;
      rejects([&] { StartBorderlessPreview(session, supported, allowed); });
      check(session.changes == 0 && session.reads == 0 && session.starts == 0);
    }
    PreviewSession blocked;
    blocked.refuse = true;
    rejects([&] { StartBorderlessPreview(blocked, true, true); });
    check(blocked.changes == 1 && blocked.reads == 1 && blocked.starts == 0);
    PreviewSession admitted;
    StartBorderlessPreview(admitted, true, true);
    check(!admitted.required && admitted.changes == 1 && admitted.reads == 1 && admitted.starts == 1);
    const auto window = Parse({L"--window", L"123", L"456", L"123456789", L"320", L"180"});
    check(window.window && window.hwnd == 123 && window.pid == 456 && window.creation == 123456789);
    const auto monitor = Parse({L"--monitor", L"\\\\?\\DISPLAY#OWNED", L"\\\\.\\DISPLAY2",
        L"-1920", L"-100", L"1920", L"1080", L"640", L"360"});
    check(!monitor.window && monitor.left == -1920 && monitor.top == -100 && monitor.width == 1920);
    for (auto text : {L"", L"0", L"-1", L"+1", L"01", L"1.0", L"1e3", L" 1", L"1 ", L"18446744073709551616"})
      rejects([&] { Parse({L"--window", L"123", L"456", text, L"320", L"180"}); });
    for (auto text : {L"0", L"641", L"999999999999999999999999999"})
      rejects([&] { Parse({L"--window", L"123", L"456", L"1", text, L"180"}); });
    rejects([] { Parse({}); });
    rejects([] { Parse({L"--window", L"1", L"2", L"3", L"320", L"361"}); });
    rejects([] { Parse({L"--window", L"1", L"2", L"3", L"320", L"180", L"extra"}); });
    rejects([] { Parse({L"--window", L"9007199254740992", L"2", L"3", L"320", L"180"}); });
    rejects([] { Parse({L"--monitor", L"screen:0", L"\\\\.\\DISPLAY2", L"0", L"0", L"1", L"1", L"1", L"1"}); });
    rejects([] { Parse({L"--monitor", L"\\\\?\\DISPLAY#OWNED", L"\\\\.\\DISPLAY0", L"0", L"0", L"1", L"1", L"1", L"1"}); });
    rejects([] { Coordinate(L"-0"); });
    rejects([] { Coordinate(L"-2147483649"); });
    rejects([] { Coordinate(L"2147483648"); });
    check(Coordinate(L"-2147483648") == INT32_MIN);
    for (const auto [width, height] : {std::pair{1920u, 1080u}, {1080u, 1920u}, {3840u, 2160u},
        {1u, 32768u}, {32768u, 1u}, {16u, 16u}}) {
      const auto size = Dimensions(width, height, 320, 180);
      check(size.first > 0 && size.first <= 320 && size.second > 0 && size.second <= 180);
      check(size.first <= width && size.second <= height);
    }
    check(Dimensions(1920, 1080, 320, 180) == std::pair{320u, 180u});
    check(Dimensions(1080, 1920, 320, 180) == std::pair{101u, 180u});
    DWORD before = 0, after = 0;
    check(GetProcessHandleCount(GetCurrentProcess(), &before));
    for (unsigned index = 0; index < 10; ++index) { Lifetime lifetime; }
    check(GetProcessHandleCount(GetCurrentProcess(), &after));
    check(before == after);
    std::cout << "{\"deviceFree\":true,\"checks\":" << checks << "}\n";
    return 0;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
