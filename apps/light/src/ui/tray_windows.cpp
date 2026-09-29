#include "platform/utf8.hpp"  // Defines NOMINMAX and WIN32_LEAN_AND_MEAN before <windows.h>.
#include "ui/tray.hpp"
#include "ui/tray_controller.hpp"

#include <shellapi.h>

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>
#include <iterator>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace monky::light::ui {
namespace {

constexpr UINT kIconIdentifier = 1;
constexpr UINT kIconMessage = WM_APP + 1;
constexpr UINT kRefreshMessage = WM_APP + 2;
constexpr UINT kStoppedMessage = WM_APP + 3;

// Menu identifiers. The rows occupy reserved ranges so an activation carries the
// selected index without a second lookup table.
constexpr UINT kQuit = 1;
constexpr UINT kLeave = 2;
constexpr UINT kMute = 3;
constexpr UINT kDeafen = 4;
constexpr UINT kReconnect = 5;
constexpr UINT kRange = 0x0400;
constexpr UINT kChannels = 0x1000;
constexpr UINT kInputs = kChannels + kRange;
constexpr UINT kOutputs = kInputs + kRange;

// The product palette, matching the accent, success and danger tokens of the
// full client so both editions report the same states with the same colours.
constexpr std::uint32_t kIdle = 0x5865F2;
constexpr std::uint32_t kInCall = 0x23A55A;
constexpr std::uint32_t kSilenced = 0xF23F43;
constexpr std::uint32_t kOffline = 0x8A8A8A;

// The Light has no application identity of its own yet, and borrowing the full
// Monky icon would misreport which edition is running, so the status dot is
// drawn here. Plain GDI has no antialiasing, hence the manual supersampling.
HICON drawIcon(std::uint32_t colour, bool slashed) {
  const auto size = std::max(16, GetSystemMetrics(SM_CXSMICON));
  BITMAPV5HEADER header{};
  header.bV5Size = sizeof(header);
  header.bV5Width = size;
  header.bV5Height = -size;  // Top-down, so the row index is the y coordinate.
  header.bV5Planes = 1;
  header.bV5BitCount = 32;
  header.bV5Compression = BI_BITFIELDS;
  header.bV5RedMask = 0x00FF0000;
  header.bV5GreenMask = 0x0000FF00;
  header.bV5BlueMask = 0x000000FF;
  header.bV5AlphaMask = 0xFF000000;
  void* bits = nullptr;
  const auto screen = GetDC(nullptr);
  const auto bitmap = CreateDIBSection(screen, reinterpret_cast<const BITMAPINFO*>(&header),
                                       DIB_RGB_COLORS, &bits, nullptr, 0);
  if (screen) ReleaseDC(nullptr, screen);
  if (!bitmap || !bits) {
    if (bitmap) DeleteObject(bitmap);
    return nullptr;
  }
  auto* pixels = static_cast<std::uint32_t*>(bits);
  const auto extent = static_cast<double>(size);
  const auto centre = extent / 2.0;
  const auto radius = extent * 0.44;
  const auto thickness = extent * 0.08;
  constexpr int kSamples = 4;
  constexpr auto kTotal = static_cast<double>(kSamples * kSamples);
  for (int y = 0; y < size; ++y) {
    for (int x = 0; x < size; ++x) {
      int inside = 0;
      int slash = 0;
      for (int row = 0; row < kSamples; ++row) {
        for (int column = 0; column < kSamples; ++column) {
          const auto dx = x + (column + 0.5) / kSamples - centre;
          const auto dy = y + (row + 0.5) / kSamples - centre;
          if (dx * dx + dy * dy > radius * radius) continue;
          ++inside;
          // The bar is the diagonal through the centre, clipped to the dot.
          if (std::abs(dx - dy) / std::sqrt(2.0) <= thickness) ++slash;
        }
      }
      const auto coverage = inside / kTotal;
      const auto bar = slashed ? slash / kTotal : 0.0;
      // Premultiplied alpha: a 32-bit icon is composited, not masked.
      const auto channel = [&](unsigned shift) {
        const auto base = static_cast<double>((colour >> shift) & 0xFFu);
        const auto lightened = base + (255.0 - base) * (coverage > 0.0 ? bar / coverage : 0.0);
        return static_cast<std::uint32_t>(std::clamp(lightened, 0.0, 255.0) * coverage + 0.5) & 0xFFu;
      };
      const auto alpha = static_cast<std::uint32_t>(coverage * 255.0 + 0.5) & 0xFFu;
      pixels[static_cast<std::size_t>(y) * static_cast<std::size_t>(size) +
             static_cast<std::size_t>(x)] =
          (alpha << 24) | (channel(16) << 16) | (channel(8) << 8) | channel(0);
    }
  }
  // Windows ignores the mask of a 32-bit icon but still requires one.
  const auto stride = (static_cast<std::size_t>(size) + 15) / 16 * 2;
  const std::vector<std::uint8_t> empty(stride * static_cast<std::size_t>(size), 0);
  const auto mask = CreateBitmap(size, size, 1, 1, empty.data());
  HICON result = nullptr;
  if (mask) {
    ICONINFO info{};
    info.fIcon = TRUE;
    info.hbmColor = bitmap;
    info.hbmMask = mask;
    result = CreateIconIndirect(&info);
    DeleteObject(mask);
  }
  DeleteObject(bitmap);
  return result;
}

void copyInto(WCHAR* destination, std::size_t capacity, const std::string& value) {
  std::wstring wide;
  try {
    wide = wideFromUtf8(value);
  } catch (const std::exception&) {
    wide.clear();  // A name the system cannot convert must not break the icon.
  }
  if (wide.size() >= capacity) wide.resize(capacity - 1);
  std::copy(wide.begin(), wide.end(), destination);
  destination[wide.size()] = L'\0';
}

class WindowsTray final : public CoreInterface {
 public:
  WindowsTray(CoreCommands core, Language language)
      : controller_(std::move(core), language), text_(textFor(language)) {
    WNDCLASSEXW description{};
    description.cbSize = sizeof(description);
    description.lpfnWndProc = &WindowsTray::proc;
    description.hInstance = GetModuleHandleW(nullptr);
    description.lpszClassName = kClassName;
    if (!RegisterClassExW(&description)) {
      throw std::runtime_error("Could not register the Monky Light tray window class");
    }
    instance_ = description.hInstance;
    // A message-only window has no surface to paint and never appears in the
    // task bar, so the interface keeps no renderer alive between activations.
    window_ = CreateWindowExW(0, kClassName, L"Monky Light", 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr,
                              instance_, this);
    if (!window_) {
      UnregisterClassW(kClassName, instance_);
      throw std::runtime_error("Could not create the Monky Light tray window");
    }
    // Only ever read, so the core thread can post without racing WM_DESTROY.
    target_ = window_;
    taskbarRestarted_ = RegisterWindowMessageW(L"TaskbarCreated");
    if (!addIcon()) {
      DestroyWindow(window_);
      UnregisterClassW(kClassName, instance_);
      throw std::runtime_error("Could not add the Monky Light icon to the notification area");
    }
  }

