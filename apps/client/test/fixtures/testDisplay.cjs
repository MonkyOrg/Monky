'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function localDisplayPreference(filename = path.resolve(__dirname, '..', '..', '..', '..', '.native-screen', 'test-display.json')) {
  if (!fs.existsSync(filename)) return undefined;
  const preference = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.ok(Number.isSafeInteger(preference?.display) && preference.display > 0,
    'The local test-display.json must contain a positive integer display.');
  return String(preference.display);
}

function windowsDisplays() {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MonkyTestDpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
}
'@
if (-not [MonkyTestDpi]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
  throw 'Could not obtain physical Windows display coordinates.'
}
Add-Type -AssemblyName System.Windows.Forms
@([System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  @{ deviceName = $_.DeviceName; bounds = @{
    x = $_.Bounds.X; y = $_.Bounds.Y; width = $_.Bounds.Width; height = $_.Bounds.Height
  } }
}) | ConvertTo-Json -Depth 4 -Compress
`;
  return JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  }).trim());
}

function selectWindowsDisplay(screen, monitors, number) {
  const deviceName = `\\\\.\\DISPLAY${number}`;
  const monitor = monitors.find(candidate => candidate.deviceName.toUpperCase() === deviceName);
  assert.ok(monitor, `MONKY_TEST_DISPLAY=${number}: ${deviceName} is unavailable. Connected devices: ${
    monitors.map(candidate => candidate.deviceName).join(', ') || '(none)'}. No primary-monitor fallback is allowed.`);
  const logical = screen.screenToDipRect(null, monitor.bounds);
  const matches = screen.getAllDisplays().filter(display => {
    const physical = screen.dipToScreenRect(null, display.bounds);
    return ['x', 'y', 'width', 'height'].every(key => Math.abs(physical[key] - monitor.bounds[key]) <= 1
      && Math.abs(display.bounds[key] - logical[key]) <= 1);
  });
  assert.equal(matches.length, 1, `MONKY_TEST_DISPLAY=${number}: could not uniquely match ${deviceName} to Electron's physical display bounds.`);
  const primary = screen.getPrimaryDisplay();
  const primaryPhysical = screen.dipToScreenRect(null, primary.bounds);
  assert.ok(matches[0].id !== primary.id && monitor.bounds.x + monitor.bounds.width <= primaryPhysical.x,
    `MONKY_TEST_DISPLAY=${number}: ${deviceName} must be non-primary and entirely left of the primary display. Refusing to launch on another screen.`);
  return { ...matches[0], deviceName };
}

function displayPosition(bounds, workArea) {
  assert.ok(bounds.width <= workArea.width && bounds.height <= workArea.height,
    'The requested test window does not fit the selected display. Refusing to resize it or overlap another monitor.');
  return {
    x: Math.max(workArea.x, Math.min(bounds.x ?? workArea.x + Math.floor((workArea.width - bounds.width) / 2),
      workArea.x + workArea.width - bounds.width)),
    y: Math.max(workArea.y, Math.min(bounds.y ?? workArea.y + Math.floor((workArea.height - bounds.height) / 2),
      workArea.y + workArea.height - bounds.height)),
  };
}

