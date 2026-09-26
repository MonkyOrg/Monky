#include <napi.h>
#include <windows.h>
#include <commctrl.h>
#include <algorithm>
#include <cmath>
#include <cstring>

namespace {
struct ResizeAspect {
  napi_env env;
  HWND window;
  double ratio, extraWidth, extraHeight;
};

LRESULT CALLBACK ResizeProc(HWND, UINT, WPARAM, LPARAM, UINT_PTR, DWORD_PTR);

void ReleaseAspect(void* data) {
  auto* aspect = static_cast<ResizeAspect*>(data);
  RemoveWindowSubclass(aspect->window, ResizeProc, 1);
  delete aspect;
}

LRESULT CALLBACK ResizeProc(HWND window, UINT message, WPARAM edge, LPARAM parameter,
                            UINT_PTR, DWORD_PTR data) {
  auto* aspect = reinterpret_cast<ResizeAspect*>(data);
  if (message == WM_NCDESTROY) {
    napi_remove_env_cleanup_hook(aspect->env, ReleaseAspect, aspect);
    ReleaseAspect(aspect);
    return DefSubclassProc(window, message, edge, parameter);
  }
  if (message == WM_SIZING && edge >= WMSZ_LEFT && edge <= WMSZ_BOTTOMRIGHT) {
    auto* rect = reinterpret_cast<RECT*>(parameter);
    const double scale = GetDpiForWindow(window) / 96.0;
    const double extraWidth = aspect->extraWidth * scale;
    const double extraHeight = aspect->extraHeight * scale;
    MINMAXINFO limits{};
    SendMessageW(window, WM_GETMINMAXINFO, 0, reinterpret_cast<LPARAM>(&limits));
    const double minWidth = std::max(1L, limits.ptMinTrackSize.x);
    const double minHeight = std::max(1L, limits.ptMinTrackSize.y);
    const bool horizontal = edge == WMSZ_LEFT || edge == WMSZ_RIGHT
      || edge == WMSZ_TOPLEFT || edge == WMSZ_BOTTOMLEFT;
    double width, height;
    if (horizontal) {
      width = std::max({double(rect->right - rect->left), minWidth,
        (minHeight - extraHeight) * aspect->ratio + extraWidth});
      height = (width - extraWidth) / aspect->ratio + extraHeight;
    } else {
      height = std::max({double(rect->bottom - rect->top), minHeight,
        (minWidth - extraWidth) / aspect->ratio + extraHeight});
      width = (height - extraHeight) * aspect->ratio + extraWidth;
    }
    // Expand fractional pixels rather than clipping a row/column of cards.
    const LONG w = static_cast<LONG>(std::ceil(width));
    const LONG h = static_cast<LONG>(std::ceil(height));
    if (edge == WMSZ_LEFT || edge == WMSZ_TOPLEFT || edge == WMSZ_BOTTOMLEFT)
      rect->left = rect->right - w;
    else rect->right = rect->left + w;
    if (edge == WMSZ_LEFT || edge == WMSZ_TOP || edge == WMSZ_TOPLEFT || edge == WMSZ_TOPRIGHT)
      rect->top = rect->bottom - h;
    else rect->bottom = rect->top + h;
  }
  // Only edit the proposed RECT. Windows applies it once, with no SetWindowPos
  // or Electron setAspectRatio resize competing with the native sizing loop.
  return DefSubclassProc(window, message, edge, parameter);
}
}

Napi::Value SetWindowResizeAspect(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  if (info.Length() != 4 || !info[0].IsBuffer()
      || info[0].As<Napi::Buffer<unsigned char>>().Length() != sizeof(HWND)
      || !info[1].IsNumber() || !info[2].IsNumber() || !info[3].IsNumber()) {
    Napi::TypeError::New(env, "Expected an owned window handle, ratio and fixed dimensions.").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  HWND window;
  std::memcpy(&window, info[0].As<Napi::Buffer<unsigned char>>().Data(), sizeof(window));
  const double ratio = info[1].As<Napi::Number>().DoubleValue();
  const double width = info[2].As<Napi::Number>().DoubleValue();
  const double height = info[3].As<Napi::Number>().DoubleValue();
  DWORD process = 0;
  if (GetWindowThreadProcessId(window, &process) != GetCurrentThreadId() || process != GetCurrentProcessId()
      || !std::isfinite(ratio) || ratio < 0 || ratio > 16384 || (ratio > 0 && ratio < 1.0 / 16384)
      || !std::isfinite(width) || width < 0 || width > 65536
      || !std::isfinite(height) || height < 0 || height > 65536) {
    Napi::TypeError::New(env, "Invalid resize aspect or window not owned by the calling UI thread.").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  DWORD_PTR data = 0;
  GetWindowSubclass(window, ResizeProc, 1, &data);
  auto* aspect = reinterpret_cast<ResizeAspect*>(data);
  if (ratio == 0) {
    if (aspect) {
      napi_remove_env_cleanup_hook(aspect->env, ReleaseAspect, aspect);
      ReleaseAspect(aspect);
    }
    return env.Undefined();
  }
  if (aspect) {
    aspect->ratio = ratio; aspect->extraWidth = width; aspect->extraHeight = height;
    return env.Undefined();
  }
  aspect = new ResizeAspect{env, window, ratio, width, height};
  if (!SetWindowSubclass(window, ResizeProc, 1, reinterpret_cast<DWORD_PTR>(aspect))) {
    delete aspect;
    Napi::Error::New(env, "Could not install the native window resize constraint.").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (napi_add_env_cleanup_hook(env, ReleaseAspect, aspect) != napi_ok) {
    ReleaseAspect(aspect);
    Napi::Error::New(env, "Could not register native resize cleanup.").ThrowAsJavaScriptException();
  }
  return env.Undefined();
}