  ~WindowsTray() override {
    removeIcon();
    if (window_) DestroyWindow(window_);
    if (icon_) DestroyIcon(icon_);
    UnregisterClassW(kClassName, instance_);
  }

  void observe(const Json& event) override {
    if (controller_.observe(event)) PostMessageW(target_, kRefreshMessage, 0, 0);
  }

  void stopped() override { PostMessageW(target_, kStoppedMessage, 0, 0); }

  int run() override {
    refresh();
    for (;;) {
      MSG message{};
      const auto result = GetMessageW(&message, nullptr, 0, 0);
      if (result == 0) return 0;
      if (result == -1) return 1;
      TranslateMessage(&message);
      DispatchMessageW(&message);
    }
  }

 private:
  static constexpr const wchar_t* kClassName = L"MonkyLightTray";

  static LRESULT CALLBACK proc(HWND window, UINT message, WPARAM first, LPARAM second) {
    if (message == WM_NCCREATE) {
      const auto* creation = reinterpret_cast<const CREATESTRUCTW*>(second);
      SetWindowLongPtrW(window, GWLP_USERDATA,
                        reinterpret_cast<LONG_PTR>(creation->lpCreateParams));
      return DefWindowProcW(window, message, first, second);
    }
    auto* self = reinterpret_cast<WindowsTray*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (!self) return DefWindowProcW(window, message, first, second);
    return self->handle(window, message, first, second);
  }

  LRESULT handle(HWND window, UINT message, WPARAM first, LPARAM second) {
    try {
      return dispatch(window, message, first, second);
    } catch (const std::exception&) {
      // An unusable name or menu must not take the process down with it.
      return DefWindowProcW(window, message, first, second);
    }
  }

  LRESULT dispatch(HWND window, UINT message, WPARAM first, LPARAM second) {
    if (message == kIconMessage) {
      const auto notification = static_cast<UINT>(LOWORD(second));
      if (notification == NIN_SELECT || notification == WM_LBUTTONUP ||
          notification == WM_RBUTTONUP || notification == WM_CONTEXTMENU) {
        popup();
      }
      return 0;
    }
    if (message == kRefreshMessage) {
      refresh();
      return 0;
    }
    if (message == kStoppedMessage) {
      DestroyWindow(window);
      return 0;
    }
    if (taskbarRestarted_ && message == taskbarRestarted_) {
      // Explorer discards every icon when it restarts; ours has to come back.
      added_ = false;
      addIcon();
      refresh();
      return 0;
    }
    if (message == WM_DESTROY) {
      removeIcon();
      window_ = nullptr;
      PostQuitMessage(0);
      return 0;
    }
    return DefWindowProcW(window, message, first, second);
  }

