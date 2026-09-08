import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROTOCOL_VERSION } from '@monky/shared';

const tarball = path.resolve(process.argv[2] || '');
assert.ok(process.argv[2] && fs.statSync(tarball).isFile(), 'Pass the SDK tarball to test.');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-sdk-package-'));
const env = { ...process.env, NODE_PATH: '', npm_config_audit: 'false', npm_config_fund: 'false' };

try {
  execSync(`npm install --ignore-scripts --no-save --package-lock=false --omit=dev ${JSON.stringify(tarball)}`, {
    cwd: workspace, env, stdio: 'pipe', timeout: 120000,
  });
  execFileSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const { BotClient, PROTOCOL_VERSION } = require('@monky/bot-sdk');
    (async () => {
      assert.equal(PROTOCOL_VERSION, ${PROTOCOL_VERSION});
      const bot = new BotClient({ publicKey: 'a'.repeat(64), autoReconnect: false });
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
        assert.equal(manifest.commands[0].name, '8ball');
      } finally {
        await bot.close();
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { cwd: workspace, env, stdio: 'inherit', timeout: 15000 });
  console.log('SDK tarball installed and served its manifest outside the monorepo.');
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
