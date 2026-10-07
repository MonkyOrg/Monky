import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { UserActivity } from '@monky/shared';
import { canAskToWatchGame, type AskToWatchContext } from '../src/renderer/core/gameShareEligibility';
import { gameWindowIds, type ListedWindow } from '../src/main/gameWindows';

const game: UserActivity = { source: 'steam', appId: 606150, name: 'Moonlighter', startedAt: 1 };

function context(overrides: Partial<AskToWatchContext> = {}): AskToWatchContext {
  return {
    isSelf: false,
    activity: game,
    features: ['game-activity', 'game-share-request'],
    myVoiceChannelId: 'voice-1',
    targetVoiceStates: [{ channelId: 'voice-1', isScreenSharing: false }],
    ...overrides,
  };
}

test('the ask shows only for a playing person in the same call who is not on screen yet (#763)', () => {
  assert.equal(canAskToWatchGame(context()), true);
  assert.equal(canAskToWatchGame(context({ isSelf: true })), false);
  assert.equal(canAskToWatchGame(context({ activity: null })), false);
  assert.equal(canAskToWatchGame(context({ features: ['game-activity'] })), false, 'server without the feature');
  assert.equal(canAskToWatchGame(context({ myVoiceChannelId: null })), false, 'asker not in a call');
  assert.equal(canAskToWatchGame(context({ targetVoiceStates: [{ channelId: 'voice-2', isScreenSharing: false }] })), false);
  assert.equal(canAskToWatchGame(context({ targetVoiceStates: [] })), false, 'player not in a call');
  // Already sharing anything, on any device: watching is enough, there is nothing to ask.
  assert.equal(canAskToWatchGame(context({ targetVoiceStates: [
    { channelId: 'voice-1', isScreenSharing: false }, { channelId: 'voice-1', isScreenSharing: true },
  ] })), false);
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