  NOTIFYICONDATAW describe() const {
    NOTIFYICONDATAW data{};
    data.cbSize = sizeof(data);
    data.hWnd = window_;
    data.uID = kIconIdentifier;
    return data;
  }

  bool addIcon() {
    if (added_) return true;
    auto data = describe();
    data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP;
    data.uCallbackMessage = kIconMessage;
    if (!icon_) icon_ = drawIcon(kIdle, false);
    if (!icon_) return false;
    data.hIcon = icon_;
    copyInto(data.szTip, std::size(data.szTip), text_.application);
    if (!Shell_NotifyIconW(NIM_ADD, &data)) return false;
    data.uVersion = NOTIFYICON_VERSION_4;
    Shell_NotifyIconW(NIM_SETVERSION, &data);
    added_ = true;
    return true;
  }

  void removeIcon() {
    if (!added_ || !window_) return;
    auto data = describe();
    Shell_NotifyIconW(NIM_DELETE, &data);
    added_ = false;
  }

  void refresh() {
    if (!added_) return;
    const auto view = controller_.presentation();
    const auto colour = !view.connected ? kOffline
                        : view.silenced ? kSilenced
                        : view.inCall   ? kInCall
                                        : kIdle;
    // Most events move the tooltip alone, so the bitmap is only redrawn when the
    // state it depicts actually changed.
    if (colour != colour_ || view.silenced != slashed_) {
      if (auto* replacement = drawIcon(colour, view.silenced)) {
        auto* previous = icon_;
        icon_ = replacement;
        colour_ = colour;
        slashed_ = view.silenced;
        if (previous) DestroyIcon(previous);
      }
    }
    auto data = describe();
    data.uFlags = NIF_ICON | NIF_TIP | NIF_SHOWTIP;
    data.hIcon = icon_;
    copyInto(data.szTip, std::size(data.szTip), view.tooltip);
    const auto alert = controller_.takeAlert();
    if (alert) {
      data.uFlags |= NIF_INFO;
      data.dwInfoFlags = NIIF_WARNING;
      copyInto(data.szInfoTitle, std::size(data.szInfoTitle), text_.application);
      copyInto(data.szInfo, std::size(data.szInfo), *alert);
    }
    Shell_NotifyIconW(NIM_MODIFY, &data);
  }

  void append(HMENU menu, UINT identifier, const std::string& label, bool checked, bool enabled,
              bool exclusive) const {
    const auto wide = [&] {
      try {
        return wideFromUtf8(label);
      } catch (const std::exception&) {
        return std::wstring(L"?");
      }
    }();
    MENUITEMINFOW item{};
    item.cbSize = sizeof(item);
    item.fMask = MIIM_ID | MIIM_STATE | MIIM_STRING | MIIM_FTYPE;
    // An exclusive row is marked like a radio item, a toggle like a check item;
    // these are the native menu equivalents of a selectable card and a switch.
    item.fType = exclusive ? MFT_RADIOCHECK : MFT_STRING;
    item.fState = static_cast<UINT>((checked ? MFS_CHECKED : MFS_UNCHECKED) |
                                    (enabled ? MFS_ENABLED : MFS_DISABLED));
    item.wID = identifier;
    item.dwTypeData = const_cast<LPWSTR>(wide.c_str());
    InsertMenuItemW(menu, static_cast<UINT>(GetMenuItemCount(menu)), TRUE, &item);
  }

  void appendLabel(HMENU menu, const std::string& label) const {
    append(menu, 0, label, false, false, false);
  }

  // Returns the submenu, already attached, or nullptr when the list is empty.
  HMENU appendRows(HMENU menu, const std::string& label, const std::vector<MenuEntry>& rows,
                   UINT base, bool enabled) const {
    if (rows.empty()) {
      appendLabel(menu, label);
      return nullptr;
    }
    const auto submenu = CreatePopupMenu();
    if (!submenu) return nullptr;
    for (std::size_t index = 0; index < rows.size() && index < kRange; ++index) {
      append(submenu, base + static_cast<UINT>(index), rows[index].name, rows[index].selected, true,
             true);
    }
    MENUITEMINFOW item{};
    item.cbSize = sizeof(item);
    item.fMask = MIIM_SUBMENU | MIIM_STATE | MIIM_STRING;
    item.fState = static_cast<UINT>(enabled ? MFS_ENABLED : MFS_DISABLED);
    item.hSubMenu = submenu;
    const auto wide = wideFromUtf8(label);
    item.dwTypeData = const_cast<LPWSTR>(wide.c_str());
    InsertMenuItemW(menu, static_cast<UINT>(GetMenuItemCount(menu)), TRUE, &item);
    return submenu;
  }

