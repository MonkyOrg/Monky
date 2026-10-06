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
  ['npm', 'run', 'test:camera', '--workspace=apps/client'],
  ['node', 'apps/client/test/footerControlsSmoke.cjs'],
  ['npm', 'run', 'test:transport', '--workspace=apps/client'],
  ['npm', 'run', 'test:bot-marketplace', '--workspace=apps/client'],
  ['npm', 'run', 'test:soundboard', '--workspace=apps/client'],
  ['npm', 'run', 'test:community', '--workspace=apps/client'],
  ['npm', 'run', 'test:pip', '--workspace=apps/client'],
];

// Seconds measured on windows-2022. They only balance shards; every command still runs in exactly one shard.
const durations = {
  'npm run test:camera --workspace=apps/client': 520,
  'npm run test:bots:ui --workspace=apps/client': 100,
  'npm run test:community --workspace=apps/client': 75,
  'node packages/bot-sdk/test-browser/voiceRendererSmoke.cjs': 70,
  'npm run test:soundboard --workspace=apps/client': 60,
  'npm run test:settings:ui --workspace=apps/client': 50,
  'npm run test:transport --workspace=apps/client': 50,
  'npm run test:editing --workspace=apps/client': 40,
  'node apps/client/test/settingsNavigationSmoke.cjs --quality-settings': 40,
  'node apps/client/test/audioDeviceSmoke.cjs': 30,
  'npm run test:screens --workspace=apps/client': 25,
};

function shard(selection, list = commands) {
  if (selection === undefined || selection === '') return list;
  const match = /^([1-9][0-9]*)\/([1-9][0-9]*)$/u.exec(selection);
  if (!match || Number(match[1]) > Number(match[2]))
    throw new Error(`Invalid DOM shard "${selection}"; use <index>/<count>, for example 1/2.`);
  const index = Number(match[1]) - 1, count = Number(match[2]);
  const cost = command => durations[command.join(' ')] ?? 10;
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
  for (const [executable, ...args] of shard(env.MONKY_DOM_SHARD)) {
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

module.exports = { commands, run, shard };
if (require.main === module) {
  try { run(); }
  catch (error) { console.error(error); process.exitCode = 1; }
}
