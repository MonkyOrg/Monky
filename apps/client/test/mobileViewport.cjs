const desktopAgents = new WeakMap();

async function emulateViewport(contents, width, height, { mobile = width <= 960 } = {}) {
  if (!desktopAgents.has(contents)) desktopAgents.set(contents, contents.getUserAgent());
  if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
  await contents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const chrome = process.versions.chrome;
  await contents.debugger.sendCommand('Network.setUserAgentOverride', {
    userAgent: mobile
      ? `Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Mobile Safari/537.36`
      : desktopAgents.get(contents),
    platform: mobile ? 'Android' : 'Win32',
    userAgentMetadata: {
      brands: [{ brand: 'Chromium', version: chrome.split('.')[0] }],
      platform: mobile ? 'Android' : 'Windows', platformVersion: mobile ? '15.0.0' : '10.0.0',
      architecture: mobile ? 'arm' : 'x86', model: mobile ? 'Pixel 9' : '', mobile,
    },
  });
  await contents.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: mobile ? 3 : 1, mobile,
    screenOrientation: { type: width > height ? 'landscapePrimary' : 'portraitPrimary', angle: width > height ? 90 : 0 },
  });
  await contents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
}

module.exports = { emulateViewport };
