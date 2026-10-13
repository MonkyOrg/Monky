import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserActivity } from '@monky/shared';
import { gameSessionKey, shouldSuggestGameShare, type SuggestShareContext } from '../src/renderer/core/gameShareEligibility';
import { gameWindowIds, type ListedWindow } from '../src/main/gameWindows';

const game: UserActivity = { source: 'steam', appId: 606150, name: 'Moonlighter', startedAt: 1 };

function suggestion(overrides: Partial<SuggestShareContext> = {}): SuggestShareContext {
  return { enabled: true, activity: game, inVoiceChannel: true, isScreenSharing: false, ...overrides };
}

test('the voice panel offers to stream the game only in a call and off screen (#763)', () => {
  assert.equal(shouldSuggestGameShare(suggestion()), true);
  assert.equal(shouldSuggestGameShare(suggestion({ enabled: false })), false, 'turned off in the settings');
  assert.equal(shouldSuggestGameShare(suggestion({ activity: null })), false, 'no game, nothing to suggest');
  assert.equal(shouldSuggestGameShare(suggestion({ inVoiceChannel: false })), false, 'nobody to share with outside a call');
  assert.equal(shouldSuggestGameShare(suggestion({ isScreenSharing: true })), false, 'already on screen');
  // The same game opened again is a new launch, so the row is rebuilt for it.
  assert.notEqual(gameSessionKey({ ...game, startedAt: 2 }), gameSessionKey(game));
});

function listed(id: string, processPath: string, flags: Partial<ListedWindow['window']> = {}): ListedWindow {
  return { id, window: { processPath, isVisible: true, isIconic: false, isCloaked: false, isToolWindow: false, ...flags } };
}

test('game windows are the ones whose executable lives under the install folder (#763)', () => {
  const folder = 'C:/Program Files (x86)/Steam/steamapps/common/Moonlighter';
  const windows = [
    listed('game', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Moonlighter\\Moonlighter.exe'),
    listed('nested', 'c:\\program files (x86)\\steam\\steamapps\\common\\moonlighter\\bin\\x64\\Helper.exe'),
    listed('sibling', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Moonlighter Tools\\Editor.exe'),
    listed('browser', 'C:\\Program Files\\Browser\\browser.exe'),
    listed('minimized', 'D:\\Games\\SteamLibrary\\steamapps\\common\\Moonlighter\\Moonlighter.exe', { isVisible: false, isIconic: true }),
    listed('hidden', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Moonlighter\\Crash.exe', { isVisible: false }),
    listed('cloaked', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Moonlighter\\Moonlighter.exe', { isCloaked: true }),
    listed('tool', 'C:\\Program Files (x86)\\Steam\\steamapps\\common\\Moonlighter\\Moonlighter.exe', { isToolWindow: true }),
  ];
  assert.deepEqual(gameWindowIds(windows, [folder]), ['game', 'nested']);
  assert.deepEqual(gameWindowIds(windows, [folder, 'D:\\Games\\SteamLibrary\\steamapps\\common\\Moonlighter\\']),
    ['game', 'nested', 'minimized']);
  assert.deepEqual(gameWindowIds(windows, []), [], 'no folder never means every window');
});
