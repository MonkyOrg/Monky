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
  ['node', 'apps/client/test/settingsNavigationSmoke.cjs', '--screen-audience'],
  ['node', 'apps/client/test/settingsNavigationSmoke.cjs', '--overlay-window'],
  ['npm', 'run', 'test:settings:ui', '--workspace=apps/client'],
  // test:camera split into its own commands so the long camera suite can be balanced across shards;
  // a contract test keeps this list identical to the apps/client test:camera script.
  ['node', 'apps/client/test/cameraEffectsSmoke.cjs'],
  ['node', 'apps/client/test/cameraEffectsSmoke.cjs', '--packaged'],
  ['node', 'apps/client/test/cameraEffectsSmoke.cjs', '--packaged', '--cpu-compositor', '--chroma-only', '--transitions-only'],
  ['node', 'apps/client/test/cameraPublicationSmoke.cjs'],
  ['node', 'apps/client/test/footerControlsSmoke.cjs'],
  ['npm', 'run', 'test:transport', '--workspace=apps/client'],
  ['npm', 'run', 'test:bot-marketplace', '--workspace=apps/client'],
  ['npm', 'run', 'test:soundboard', '--workspace=apps/client'],
  ['npm', 'run', 'test:community', '--workspace=apps/client'],
  ['npm', 'run', 'test:pip', '--workspace=apps/client'],
];

// Seconds measured in CI (windows-2022, macos-15). They only balance shards; every command still runs
// in exactly one shard. Unlisted commands count as 10 s.
const durations = {
  win32: {
    'node apps/client/test/cameraEffectsSmoke.cjs': 250,
    'node apps/client/test/cameraEffectsSmoke.cjs --packaged': 180,
    'node apps/client/test/cameraPublicationSmoke.cjs': 120,
    'npm run test:bots:ui --workspace=apps/client': 105,
    'node apps/client/test/cameraEffectsSmoke.cjs --packaged --cpu-compositor --chroma-only --transitions-only': 90,
    'npm run test:community --workspace=apps/client': 81,
    'node packages/bot-sdk/test-browser/voiceRendererSmoke.cjs': 71,
    'npm run test:soundboard --workspace=apps/client': 71,
    'npm run test:transport --workspace=apps/client': 57,
    'npm run test:settings:ui --workspace=apps/client': 56,
    'npm run test:editing --workspace=apps/client': 46,
    'node apps/client/test/settingsNavigationSmoke.cjs --quality-settings': 40,
    'npm run test:screens --workspace=apps/client': 33,
    'node apps/client/test/audioDeviceSmoke.cjs': 33,
    'npm run test:pip --workspace=apps/client': 21,
    'npm run test:clipboard --workspace=apps/client': 17,
    'node apps/client/test/footerControlsSmoke.cjs': 16,
    'node apps/client/test/dropdownSmoke.cjs': 14,
  },
  darwin: {
    'node apps/client/test/cameraEffectsSmoke.cjs': 124,
    'npm run test:bots:ui --workspace=apps/client': 110,
    'node apps/client/test/cameraEffectsSmoke.cjs --packaged': 90,
    'npm run test:community --workspace=apps/client': 82,
    'node packages/bot-sdk/test-browser/voiceRendererSmoke.cjs': 73,
    'npm run test:editing --workspace=apps/client': 65,
    'node apps/client/test/settingsNavigationSmoke.cjs --quality-settings': 63,
    'node apps/client/test/cameraPublicationSmoke.cjs': 60,
    'npm run test:soundboard --workspace=apps/client': 60,
    'npm run test:settings:ui --workspace=apps/client': 51,
    'npm run test:transport --workspace=apps/client': 48,
    'node apps/client/test/audioDeviceSmoke.cjs': 46,
    'node apps/client/test/cameraEffectsSmoke.cjs --packaged --cpu-compositor --chroma-only --transitions-only': 45,
    'npm run test:screens --workspace=apps/client': 25,
    'npm run test:pip --workspace=apps/client': 23,
    'npm run test:clipboard --workspace=apps/client': 21,
    'node apps/client/test/footerControlsSmoke.cjs': 17,
  },
};

function shard(selection, list = commands, platform = process.platform) {
  if (selection === undefined || selection === '') return list;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(selection);
  if (!match || Number(match[1]) > Number(match[2]))
    throw new Error(`Invalid DOM shard "${selection}"; use <index>/<count>, for example 1/2.`);
  const index = Number(match[1]) - 1, count = Number(match[2]);
  const cost = command => (durations[platform] ?? durations.win32)[command.join(' ')] ?? 10;
  const loads = new Array(count).fill(0), owners = new Map();
  // Longest first onto the lightest shard; the stable sort keeps ties deterministic.
  for (const command of [...list].sort((a, b) => cost(b) - cost(a))) {
    const target = loads.indexOf(Math.min(...loads));
    owners.set(command, target);
    loads[target] += cost(command);
  }
  return list.filter(command => owners.get(command) === index);
}

// Runs every command so one CI round reports all failures; MONKY_DOM_FAIL_FAST=1 stops at the first one.
function run(runCommand = spawnSync, platform = process.platform, env = process.env) {
  const failures = [];
  for (const [executable, ...args] of shard(env.MONKY_DOM_SHARD, commands, platform)) {
    const label = [executable, ...args].join(' ');
    console.log(`> ${label}`);
    // npm.cmd requires cmd.exe on Windows; only the fixed commands above enter it.
    const result = runCommand(executable === 'node' ? process.execPath : executable, args, {
      cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
      shell: platform === 'win32' && executable === 'npm',
    });
    const reason = result.error ? result.error.message
      : result.status !== 0 ? `exit ${result.status ?? result.signal}` : null;
    if (!reason) continue;
    failures.push(`${label} (${reason})`);
    if (env.GITHUB_ACTIONS === 'true') console.log(`::error::FALHOU ${label} (${reason})`);
    if (env.MONKY_DOM_FAIL_FAST === '1') break;
  }
  console.log(`FALHAS: ${failures.length ? failures.join(' | ') : 'nenhuma'}`);
  if (failures.length) throw new Error(`${failures.length} DOM command(s) failed: ${failures.join('; ')}`);
}

module.exports = { commands, durations, run, shard };
if (require.main === module) {
  try { run(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
