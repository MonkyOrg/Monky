#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>
#import <Foundation/Foundation.h>

#include <napi.h>

// O Electron nao popula `appIcon` das janelas no macOS, entao o seletor de
// compartilhamento de tela fica sem icone nenhum (#455). Aqui devolvemos o dono
// de cada janela para que o processo principal consiga buscar o icone do bundle
// com `app.getFileIcon()`. Lista tambem as janelas fora da tela (minimizadas,
// em outro Space), que o seletor oferece pela enumeracao do ScreenCaptureKit
// (#825).
//
// Usamos CGWindowListCopyWindowInfo em vez do ScreenCaptureKit de proposito: ele
// e sincrono (nao bloqueia o processo principal esperando um completion handler)
// e nao exige permissao de gravacao de tela para devolver numero, PID e nome do
// dono da janela -- no macOS so o *titulo* da janela e protegido, e nao
// precisamos dele aqui.
Napi::Value platform_list_window_owners(Napi::Env env) {
  Napi::Array result = Napi::Array::New(env);

  CFArrayRef windowInfo = CGWindowListCopyWindowInfo(
      kCGWindowListOptionAll | kCGWindowListExcludeDesktopElements,
      kCGNullWindowID);
  if (windowInfo == NULL) {
    return result;
  }

  NSArray *windows = (__bridge_transfer NSArray *)windowInfo;
  // Uma app costuma ter varias janelas; resolver o bundle uma vez por PID evita
  // repetir a busca em NSRunningApplication para cada uma delas.
  NSMutableDictionary<NSNumber *, NSString *> *bundlePathByPid =
      [NSMutableDictionary dictionary];
  uint32_t index = 0;

  for (NSDictionary *window in windows) {
    if (![window isKindOfClass:[NSDictionary class]]) continue;

    NSNumber *windowNumber = window[(__bridge id)kCGWindowNumber];
    NSNumber *ownerPid = window[(__bridge id)kCGWindowOwnerPID];
    if (windowNumber == nil || ownerPid == nil) continue;

    NSString *bundlePath = bundlePathByPid[ownerPid];
    if (bundlePath == nil) {
      NSRunningApplication *owner = [NSRunningApplication
          runningApplicationWithProcessIdentifier:ownerPid.intValue];
      NSURL *bundleURL = owner.bundleURL;
      bundlePath = (bundleURL != nil && bundleURL.path != nil) ? bundleURL.path : @"";
      bundlePathByPid[ownerPid] = bundlePath;
    }
    // Processos sem bundle (helpers, agentes de linha de comando) nao tem icone
    // para oferecer; deixamos o renderer cair no fallback dele.
    if (bundlePath.length == 0) continue;

    NSString *ownerName = window[(__bridge id)kCGWindowOwnerName];

    Napi::Object entry = Napi::Object::New(env);
    entry.Set("windowId", Napi::Number::New(env, windowNumber.doubleValue));
    entry.Set("pid", Napi::Number::New(env, ownerPid.doubleValue));
    entry.Set("bundlePath", Napi::String::New(env, bundlePath.UTF8String));
    entry.Set("appName",
              Napi::String::New(env, ownerName != nil ? ownerName.UTF8String : ""));
    result.Set(index++, entry);
  }

  return result;
}
