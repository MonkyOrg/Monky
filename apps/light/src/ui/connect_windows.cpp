#include "platform/utf8.hpp"  // Defines NOMINMAX and WIN32_LEAN_AND_MEAN before <windows.h>.
#include "ui/connect.hpp"

#include <knownfolders.h>
#include <shlobj.h>

#include <algorithm>
#include <array>
#include <stdexcept>
#include <string>
#include <vector>

namespace monky::light::ui {
namespace {

constexpr wchar_t kClassName[] = L"MonkyLightConnect";
constexpr int kServer = 101;
constexpr int kNickname = 102;
constexpr int kPassword = 103;

std::wstring wide(const std::string& value) {
  try {
    return wideFromUtf8(value);
  } catch (const std::exception&) {
    return {};
  }
}

std::string text(HWND control) {
  const auto length = GetWindowTextLengthW(control);
  if (length <= 0) return {};
  std::wstring value(static_cast<std::size_t>(length) + 1, L'\0');
  const auto copied = GetWindowTextW(control, value.data(), length + 1);
  value.resize(static_cast<std::size_t>(std::max(copied, 0)));
  try {
    return utf8FromWide(value);
  } catch (const std::exception&) {
    return {};
  }
}

// Lives only while the window is open; the class is registered for that time.
class ConnectWindow final {
 public:
  ConnectWindow(const Connection& current, std::optional<ConnectionIssue> issue, const Strings& strings)
      : text_(strings) {
    NONCLIENTMETRICSW metrics{};
    metrics.cbSize = sizeof(metrics);
    if (SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(metrics), &metrics, 0)) {
      font_ = CreateFontIndirectW(&metrics.lfMessageFont);
    }
    const auto dpi = static_cast<int>(GetDpiForSystem());
    const auto scale = [dpi](int value) { return MulDiv(value, dpi, 96); };
    instance_ = GetModuleHandleW(nullptr);
    WNDCLASSEXW description{};
    description.cbSize = sizeof(description);
    description.lpfnWndProc = &ConnectWindow::proc;
    description.hInstance = instance_;
    // IDC_ARROW is an ANSI resource name in this build, which defines no UNICODE.
    description.hCursor = LoadCursorA(nullptr, IDC_ARROW);
    description.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_BTNFACE + 1);
    description.lpszClassName = kClassName;
    if (!RegisterClassExW(&description)) throw std::runtime_error("Could not register the connection window");
    const int width = scale(420);
    const int margin = scale(14);
    const int field = scale(24);
    const int label = scale(18);
    const int inner = width - 2 * margin;
    RECT frame{0, 0, width, scale(330)};
    const auto style = WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU;
    AdjustWindowRectEx(&frame, style, FALSE, WS_EX_DLGMODALFRAME);
    const auto outerWidth = frame.right - frame.left;
    const auto outerHeight = frame.bottom - frame.top;
    window_ = CreateWindowExW(WS_EX_DLGMODALFRAME, kClassName, wide(text_.connectTitle).c_str(), style,
                              (GetSystemMetrics(SM_CXSCREEN) - outerWidth) / 2,
                              (GetSystemMetrics(SM_CYSCREEN) - outerHeight) / 2, outerWidth, outerHeight,
                              nullptr, nullptr, instance_, this);
    if (!window_) {
      UnregisterClassW(kClassName, instance_);
      throw std::runtime_error("Could not create the connection window");
    }
    int y = margin;
    add(L"STATIC", wide(text_.connectPrompt), WS_VISIBLE | WS_CHILD, margin, y, inner, scale(36), 0);
    y += scale(42);
    add(L"STATIC", wide(text_.serverField), WS_VISIBLE | WS_CHILD, margin, y, inner, label, 0);
    y += label;
    server_ = add(L"EDIT", wide(current.server), WS_VISIBLE | WS_CHILD | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL,
                  margin, y, inner, field, kServer);
    y += field + scale(10);
    add(L"STATIC", wide(text_.nicknameField), WS_VISIBLE | WS_CHILD, margin, y, inner, label, 0);
    y += label;
    nickname_ = add(L"EDIT", wide(current.nickname),
                    WS_VISIBLE | WS_CHILD | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL, margin, y, inner, field,
                    kNickname);
    y += field + scale(10);
    add(L"STATIC", wide(text_.passwordField), WS_VISIBLE | WS_CHILD, margin, y, inner, label, 0);
    y += label;
    password_ = add(L"EDIT", wide(current.password.value_or("")),
                    WS_VISIBLE | WS_CHILD | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL | ES_PASSWORD, margin, y,
                    inner, field, kPassword);
    y += field + scale(8);
    // The reason the last attempt was refused, read by screen readers as text.
    add(L"STATIC", issue ? wide(issueText(*issue, text_)) : std::wstring(), WS_VISIBLE | WS_CHILD, margin, y, inner,
        scale(36), 0);
    const int button = scale(96);
    const int height = scale(28);
    const int bottom = scale(330) - margin - height;
    add(L"BUTTON", wide(text_.cancel), WS_VISIBLE | WS_CHILD | WS_TABSTOP | BS_PUSHBUTTON,
        width - margin - button, bottom, button, height, IDCANCEL);
    add(L"BUTTON", wide(text_.connect), WS_VISIBLE | WS_CHILD | WS_TABSTOP | BS_DEFPUSHBUTTON,
        width - margin - 2 * button - scale(8), bottom, button, height, IDOK);
    // Focus where the fix is: the field the issue is about, else the first to fill.
    const auto target = fieldFor(issue, current);
    const auto focus = target == Field::password ? password_ : target == Field::nickname ? nickname_ : server_;
    ShowWindow(window_, SW_SHOWNORMAL);
    SetForegroundWindow(window_);
    SetFocus(focus);
    SendMessageW(focus, EM_SETSEL, 0, -1);
  }

