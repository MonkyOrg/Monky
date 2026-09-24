'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const commands = [
  ['npm', 'run', 'test:bots:ui', '--workspace=apps/client'],
  ['npm', 'run', 'test:development', '--workspace=apps/client'],
  ['npm', 'run', 'test:updates', '--workspace=apps/client'],
  ['npm', 'run', 'test:editing', '--workspace=apps/client'],
  ['npm', 'run', 'test:clipboard', '--workspace=apps/client'],
  ['node', 'apps/client/test/messageClipboardDomSmoke.cjs', '--system-clipboard'],
  ['npm', 'run', 'test:screens', '--workspace=apps/client'],
  ['node', 'packages/bot-sdk/test-browser/voiceRendererSmoke.cjs'],
  ['node', 'apps/client/test/userContextMenuSmoke.cjs'],
  ['node', 'apps/client/test/audioDeviceSmoke.cjs'],
  ['node', 'apps/client/test/liveAudioDeviceSmoke.cjs'],
  ['node', 'apps/client/test/dropdownSmoke.cjs'],
  ['node', 'apps/client/test/tooltipSmoke.cjs'],
  ['node', 'apps/client/test/tooltipSmoke.cjs', '--delayed-native-input'],
  ['node', 'apps/client/test/microphoneStateSmoke.cjs'],
  ['node', 'apps/client/test/microphoneTestSmoke.cjs'],
  ['node', 'apps/client/test/settingsNavigationSmoke.cjs'],
  ['node', 'apps/client/test/settingsNavigationSmoke.cjs', '--release-notes'],
  ['node', 'apps/client/test/settingsNavigationSmoke.cjs', '--quality-settings'],
  ['node', 'apps/client/test/settingsNavigationSmoke.cjs', '--screen-stage'],
  ['npm', 'run', 'test:settings:ui', '--workspace=apps/client'],
  ['npm', 'run', 'test:camera', '--workspace=apps/client'],
  ['node', 'apps/client/test/footerControlsSmoke.cjs'],
  ['npm', 'run', 'test:transport', '--workspace=apps/client'],
  ['npm', 'run', 'test:bot-marketplace', '--workspace=apps/client'],
  ['npm', 'run', 'test:soundboard', '--workspace=apps/client'],
];

function run(runCommand = spawnSync, platform = process.platform) {
  for (const [executable, ...args] of commands) {
    console.log(`> ${[executable, ...args].join(' ')}`);
    // npm.cmd requires cmd.exe on Windows; only the fixed commands above enter it.
    const result = runCommand(executable === 'node' ? process.execPath : executable, args, {
      cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
      shell: platform === 'win32' && executable === 'npm',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${executable} ${args.join(' ')} failed (${result.status ?? result.signal}).`);
  }
}

module.exports = { commands, run };
if (require.main === module) {
  try { run(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