  void separator(HMENU menu) const {
    MENUITEMINFOW item{};
    item.cbSize = sizeof(item);
    item.fMask = MIIM_FTYPE;
    item.fType = MFT_SEPARATOR;
    InsertMenuItemW(menu, static_cast<UINT>(GetMenuItemCount(menu)), TRUE, &item);
  }

  void popup() {
    const auto view = controller_.presentation();
    const auto menu = CreatePopupMenu();
    if (!menu) return;
    appendLabel(menu, view.status);
    separator(menu);
    if (view.channels.empty()) appendLabel(menu, text_.noChannels);
    else appendRows(menu, text_.channels, view.channels, kChannels, view.canJoin);
    append(menu, kLeave, text_.leaveChannel, false, view.canLeave, false);
    separator(menu);
    append(menu, kMute, view.muteLabel, view.muteChecked, view.muteEnabled, false);
    append(menu, kDeafen, view.deafenLabel, view.deafenChecked, view.deafenEnabled, false);
    separator(menu);
    const auto devices = CreatePopupMenu();
    if (devices) {
      appendRows(devices, text_.input, view.inputs, kInputs, true);
      appendRows(devices, text_.output, view.outputs, kOutputs, true);
      MENUITEMINFOW item{};
      item.cbSize = sizeof(item);
      item.fMask = MIIM_SUBMENU | MIIM_STRING;
      item.hSubMenu = devices;
      const auto wide = wideFromUtf8(text_.audioDevices);
      item.dwTypeData = const_cast<LPWSTR>(wide.c_str());
      InsertMenuItemW(menu, static_cast<UINT>(GetMenuItemCount(menu)), TRUE, &item);
    }
    separator(menu);
    append(menu, kReconnect, text_.reconnectNow, false, true, false);
    append(menu, kQuit, text_.quit, false, true, false);
    POINT cursor{};
    GetCursorPos(&cursor);
    // The menu only dismisses on an outside click while our window is active.
    SetForegroundWindow(window_);
    const auto chosen = TrackPopupMenuEx(menu, TPM_RIGHTBUTTON | TPM_RETURNCMD | TPM_NONOTIFY,
                                         cursor.x, cursor.y, window_, nullptr);
    DestroyMenu(menu);
    PostMessageW(window_, WM_NULL, 0, 0);
    if (chosen > 0) activate(static_cast<UINT>(chosen), view);
  }

  void activate(UINT identifier, const Presentation& view) {
    const auto row = [&](const std::vector<MenuEntry>& rows, UINT base) -> const MenuEntry* {
      const auto index = static_cast<std::size_t>(identifier - base);
      return index < rows.size() ? &rows[index] : nullptr;
    };
    if (identifier == kQuit) controller_.quit();
    else if (identifier == kLeave) controller_.leave();
    else if (identifier == kMute) controller_.setMuted(!view.muteChecked);
    else if (identifier == kDeafen) controller_.setDeafened(!view.deafenChecked);
    else if (identifier == kReconnect) controller_.reconnect();
    else if (identifier >= kOutputs) {
      if (const auto* entry = row(view.outputs, kOutputs)) controller_.selectOutput(entry->id);
    } else if (identifier >= kInputs) {
      if (const auto* entry = row(view.inputs, kInputs)) controller_.selectInput(entry->id);
    } else if (identifier >= kChannels) {
      if (const auto* entry = row(view.channels, kChannels)) controller_.join(entry->id);
    }
  }

  TrayController controller_;
  const Strings& text_;
  HINSTANCE instance_ = nullptr;
  HWND window_ = nullptr;
  HWND target_ = nullptr;
  HICON icon_ = nullptr;
  std::uint32_t colour_ = kIdle;
  bool slashed_ = false;
  UINT taskbarRestarted_ = 0;
  bool added_ = false;
};

}  // namespace

std::unique_ptr<CoreInterface> createTray(CoreCommands core, Language language) {
  return std::make_unique<WindowsTray>(std::move(core), language);
}

Language systemLanguage() {
  return PRIMARYLANGID(GetUserDefaultUILanguage()) == LANG_PORTUGUESE ? Language::portuguese
                                                                      : Language::english;
}

}  // namespace monky::light::ui
