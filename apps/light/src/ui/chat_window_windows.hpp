#pragma once

#include "platform/utf8.hpp"  // Defines NOMINMAX and WIN32_LEAN_AND_MEAN before <windows.h>.
#include "ui/chat_controller.hpp"

#include <commctrl.h>

#include <algorithm>
#include <cstddef>
#include <stdexcept>
#include <string>
#include <vector>

namespace monky::light::ui {

// The text chat window, created when the tray opens it and destroyed when it
// closes; closing also stops the core from reading chat. It lives on the tray's
// interface thread and redraws only what changed.
class WindowsChatWindow final {
 public:
  static constexpr int kChannel = 201;
  static constexpr int kOlder = 202;
  static constexpr int kTranscript = 203;
  static constexpr int kInput = 204;
  static constexpr int kStatus = 206;
  // Enter in the message field presses IDOK (send); Escape presses IDCANCEL.

  WindowsChatWindow(ChatController& chat, const Strings& text)
      : chat_(chat), text_(text) {
    NONCLIENTMETRICSW metrics{};
    metrics.cbSize = sizeof(metrics);
    if (SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(metrics), &metrics, 0)) {
      font_ = CreateFontIndirectW(&metrics.lfMessageFont);
    }
    dpi_ = static_cast<int>(GetDpiForSystem());
    instance_ = GetModuleHandleW(nullptr);
    WNDCLASSEXW description{};
    description.cbSize = sizeof(description);
    description.lpfnWndProc = &WindowsChatWindow::proc;
    description.hInstance = instance_;
    // IDC_ARROW is an ANSI resource name in this build, which defines no UNICODE.
    description.hCursor = LoadCursorA(nullptr, IDC_ARROW);
    description.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_BTNFACE + 1);
    description.lpszClassName = kClassName;
    if (!RegisterClassExW(&description)) throw std::runtime_error("Could not register the chat window");
    window_ = CreateWindowExW(0, kClassName, wide(text_.chatTitle).c_str(), WS_OVERLAPPEDWINDOW, CW_USEDEFAULT,
                              CW_USEDEFAULT, scale(560), scale(620), nullptr, nullptr, instance_, this);
    if (!window_) {
      UnregisterClassW(kClassName, instance_);
      throw std::runtime_error("Could not create the chat window");
    }
    label_ = add(L"STATIC", wide(text_.textChannel), WS_CHILD | WS_VISIBLE, 0);
    channel_ = add(L"COMBOBOX", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_VSCROLL | CBS_DROPDOWNLIST, kChannel);
    older_ = add(L"BUTTON", wide(text_.loadOlder), WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_PUSHBUTTON, kOlder);
    transcript_ = add(L"EDIT", L"",
                      WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | WS_VSCROLL | ES_MULTILINE | ES_READONLY |
                          ES_AUTOVSCROLL,
                      kTranscript);
    // The default 32K-character limit would cut a long conversation short.
    SendMessageW(transcript_, EM_SETLIMITTEXT, 8 * 1024 * 1024, 0);
    input_ = add(L"EDIT", L"", WS_CHILD | WS_VISIBLE | WS_TABSTOP | WS_BORDER | ES_AUTOHSCROLL, kInput);
    SendMessageW(input_, EM_SETCUEBANNER, TRUE, reinterpret_cast<LPARAM>(wide(text_.messageField).c_str()));
    send_ = add(L"BUTTON", wide(text_.send), WS_CHILD | WS_VISIBLE | WS_TABSTOP | BS_DEFPUSHBUTTON, IDOK);
    status_ = add(L"STATIC", L"", WS_CHILD | WS_VISIBLE, kStatus);
    layout();
    channels();
    EnableWindow(older_, FALSE);  // Until the first page arrives.
    ShowWindow(window_, SW_SHOWNORMAL);
    SetForegroundWindow(window_);
    SetFocus(input_);
  }

  ~WindowsChatWindow() {
    if (window_) DestroyWindow(window_);
    UnregisterClassW(kClassName, instance_);
    if (font_) DeleteObject(font_);
  }

  WindowsChatWindow(const WindowsChatWindow&) = delete;
  WindowsChatWindow& operator=(const WindowsChatWindow&) = delete;

  // True once the user closed it; the tray then destroys this object.
  bool closed() const { return closed_; }
  HWND handle() const { return window_; }

  void focus() {
    if (IsIconic(window_)) ShowWindow(window_, SW_RESTORE);
    SetForegroundWindow(window_);
  }

  // Interface thread, after the core reported a change.
  void update(ChatChange change) {
    if (change == ChatChange::channels) channels();
    render();
    if (auto alert = chat_.takeAlert()) SetWindowTextW(status_, wide(*alert).c_str());
    EnableWindow(older_, chat_.canLoadOlder());
  }

  // Tab, Enter and Escape for this window, from the tray's message loop.
  bool dialogMessage(MSG& message) { return window_ && IsDialogMessageW(window_, &message); }

 private:
  static constexpr wchar_t kClassName[] = L"MonkyLightChat";

  static std::wstring wide(const std::string& value) {
    try {
      return wideFromUtf8(value);
    } catch (const std::exception&) {
      return L"?";
    }
  }

  int scale(int value) const { return MulDiv(value, dpi_, 96); }

  HWND add(const wchar_t* type, const std::wstring& label, DWORD style, int identifier) {
    const auto control = CreateWindowExW(0, type, label.c_str(), style, 0, 0, 0, 0, window_,
                                         reinterpret_cast<HMENU>(static_cast<INT_PTR>(identifier)), instance_, nullptr);
    if (control && font_) SendMessageW(control, WM_SETFONT, reinterpret_cast<WPARAM>(font_), TRUE);
    return control;
  }

  void layout() {
    RECT client{};
    GetClientRect(window_, &client);
    const int margin = scale(10);
    const int row = scale(26);
    const int width = client.right - 2 * margin;
    const int labelWidth = scale(56);
    const int olderWidth = scale(190);
    MoveWindow(label_, margin, margin + scale(4), labelWidth, row, TRUE);
    MoveWindow(channel_, margin + labelWidth, margin, width - labelWidth - olderWidth - scale(8), scale(240), TRUE);
    MoveWindow(older_, client.right - margin - olderWidth, margin, olderWidth, row, TRUE);
    const int statusTop = client.bottom - margin - scale(20);
    const int inputTop = statusTop - scale(6) - row;
    const int sendWidth = scale(90);
    MoveWindow(input_, margin, inputTop, width - sendWidth - scale(8), row, TRUE);
    MoveWindow(send_, client.right - margin - sendWidth, inputTop, sendWidth, row, TRUE);
    MoveWindow(status_, margin, statusTop, width, scale(20), TRUE);
    const int transcriptTop = margin + row + scale(8);
    MoveWindow(transcript_, margin, transcriptTop, width, std::max(0, inputTop - scale(8) - transcriptTop), TRUE);
  }

  void channels() {
    const auto entries = chat_.channels();
    const auto current = chat_.channel();
    SendMessageW(channel_, CB_RESETCONTENT, 0, 0);
    ids_.clear();
    int selected = -1;
    for (const auto& entry : entries) {
      const auto index = static_cast<int>(
          SendMessageW(channel_, CB_ADDSTRING, 0, reinterpret_cast<LPARAM>(wide(entry.name).c_str())));
      if (index < 0) continue;
      ids_.resize(std::max(ids_.size(), static_cast<std::size_t>(index) + 1));
      ids_[static_cast<std::size_t>(index)] = entry.id;
      if (current && *current == entry.id) selected = index;
    }
    if (entries.empty()) {
      SetWindowTextW(status_, wide(text_.noTextChannels).c_str());
      return;
    }
    // The first opening reads the first channel; a list refresh keeps the open one.
    if (selected < 0) {
      selected = 0;
      choose(0);
    }
    SendMessageW(channel_, CB_SETCURSEL, static_cast<WPARAM>(selected), 0);
  }

  void choose(int index) {
    if (index < 0 || static_cast<std::size_t>(index) >= ids_.size()) return;
    shown_.clear();
    SetWindowTextW(transcript_, L"");
    SetWindowTextW(status_, L"");
    keepTop_ = false;
    chat_.open(ids_[static_cast<std::size_t>(index)]);
  }

  // Appends when the shown lines are still a prefix of the model's; anything
  // else (an older page, an edit) rewrites the transcript once.
  void render() {
    const auto lines = chat_.lines();
    const bool prefix = lines.size() >= shown_.size() &&
                        std::equal(shown_.begin(), shown_.end(), lines.begin(), [](const ChatLine& a, const ChatLine& b) {
                          return a.id == b.id && a.text == b.text;
                        });
    if (prefix && lines.size() == shown_.size()) return;
    if (prefix) {
      std::wstring added;
      for (std::size_t index = shown_.size(); index < lines.size(); ++index) {
        if (index > 0) added += L"\r\n";
        added += wide(lines[index].text);
      }
      const auto end = GetWindowTextLengthW(transcript_);
      SendMessageW(transcript_, EM_SETSEL, static_cast<WPARAM>(end), static_cast<LPARAM>(end));
      SendMessageW(transcript_, EM_REPLACESEL, FALSE, reinterpret_cast<LPARAM>(added.c_str()));
    } else {
      std::wstring all;
      for (std::size_t index = 0; index < lines.size(); ++index) {
        if (index > 0) all += L"\r\n";
        all += wide(lines[index].text);
      }
      SetWindowTextW(transcript_, all.c_str());
      // An older page is read from its start; anything else from the newest.
      SendMessageW(transcript_, WM_VSCROLL, static_cast<WPARAM>(keepTop_ ? SB_TOP : SB_BOTTOM), 0);
    }
    keepTop_ = false;
    shown_ = lines;
  }

  void sendInput() {
    const auto length = GetWindowTextLengthW(input_);
    std::wstring value(static_cast<std::size_t>(std::max(length, 0)) + 1, L'\0');
    value.resize(static_cast<std::size_t>(std::max(GetWindowTextW(input_, value.data(), length + 1), 0)));
    std::string content;
    try {
      content = utf8FromWide(value);
    } catch (const std::exception&) {
      return;
    }
    if (chat_.send(content)) {
      SetWindowTextW(input_, L"");
      SetWindowTextW(status_, L"");
    }
    SetFocus(input_);
  }

  static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM first, LPARAM second) {
    if (message == WM_NCCREATE) {
      const auto* creation = reinterpret_cast<const CREATESTRUCTW*>(second);
      SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(creation->lpCreateParams));
    }
    auto* self = reinterpret_cast<WindowsChatWindow*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (!self) return DefWindowProcW(window, message, first, second);
    try {
      switch (message) {
        case WM_SIZE:
          self->layout();
          return 0;
        case WM_GETMINMAXINFO: {
          auto* limits = reinterpret_cast<MINMAXINFO*>(second);
          limits->ptMinTrackSize = {self->scale(380), self->scale(300)};
          return 0;
        }
        case WM_COMMAND:
          if (LOWORD(first) == IDOK) self->sendInput();
          else if (LOWORD(first) == IDCANCEL) PostMessageW(window, WM_CLOSE, 0, 0);
          else if (LOWORD(first) == kOlder) {
            self->keepTop_ = true;
            self->chat_.older();
            EnableWindow(self->older_, FALSE);
          } else if (LOWORD(first) == kChannel && HIWORD(first) == CBN_SELCHANGE) {
            self->choose(static_cast<int>(SendMessageW(self->channel_, CB_GETCURSEL, 0, 0)));
          }
          return 0;
        case WM_CLOSE:
          // Hidden now, destroyed by the tray right after; reading stops at once.
          self->closed_ = true;
          ShowWindow(window, SW_HIDE);
          self->chat_.close();
          return 0;
        default:
          break;
      }
    } catch (const std::exception&) {
      // A name or text the system cannot convert must not end the process.
    }
    return DefWindowProcW(window, message, first, second);
  }

  ChatController& chat_;
  const Strings& text_;
  HINSTANCE instance_ = nullptr;
  HWND window_ = nullptr;
  HWND label_ = nullptr;
  HWND channel_ = nullptr;
  HWND older_ = nullptr;
  HWND transcript_ = nullptr;
  HWND input_ = nullptr;
  HWND send_ = nullptr;
  HWND status_ = nullptr;
  HFONT font_ = nullptr;
  int dpi_ = 96;
  std::vector<std::string> ids_;
  std::vector<ChatLine> shown_;
  bool keepTop_ = false;
  bool closed_ = false;
};

}  // namespace monky::light::ui
