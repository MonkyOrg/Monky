'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');
const { MessageType, ProtocolErrorCode } = require('@monky/shared');

class ProtocolRequestError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

for (const [label, failure, expected] of [
  ['permission refusal', new ProtocolRequestError('Permission denied', ProtocolErrorCode.PERMISSION_DENIED), 'browser.broadcastPermissionDenied'],
  ['capture failure', new Error('The browser capture produced no video frame.'), 'browser.broadcastFailed'],
  ['other protocol failure', new ProtocolRequestError('Channel unavailable', ProtocolErrorCode.CHANNEL_NOT_FOUND), 'browser.broadcastFailed'],
]) {
  test(`browser ${label} keeps teardown and reports the appropriate alert`, async () => {
    const reports = [], logs = [], requests = [], events = [];
    class Browser {
      element = {};
      signal = new AbortController().signal;
      setVolume() {}
      async capture() { throw failure; }
    }
    const imports = {
      '@monky/shared': require('@monky/shared'),
      '../core/EventBus': { appEvents: { emit: (...args) => events.push(args) } },
      '../core/NetworkClient': { ProtocolRequestError },
      '../core/ClientLogService': { clientLog: { logError: (...args) => logs.push(args) } },
      '../i18n': { t: key => key, getLanguage: () => 'en' },
      '../utils/desktopOnly': { isDesktopOnly: () => false },
      './BotBrowserView': { BotBrowserView: Browser },
    };
    const filename = path.resolve(__dirname, '..', 'src', 'renderer', 'views', 'BotScreenView.ts');
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
      fileName: filename,
    }).outputText;
    const module = { exports: {} };
    vm.runInNewContext(`(function(exports, require, module) { ${code}\n})`, {
      console: { error() {} }, crypto: require('node:crypto').webcrypto,
    }, { filename })(module.exports, request => imports[request] ?? {}, module);
    const view = Object.assign(Object.create(module.exports.BotScreenView.prototype), {
      destroyed: false, frame: null,
      context: {
        user: { sessionId: 'host' },
        session: { key: 'server', client: {
          getStatus: () => 'CONNECTED',
          sendRequest: async (...args) => { requests.push(args); },
        } },
      },
      canRead: () => true,
      body: { append() {} }, placeholder: { hidden: false },
      localize() {}, outputVolume: () => 1,
      leave(reason) { this.left = reason; this.frame = null; },
      report(message) { reports.push(message); },
    });
    const screen = { id: 'browser', instanceId: 'instance', channelId: 'room', hostSessionId: 'host' };
    await view.openBrowser(screen);
    assert.deepEqual(reports, [expected]);
    assert.equal(view.left, 'revoked');
    assert.equal(view.frame, null);
    assert.deepEqual(structuredClone(requests), [[MessageType.BOT_SCREEN_END, { id: 'browser', instanceId: 'instance' }]]);
    assert.equal(events.length, 1);
    assert.deepEqual(logs, [['SCREEN_SHARE', 'Browser miniapp host failed', failure]]);
  });
}
