import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LocalBotIdentity } from '@monky/shared';
import { mt, setMainLanguage } from '../src/main/i18n';
import type { LocalToolPreparationInfo } from '../src/main/localExecution/LocalTools';
import {
  formatLocalToolBytes, maintenanceDialogHtml, maintenanceDialogState, preparationDialogHtml, preparationDialogState,
} from '../src/main/localExecution/preparationView';

function inventory(): LocalToolPreparationInfo {
  return {
    maximumCacheBytes: 512 * 1024 ** 2,
    tools: (['node', 'yt-dlp', 'ffmpeg'] as const).map((id) => ({
      info: { id, status: 'absent', version: null, sizeBytes: 0, sourceUrl: null, requiredBy: [], progress: null, failure: null },
      maximumAdditionalBytes: 128 * 1024 ** 2,
    })),
  };
}

test('installation progress is measured bytes, never a synthetic extraction or validation percentage', () => {
  setMainLanguage('en');
  const data = inventory();
  const tool = data.tools[0].info;
  tool.status = 'installing';
  tool.progress = { stage: 'downloading', downloadedBytes: 25 * 1024 ** 2, totalBytes: 100 * 1024 ** 2 };
  const downloading = preparationDialogState('installing', data);
  assert.equal(downloading.progress, 25);
  assert.match(downloading.status, /Downloading Node\.js/);
  assert.match(downloading.detail, /25 MB of 100 MB/);
  tool.progress.totalBytes = null;
  assert.equal(preparationDialogState('installing', data).progress, null);
  tool.progress.totalBytes = tool.progress.downloadedBytes;
  for (const stage of ['resolving', 'verifying', 'extracting', 'checking'] as const) {
    tool.progress.stage = stage;
    const state = preparationDialogState('installing', data);
    assert.equal(state.phase, 'installing');
    assert.equal(state.progress, null, `${stage} must not claim the installation is 100% complete`);
  }
});

test('maintenance reuses the branded document and explains its effect without requesting capability consent', () => {
  for (const language of ['pt-BR', 'en'] as const) {
    setMainLanguage(language);
    for (const request of [{ mode: 'remove', tool: 'node', affectedTasks: 3 }, { mode: 'cache', affectedTasks: 3 }] as const) {
      const html = maintenanceDialogHtml(request, { icon: 'data:image/png;base64,', font: 'data:font/woff2;base64,' });
      assert.match(html, /script-src 'none'/);
      assert.match(html, /id="title" tabindex="-1"/);
      assert.match(html, /id="choices" hidden/);
      assert.match(html, /prefers-reduced-motion/);
      assert.doesNotMatch(html, /<script|type="(?:radio|checkbox)"/);
      assert.ok(html.includes(mt(request.mode === 'remove' ? 'localExecution.removeDetail' : 'localExecution.clearCacheDetail', { count: '3' })));
      assert.equal(maintenanceDialogState(request, 'installing').progress, null);
      assert.equal(maintenanceDialogState(request, 'failed', 'storage_failed').detail, mt('localExecution.installStorageFailed'));
    }
  }
});

test('disclosure distinguishes conservative additional storage from existing real storage', () => {
  const data = inventory();
  for (const language of ['pt-BR', 'en'] as const) {
    setMainLanguage(language);
    const planned = preparationDialogState('consent', data);
    assert.match(planned.storage, /384 MB/);
    assert.ok(planned.tools.every((tool) => !tool.ready && /128 MB/.test(tool.size)));
    assert.ok(planned.tools.every((tool) => tool.status !== tool.id));
  }
  for (const tool of data.tools) {
    tool.info.status = 'ready';
    tool.info.version = '1.2.3';
    tool.info.sizeBytes = 10 * 1024 ** 2;
    tool.maximumAdditionalBytes = 0;
  }
  const installed = preparationDialogState('consent', data);
  assert.match(installed.storage, /30 MB already installed/);
  assert.ok(installed.tools.every((tool) => tool.ready && tool.size === '1.2.3 \u00b7 10 MB'));
  assert.match(preparationDialogState('failed', data, 'integrity_failed').detail, /integrity verification/);
  assert.equal(formatLocalToolBytes(350 * 1024 ** 2 + 16 * 1024, true), '350.1 MB',
    'Rounding a stated storage ceiling down would understate the permitted maximum');
});

test('the trusted dialog discloses each fixed tool and escapes request identities under a no-script CSP', () => {
  const bot: LocalBotIdentity = {
    serverOrigin: 'wss://example.test', serverId: 'server', serverName: 'Server <script>alert(1)</script>',
    botId: 'bot', botName: '<img src=x onerror=alert(1)>', botPublicKey: 'a'.repeat(64),
  };
  for (const language of ['pt-BR', 'en'] as const) {
    setMainLanguage(language);
    const html = preparationDialogHtml({
      bot, capability: 'youtube-audio', mode: 'consent', inventory: inventory(),
      icon: 'data:image/png;base64,', font: 'data:font/woff2;base64,',
    });
    assert.ok(html.includes(`lang="${language}"`));
    assert.match(html, /script-src 'none'/);
    assert.doesNotMatch(html, /<script|<img src=x|type="(?:radio|checkbox)"/);
    assert.match(html, /&lt;img src=x/);
    for (const name of ['Node.js', 'yt-dlp', 'FFmpeg']) assert.ok(html.includes(name));
    assert.ok(html.includes(language === 'en' ? 'Converts audio' : 'Converte o áudio'));
    assert.match(html, /512 MB/);
    assert.match(html, /role="radiogroup"/);
    assert.match(html, /prefers-reduced-motion/);
    assert.match(html, /id="allow" disabled/);
    assert.match(html, /id="always-choice" role="radio" aria-checked="true"/);
    assert.match(html, /id="connection-choice" role="radio" aria-checked="false"/);
    assert.ok(html.includes(mt('localExecution.allowAlwaysAndPrepare')));
    assert.ok(html.includes(mt('localExecution.allowConnectionAndPrepare')));
    assert.match(html, /id="title" tabindex="-1"/);
    assert.ok(html.includes(`id="retry" hidden>${mt('localExecution.retry')}</button>`));
    assert.ok(!preparationDialogState('failed', inventory()).detail.includes(
      language === 'en' ? 'Close this window and try again' : 'Feche esta janela e tente novamente',
    ));
  }
});
