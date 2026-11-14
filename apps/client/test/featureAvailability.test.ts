import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { PlatformCapabilities } from '../src/renderer/platform/api';
import { featureAvailability, platformSupports } from '../src/renderer/platform/capabilities';

/** What a browser tab declares (#858): the browser's own picker and nothing of the desktop's. */
const WEB: PlatformCapabilities = {
  windowControls: false, screenPictureInPicture: true, documentPictureInPicture: true, automaticPictureInPicture: false,
  hostServer: false, lanDiscovery: false, overlay: false, globalShortcuts: false, tray: false, autoStart: false,
  autoUpdate: false, gamePresence: false, nativeScreenAudio: false, screenShare: true, browserScreenPicker: true,
  screenEncoderChoice: false, localExecution: false, botScreens: true, miniappBrowser: false, discordWeb: false, directMessages: true, mediaFolders: true,
  mediaFolderPicker: false, botSoundDownloads: false, folderDownloads: false, durableIdentity: false, plainRemoteServers: false,
};

const ALL = Object.keys(WEB).filter((key): key is keyof PlatformCapabilities => Object.hasOwn(WEB, key));
const BROWSER_ONLY: readonly (keyof PlatformCapabilities)[] = ['documentPictureInPicture', 'browserScreenPicker'];

function platform(context: TestContext, capabilities: PlatformCapabilities | undefined): void {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { value: { api: capabilities ? { capabilities } : {} }, configurable: true });
  context.after(() => {
    if (previous) Object.defineProperty(globalThis, 'window', previous);
    else Reflect.deleteProperty(globalThis, 'window');
  });
}

test('the desktop has every feature, and hides only what a browser tab alone does', (context) => {
  platform(context, undefined);
  for (const capability of ALL) {
    const browserOnly = BROWSER_ONLY.includes(capability);
    assert.equal(platformSupports(capability), !browserOnly, capability);
    assert.equal(featureAvailability(capability), browserOnly ? 'hidden' : 'available', capability);
  }
});

test('the web shows every desktop feature locked, except the window frame', (context) => {
  platform(context, WEB);
  assert.equal(featureAvailability('windowControls'), 'hidden');
  for (const capability of ['hostServer', 'lanDiscovery', 'overlay', 'globalShortcuts', 'tray', 'autoStart', 'autoUpdate',
    'gamePresence', 'nativeScreenAudio', 'screenEncoderChoice', 'localExecution', 'botSoundDownloads',
    'automaticPictureInPicture'] as const) {
    assert.equal(featureAvailability(capability), 'desktop-only', capability);
  }
  for (const capability of ALL) {
    const expected = WEB[capability] ? 'available' : capability === 'windowControls' ? 'hidden' : 'desktop-only';
    assert.equal(featureAvailability(capability), expected, capability);
  }
});

test('a browser without its own picker hides it instead of offering the desktop', (context) => {
  platform(context, { ...WEB, browserScreenPicker: false, documentPictureInPicture: false });
  assert.equal(featureAvailability('browserScreenPicker'), 'hidden');
  assert.equal(featureAvailability('documentPictureInPicture'), 'hidden');
  assert.equal(featureAvailability('screenShare'), 'available');
});