function installTestDisplay({ app, screen, BrowserWindow }, {
  readPreference = localDisplayPreference,
  value = process.env.MONKY_TEST_DISPLAY ?? readPreference(), platform = process.platform, readDisplays = windowsDisplays,
  log = message => console.log(message),
} = {}) {
  if (value === undefined) return null;
  assert.match(value, /^[1-9]\d*$/, 'MONKY_TEST_DISPLAY must be a positive Windows DISPLAY number.');
  assert.equal(platform, 'win32', 'MONKY_TEST_DISPLAY requires Windows device-name verification.');
  const monitors = readDisplays();
  const deviceName = `\\\\.\\DISPLAY${value}`;
  assert.ok(monitors.some(monitor => monitor.deviceName.toUpperCase() === deviceName),
    `MONKY_TEST_DISPLAY=${value}: ${deviceName} is unavailable. No second-monitor/primary-monitor fallback is allowed.`);
  const windows = new Map();
  let restoreImports;
  let disposed = false;

  function windowOptions(options = {}) {
    const display = selectWindowsDisplay(screen, monitors, value);
    const bounds = { ...options, width: options.width ?? 800, height: options.height ?? 600 };
    const position = displayPosition(bounds, display.workArea);
    log(`[TestDisplay] ${JSON.stringify({ phase: 'before-construction', pid: process.pid, title: options.title ?? '',
      deviceName: display.deviceName, displayId: display.id, workArea: display.workArea, scaleFactor: display.scaleFactor,
      bounds: { ...position, width: bounds.width, height: bounds.height }, show: false })}`);
    return { ...options, ...position, center: false, show: false };
  }

  function createWindow(options = {}) {
    const window = new BrowserWindow(windowOptions(options));
    try {
      place(window);
      if (options.show !== false) window.showInactive();
      return window;
    } catch (error) {
      window.destroy();
      throw error;
    }
  }

  function interceptElectronImports() {
    assert.equal(restoreImports, undefined, 'Test Electron imports are already intercepted.');
    const Module = require('node:module');
    const original = Module._load;
    const constructor = new Proxy(BrowserWindow, {
      construct: (_target, [options]) => disposed ? new BrowserWindow(options) : createWindow(options),
    });
    const load = function (request, ...args) {
      const result = Reflect.apply(original, this, [request, ...args]);
      if (request !== 'electron') return result;
      return new Proxy(result, { get: (target, key, receiver) =>
        key === 'BrowserWindow' ? constructor : Reflect.get(target, key, receiver) });
    };
    // Only the isolated application-smoke process imports production Main through this loader.
    Module._load = load;
    restoreImports = () => { if (Module._load === load) Module._load = original; };
  }

  function place(window) {
    if (window.isDestroyed() || window.isMinimized()) return null;
    const display = selectWindowsDisplay(screen, monitors, value);
    const before = window.getBounds();
    assert.ok(before.width <= display.workArea.width && before.height <= display.workArea.height,
      `MONKY_TEST_DISPLAY=${value}: requested window ${before.width}x${before.height} DIP cannot fit entirely within ${
        display.deviceName} work area ${display.workArea.width}x${display.workArea.height} DIP. Refusing to resize or spill onto another monitor.`);
    const position = displayPosition(before, display.workArea);
    if (before.x !== position.x || before.y !== position.y) window.setBounds(position);
    const bounds = window.getBounds();
    assert.equal(bounds.width, before.width, 'Test display placement must not resize the requested window.');
    assert.equal(bounds.height, before.height, 'Test display placement must not resize the requested window.');
    assert.ok(bounds.x >= display.workArea.x && bounds.x + bounds.width <= display.workArea.x + display.workArea.width
      && bounds.y >= display.workArea.y && bounds.y + bounds.height <= display.workArea.y + display.workArea.height,
    `The owned test window is not entirely inside ${display.deviceName}'s work area.`);
    const evidence = { pid: process.pid, title: window.getTitle(), windowId: window.id,
      deviceName: display.deviceName, displayId: display.id, workArea: display.workArea, bounds,
      contentSize: window.getContentSize(), scaleFactor: display.scaleFactor, displayFrequency: display.displayFrequency,
      oversized: bounds.width > display.workArea.width || bounds.height > display.workArea.height };
    const serialized = JSON.stringify(evidence);
    const state = windows.get(window);
    if (state && state.last !== serialized) {
      state.last = serialized;
      log(`[TestDisplay] ${serialized}`);
    }
    return evidence;
  }

  function attach(_event, window) {
    const state = { placing: false, last: null };
    const enforce = () => {
      if (state.placing) return;
      state.placing = true;
      try { place(window); }
      catch (error) {
        if (!window.isDestroyed()) window.hide();
        console.error('[TestDisplay] Owned window placement failed:', error);
        app.exit(1);
      }
      finally { state.placing = false; }
    };
    state.enforce = enforce;
    windows.set(window, state);
    for (const event of ['ready-to-show', 'show', 'move', 'resize', 'restore']) window.on(event, enforce);
    window.once('closed', () => windows.delete(window));
    enforce();
  }

  function dispose() {
    disposed = true;
    restoreImports?.();
    app.removeListener('browser-window-created', attach);
    app.removeListener('will-quit', dispose);
    for (const [window, state] of windows)
      for (const event of ['ready-to-show', 'show', 'move', 'resize', 'restore']) window.removeListener(event, state.enforce);
    windows.clear();
  }
  app.on('browser-window-created', attach);
  app.once('will-quit', dispose);
  return { createWindow, windowOptions, interceptElectronImports, place, dispose,
    snapshot: () => [...windows.keys()].map(place).filter(Boolean) };
}

module.exports = { localDisplayPreference, windowsDisplays, selectWindowsDisplay, displayPosition, installTestDisplay };
