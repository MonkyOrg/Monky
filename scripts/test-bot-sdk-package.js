import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PROTOCOL_VERSION } from '@monky/shared';
import { runNpm } from '../packages/bot-sdk/dist/tooling/process.js';
import { runSdkInstaller } from '../packages/bot-sdk/dist/tooling/install.js';

const tarball = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2] && fs.statSync(tarball).isFile(), 'Pass the SDK tarball to test.');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-sdk-package-'));
const env = { ...process.env, NODE_PATH: '', NODE_OPTIONS: '', npm_config_audit: 'false', npm_config_fund: 'false' };

try {
  runNpm(['install', '--prefix', workspace, '--cache', path.join(workspace, 'sdk-cache'), '--offline',
    '--ignore-scripts', '--no-save', '--package-lock=false', '--omit=dev', tarball], {
    cwd: workspace, env, timeout: 120000,
  });
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { BotClient, PROTOCOL_VERSION } = require('@monky/bot-sdk');
    const fs = require('node:fs');
    const path = require('node:path');
    const sdkRequire = require('node:module').createRequire(require.resolve('@monky/bot-sdk/package.json'));
    const { runBotCli } = require('@monky/bot-sdk/dist/cli/index.js');
    (async () => {
      assert.equal(PROTOCOL_VERSION, ${PROTOCOL_VERSION});
      for (const packageName of ['@monky/bot-sdk', '@monky/shared']) {
        const packageRoot = path.dirname(sdkRequire.resolve(packageName + '/package.json'));
        assert.equal(sdkRequire(packageName + '/package.json').license, 'GPL-3.0-or-later');
        assert.ok(fs.readFileSync(path.join(packageRoot, 'LICENSE'), 'utf8').includes('GNU GENERAL PUBLIC LICENSE'));
        assert.ok(fs.readFileSync(path.join(packageRoot, 'LICENSE-MIT'), 'utf8').includes('MIT License'));
      }
      const bot = new BotClient({ publicKey: 'a'.repeat(64), requestedCapabilities: ['commands'], autoReconnect: false });
      for (const method of [
        'joinVoice', 'leaveVoice', 'getVoiceConnection', 'getPermissions',
        'createScreen', 'updateScreen', 'closeScreen', 'listScreens',
      ]) {
        assert.equal(typeof bot[method], 'function', method + ' must be available in the packaged SDK.');
      }
      bot.command({
        name: '8ball', description: 'Packaged command',
        options: [{ name: 'question', description: 'Question', type: 'string', required: true }],
        handler: ctx => ctx.reply(String(ctx.args.question)),
      });
      try {
        const server = await bot.serve({ name: 'Packaged Bot', port: 0, host: '127.0.0.1', publicHost: '127.0.0.1' });
        const address = server.address();
        assert.ok(address && typeof address === 'object');
        const response = await fetch('http://127.0.0.1:' + address.port + '/manifest');
        assert.equal(response.status, 200);
        const manifest = await response.json();
        assert.equal(manifest.name, 'Packaged Bot');
        assert.deepEqual(manifest.requestedCapabilities, ['commands']);
        assert.equal(manifest.commands[0].name, '8ball');
      } finally {
        await bot.close();
      }

      const project = path.join(process.cwd(), 'operator-bot');
      const home = path.join(process.cwd(), 'operator-profile');
      fs.mkdirSync(project);
      const packageFile = path.join(project, 'package.json');
      const pkg = {
        name: '@example/operator-bot', version: '1.0.0',
        monkyBot: { cliName: 'operator-bot', releases: { url: 'https://github.com/example/operator-bot/releases' } },
      };
      fs.writeFileSync(packageFile, JSON.stringify(pkg));
      process.env.MONKY_BOT_CLI_HOME = home;
      const cli = (...args) => runBotCli(project, ['--locale', 'en', ...args]);
      const original = fs.readFileSync(packageFile);
      await cli('config', 'update-source', 'file', ${JSON.stringify(tarball)});
      const preference = path.join(home, '.operator-bot', 'update-source.json');
      const saved = fs.readFileSync(preference);
      assert.equal(JSON.parse(saved).updateSource.path, ${JSON.stringify(tarball)});
      assert.deepEqual(fs.readFileSync(packageFile), original);
      await assert.rejects(cli('update', '--check'), /does not match the expected bot package/);
      pkg.version = '1.0.1';
      fs.writeFileSync(packageFile, JSON.stringify(pkg));
      await cli('config', 'update-source');
      assert.deepEqual(fs.readFileSync(preference), saved);
      await cli('config', 'update-source', 'reset');
      assert.equal(fs.existsSync(preference), false);
      assert.equal(fs.existsSync(path.join(home, '.operator-bot', '.keys')), false);
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: workspace, env, stdio: 'inherit', timeout: 15000 });
  const fromInstalled = createRequire(path.join(workspace, 'package.json'));
  const voiceFixture = fileURLToPath(new URL('./fixtures/packaged-sdk-voice.cjs', import.meta.url));
  execFileSync(process.execPath, ['--no-global-search-paths', voiceFixture,
    fromInstalled.resolve('@monky/bot-sdk/package.json'), workspace], {
    cwd: workspace, env, stdio: 'inherit', timeout: 40000,
  });
  const project = path.join(workspace, 'generated-bot');
  fromInstalled('@monky/bot-sdk/dist/tooling/create.js').createBotProject({
    directory: project, name: 'generated-bot', displayName: 'Generated Bot', install: false,
  });
  const generated = JSON.parse(fs.readFileSync(path.join(project, 'package.json'), 'utf8'));
  const sdkDependency = generated.dependencies['@monky/bot-sdk'];
  assert.ok(sdkDependency.startsWith('file:vendor/'));
  const generatedSdk = path.resolve(project, sdkDependency.slice('file:'.length));
  const generatedInstall = path.join(workspace, 'generated-sdk-install');
  fs.mkdirSync(generatedInstall);
  runNpm(['install', '--prefix', generatedInstall, '--cache', path.join(workspace, 'generated-cache'), '--offline',
    '--ignore-scripts', '--no-save', '--package-lock=false', '--omit=dev', generatedSdk], {
    cwd: generatedInstall, env, timeout: 120000,
  });
  const fromGenerated = createRequire(path.join(generatedInstall, 'package.json'));
  execFileSync(process.execPath, ['--no-global-search-paths', voiceFixture,
    fromGenerated.resolve('@monky/bot-sdk/package.json'), generatedInstall], {
    cwd: generatedInstall, env, stdio: 'inherit', timeout: 40000,
  });
  await runSdkInstaller(['--file', tarball, '--sha256', createHash('sha256').update(fs.readFileSync(tarball)).digest('hex'),
    '--prefix', path.join(workspace, 'installed SDK'), '--no-path', '--locale', 'en-US']);
  console.log('SDK and scaffold tarballs installed offline and delivered real Opus; manifest, preferences and per-user installer passed.');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