  ~ConnectWindow() {
    if (window_) DestroyWindow(window_);
    UnregisterClassW(kClassName, instance_);
    if (font_) DeleteObject(font_);
  }

  ConnectWindow(const ConnectWindow&) = delete;
  ConnectWindow& operator=(const ConnectWindow&) = delete;

  std::optional<Connection> run() {
    MSG message{};
    while (!done_ && GetMessageW(&message, nullptr, 0, 0) > 0) {
      // Tab moves between fields, Enter connects and Escape cancels.
      if (IsDialogMessageW(window_, &message)) continue;
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
    if (!accepted_) return std::nullopt;
    auto password = text(password_);
    return Connection{text(server_), text(nickname_),
                      password.empty() ? std::nullopt : std::optional<std::string>(std::move(password))};
  }

 private:
  HWND add(const wchar_t* type, const std::wstring& label, DWORD style, int x, int y, int width, int height,
           int identifier) {
    const auto control = CreateWindowExW(0, type, label.c_str(), style, x, y, width, height, window_,
                                         reinterpret_cast<HMENU>(static_cast<INT_PTR>(identifier)), instance_,
                                         nullptr);
    if (control && font_) SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(font_), TRUE);
    return control;
  }

  static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM first, LPARAM second) {
    if (message == WM_NCCREATE) {
      const auto* creation = reinterpret_cast<const CREATESTRUCTW*>(second);
      SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(creation->lpCreateParams));
    }
    auto* self = reinterpret_cast<ConnectWindow*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (self) {
      if (message == WM_COMMAND && (LOWORD(first) == IDOK || LOWORD(first) == IDCANCEL)) {
        self->accepted_ = LOWORD(first) == IDOK;
        self->done_ = true;
        return 0;
      }
      if (message == WM_CLOSE) {
        self->done_ = true;
        return 0;
      }
    }
    return DefWindowProcW(window, message, first, second);
  }

  const Strings& text_;
  HINSTANCE instance_ = nullptr;
  HWND window_ = nullptr;
  HWND server_ = nullptr;
  HWND nickname_ = nullptr;
  HWND password_ = nullptr;
  HFONT font_ = nullptr;
  bool done_ = false;
  bool accepted_ = false;
};

}  // namespace

std::optional<Connection> askConnection(const Connection& current, std::optional<ConnectionIssue> issue,
                                        Language language) {
  ConnectWindow window(current, issue, textFor(language));
  return window.run();
}

void showProfileUnavailable(const std::string& detail, Language language) {
  const auto& text = textFor(language);
  const auto message = wide(std::string(text.profileUnavailable) + "\n\n" + detail);
  MessageBoxW(nullptr, message.c_str(), wide(text.application).c_str(), MB_OK | MB_ICONWARNING | MB_SETFOREGROUND);
}

std::filesystem::path defaultProfileDirectory() {
  PWSTR folder = nullptr;
  if (FAILED(SHGetKnownFolderPath(FOLDERID_LocalAppData, KF_FLAG_CREATE, nullptr, &folder))) {
    if (folder) CoTaskMemFree(folder);
    throw std::runtime_error("Could not find the local application data folder");
  }
  std::filesystem::path result(folder);
  CoTaskMemFree(folder);
  return result / L"Monky Light" / L"Profile";
}

}  // namespace monky::light::ui
