const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const ts = require('typescript');

const rendererRoot = path.resolve(__dirname, '..', 'src', 'renderer');
const failureCodes = [
  'invalid_request', 'permission_denied', 'permission_revoked', 'executor_unavailable',
  'unsupported_platform', 'tools_missing', 'tool_install_failed', 'integrity_failed',
  'storage_failed', 'provider_unavailable', 'transport_failed', 'worker_failed',
  'busy', 'timeout', 'cancelled',
];
const empty = () => ({ supported: true, tools: [], permissions: [], tasks: [], toolsBytes: 0, cacheBytes: 0 });
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
const flush = async () => { for (let count = 0; count < 20; count++) await Promise.resolve(); };

class MountedRoot extends EventTarget {
  isConnected = true;
  querySelectorAll() { return []; }
}

class Input {
  disabled = false;
  parentElement = { style: { opacity: '' } };
  attributes = new Map();
  setAttribute(name, value) { this.attributes.set(name, value); }
}

function fixture(language = 'en') {
  const reads = [];
  const mutations = [];
  const external = [];
  const listeners = new Set();
  const allListeners = [];
  const renders = [];
  const subscriptions = { added: 0, removed: 0, fail: false };
  const mutation = (kind, input) => {
    const request = { ...deferred(), kind, input };
    mutations.push(request);
    return request.promise;
  };
  const api = {
    getLocalExecutionState() {
      const request = deferred();
      reads.push(request);
      return request.promise;
    },
    onLocalExecutionChanged(callback) {
      if (subscriptions.fail) throw new Error('private IPC diagnostic');
      subscriptions.added++;
      listeners.add(callback);
      allListeners.push(callback);
      return () => { subscriptions.removed++; listeners.delete(callback); };
    },
    setLocalExecutionPermission: input => mutation('permission', input),
    removeLocalTool: input => mutation('remove', input),
    clearLocalExecutionCache: () => mutation('cache'),
    cancelLocalExecutionTask: input => mutation('cancel', input),
    openExternal(url) {
      const request = { ...deferred(), url };
      external.push(request);
      return request.promise;
    },
  };
  const storage = new Map();
  const globals = {
    window: { api },
    document: { documentElement: { lang: language }, activeElement: null },
    navigator: { languages: [language], language },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    HTMLInputElement: Input, Element: MountedRoot, Event, Error, Promise, Intl, console,
    AbortController, setTimeout, clearTimeout,
  };
  const modules = new Map();
  const allowed = new Set([
    'views/settings/tabs/LocalToolsTab', 'i18n/index', 'i18n/locales/en',
    'i18n/locales/pt-BR', 'utils/html', 'utils/attachment', 'utils/loadingIndicator',
  ]);
  function load(name) {
    if (modules.has(name)) return modules.get(name);
    assert.ok(allowed.has(name), `Unexpected renderer dependency: ${name}`);
    const filename = path.join(rendererRoot, ...name.split('/')) + '.ts';
    const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const module = { exports: {} };
    modules.set(name, module.exports);
    vm.runInNewContext(code, {
      ...globals, module, exports: module.exports,
      require(request) {
        if (request.endsWith('/core/EventBus')) return { appEvents: { emit() {} } };
        if (request.endsWith('/core/NetworkClient')) return { networkClient: {} };
        if (!request.startsWith('.')) throw new Error(`Unexpected IPC or network dependency: ${request}`);
        let resolved = path.posix.normalize(path.posix.join(path.posix.dirname(name), request));
        if (resolved === 'i18n') resolved = 'i18n/index';
        return load(resolved);
      },
    }, { filename });
    return module.exports;
  }
  const { LocalToolsTab } = load('views/settings/tabs/LocalToolsTab');
  const { t, setLanguage } = load('i18n/index');
  setLanguage(language);
  const tab = new LocalToolsTab();
  // Only painting is replaced here. The real IPC, mutation and mount-generation
  // logic runs without a browser; localToolsDom.test.cjs covers the actual DOM.
  tab.renderState = () => renders.push({
    root: tab.root, snapshot: tab.snapshot, pending: tab.pending,
    feedback: tab.feedback, failure: tab.loadFailure, loading: tab.loading,
  });
  const mount = (root = new MountedRoot()) => {
    const container = { querySelector: selector => selector === '[data-local-tools-root]' ? root : null };
    const ready = tab.attachEvents(container);
    return { root, container, ready };
  };
  return {
    tab, t, api, reads, mutations, external, listeners, allListeners, subscriptions, renders, mount, document: globals.document,
    emit(snapshot) { for (const listener of listeners) listener(snapshot); },
    catalogs: { en: load('i18n/locales/en').en, 'pt-BR': load('i18n/locales/pt-BR').ptBR },
  };
}

for (const language of ['pt-BR', 'en']) {
  test(`local tools locale keys, failure messages and escaped section labels (${language})`, () => {
    const f = fixture(language);
    const keys = catalog => Object.keys(catalog).filter(key => key.startsWith('localExecution.') || key === 'settings.tabLocalTools').sort();
    assert.deepEqual(keys(f.catalogs.en), keys(f.catalogs['pt-BR']));
    for (const key of keys(f.catalogs.en)) {
      assert.deepEqual((f.catalogs.en[key].match(/\{\w+\}/g) ?? []).sort(), (f.catalogs['pt-BR'][key].match(/\{\w+\}/g) ?? []).sort(), key);
      assert.equal(typeof f.t(key), 'string');
      assert.notEqual(f.t(key), key);
    }
    for (const code of failureCodes) assert.notEqual(f.t(`localExecution.failure.${code}`), code);
    const expected = language === 'en' ? 'Bot tools' : 'Ferramentas de bots';
    assert.equal(f.t('settings.tabLocalTools'), expected);
    f.catalogs[language]['localExecution.tools'] = 'Tools "quoted" <tag> & friends';
    const html = f.tab.renderHtml();
    assert.ok(html.includes('data-settings-label="Tools &quot;quoted&quot; &lt;tag&gt; &amp; friends"'));
    const sections = [...html.matchAll(/data-settings-section="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(sections, ['local-tools-storage', 'local-tools-tools', 'local-tools-permissions', 'local-tools-tasks']);
    assert.equal(new Set(sections).size, 4);
    assert.ok(html.includes(f.t('localExecution.notLoaded')));
    assert.ok(!html.includes('href=') && !html.includes('<script'));
  });

  test(`client-initiated preparation tasks have a localized operation and remain cancellable (${language})`, () => {
    const f = fixture(language);
    const fields = new Map();
    for (const name of ['identity-title', 'identity-origin', 'identity-details', 'task-operation', 'task-phase', 'task-started']) {
      fields.set(`[data-field="${name}"]`, { textContent: '' });
    }
    const cancel = { disabled: false, dataset: {}, style: {}, setAttribute() {} };
    fields.set('[data-local-action="cancel"]', cancel);
    const row = { dataset: {}, querySelector: selector => fields.get(selector) ?? null };
    const task = {
      id: 'preparation-1',
      bot: { serverOrigin: 'wss://example.invalid', serverId: 'server-1', serverName: 'Server', botId: 'bot-1', botName: 'Bot', botPublicKey: 'a'.repeat(64) },
      capability: 'youtube-audio', operation: 'tools.prepare', phase: 'consent', startedAt: 1000,
    };
    for (const phase of ['consent', 'installing']) {
      f.tab.renderTask(row, { ...task, phase }, false);
      const label = fields.get('[data-field="task-operation"]').textContent;
      assert.equal(label, f.t('localExecution.taskOperation', {
        capability: f.t('localExecution.capability.youtube-audio'),
        operation: language === 'en' ? 'Prepare local tools' : 'Preparar ferramentas locais',
      }));
      assert.ok(!label.includes('tools.prepare'));
      assert.equal(fields.get('[data-field="task-phase"]').textContent, f.t(`localExecution.phase.${phase}`));
      assert.equal(cancel.dataset.localTask, task.id);
      assert.equal(cancel.disabled, false);
    }
  });
}

test('one subscription per mount; a newer change wins over a delayed state read', async () => {
  const f = fixture();
  const mounted = f.mount();
  assert.equal(f.tab.attachEvents(mounted.container), mounted.ready, 'duplicate mounts reuse the same readiness promise');
  assert.equal(f.subscriptions.added, 1);
  assert.equal(f.reads.length, 1);
  assert.equal(f.tab.snapshot, null);
  const newer = { ...empty(), toolsBytes: 1234, cacheBytes: 512 };
  f.emit(newer);
  f.reads[0].resolve(empty());
  await mounted.ready;
  assert.equal(f.tab.snapshot, newer);
  assert.equal(f.tab.loading, false);
  f.tab.cleanup();
  f.tab.cleanup();
  assert.equal(f.subscriptions.removed, 1);
  assert.equal(f.listeners.size, 0);
});

test('cleanup ignores late get-state and queued change callbacks, even when the same DOM root is remounted', async () => {
  const f = fixture();
  const { root, container } = f.mount();
  const obsoleteChange = f.allListeners[0];
  f.tab.cleanup();
  const renderedBeforeLate = f.renders.length;
  obsoleteChange({ ...empty(), cacheBytes: 999 });
  assert.equal(f.renders.length, renderedBeforeLate);
  f.tab.attachEvents(container);
  f.reads[0].resolve({ ...empty(), toolsBytes: 999 });
  obsoleteChange({ ...empty(), toolsBytes: 888 });
  await flush();
  assert.equal(f.tab.snapshot, null);
  assert.equal(f.reads.length, 2);
  f.reads[1].resolve(empty());
  await flush();
  const final = f.tab.snapshot;
  root.isConnected = false;
  f.emit({ ...empty(), cacheBytes: 777 });
  assert.equal(f.tab.snapshot, final);
  f.tab.cleanup();
  assert.equal(f.listeners.size, 0);
});

test('permission intent survives changes, duplicate mutations do not prompt again, and cancellation restores authoritative state', async () => {
  const f = fixture();
  f.mount();
  f.reads[0].resolve(empty());
  await flush();
  const operation = f.tab.mutate({ kind: 'permission', permissionId: 'a'.repeat(64), enabled: true });
  f.emit({ ...empty(), cacheBytes: 1024 });
  await f.tab.mutate({ kind: 'cache' });
  assert.equal(f.mutations.length, 1);
  assert.equal(f.mutations[0].input.permissionId, 'a'.repeat(64));
  assert.equal(f.mutations[0].input.enabled, true);
  assert.equal(f.tab.pending.enabled, true);
  const input = new Input();
  f.tab.setControl(input, false);
  assert.equal(input.disabled, false, 'pending status must not blur the switch');
  assert.equal(input.attributes.get('aria-disabled'), 'true');
  f.document.activeElement = input;
  f.tab.setControl(input, true);
  assert.equal(input.disabled, false, 'a now-unavailable focused action must also retain keyboard focus');
  assert.equal(input.attributes.get('aria-disabled'), 'true');
  f.document.activeElement = null;
  f.mutations[0].resolve({ status: 'cancelled' });
  await flush();
  assert.equal(f.tab.feedback, f.t('localExecution.actionCancelled'));
  assert.equal(f.tab.pending, null, 'a completed IPC action must not keep the tab locked during a state read');
  assert.equal(f.tab.permissionIntent, null, 'a cancelled toggle restores the latest snapshot without waiting for another read');
  f.reads[1].resolve(empty());
  await operation;
  assert.equal(f.tab.pending, null);
  assert.equal(f.tab.feedbackError, false);
  assert.equal(f.mutations.length, 1);
  f.tab.cleanup();
});

test('completed removals release other controls before a delayed inventory reply', async () => {
  const f = fixture();
  f.mount();
  f.reads[0].resolve(empty());
  await flush();
  const removal = f.tab.mutate({ kind: 'remove', tool: 'node' });
  f.mutations[0].resolve({ status: 'completed' });
  await flush();
  assert.equal(f.tab.pending, null);
  assert.equal(f.tab.feedback, f.t('localExecution.toolRemoved'));
  const next = f.tab.mutate({ kind: 'remove', tool: 'ffmpeg' });
  assert.equal(f.mutations.length, 2, 'another installed tool can be removed while the previous refresh is still pending');
  const pending = f.tab.pending;
  f.reads[1].resolve(empty());
  await removal;
  assert.equal(f.tab.pending, pending, 'the old refresh must not unlock an in-flight mutation');
  f.mutations[1].resolve({ status: 'cancelled' });
  await flush();
  f.reads[2].resolve(empty());
  await next;
  f.tab.cleanup();
});

test('a stalled inventory read reports a timeout and can be refreshed without remounting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const { ready } = f.mount();
  t.mock.timers.tick(15_000);
  await ready;
  assert.equal(f.tab.loading, false);
  assert.equal(f.tab.loadFailure, 'timeout');
  f.tab.handleAction({ dataset: { localAction: 'refresh' } });
  f.reads[1].resolve(empty());
  await flush();
  assert.equal(f.tab.loadFailure, null);
  assert.equal(f.tab.loading, false);
  f.reads[0].resolve({ ...empty(), toolsBytes: 999 });
  await flush();
  assert.equal(f.tab.snapshot.toolsBytes, 0, 'a timed-out reply cannot replace the refreshed state');
  f.tab.cleanup();
});

test('every LocalExecutionFailure is localized, and rejected IPC never exposes exception text', async () => {
  const f = fixture();
  f.mount();
  f.reads[0].resolve(empty());
  await flush();
  for (const reason of failureCodes) {
    const operation = f.tab.mutate({ kind: 'cache' });
    f.mutations.at(-1).resolve({ status: 'failed', reason });
    await flush();
    f.reads.at(-1).resolve(empty());
    await operation;
    assert.equal(f.tab.feedback, f.t(`localExecution.failure.${reason}`));
    assert.equal(f.tab.feedbackError, true);
    assert.equal(f.tab.pending, null);
  }
  const operation = f.tab.mutate({ kind: 'cache' });
  f.mutations.at(-1).reject(new Error('<script>private native path and error</script>'));
  await flush();
  f.reads.at(-1).resolve(empty());
  await operation;
  assert.equal(f.tab.feedback, f.t('localExecution.failure.transport_failed'));
  assert.ok(!f.tab.feedback.includes('private'));
  f.tab.cleanup();
});

test('state failures are explicit and retryable; failed stale reads do not hide newer data', async () => {
  const f = fixture();
  const { root } = f.mount();
  f.reads[0].reject(new Error('private storage location'));
  await flush();
  assert.equal(f.tab.loadFailure, 'transport_failed');
  assert.equal(f.tab.snapshot, null);
  const refresh = f.tab.refreshState(root, f.tab.generation);
  const newer = { ...empty(), cacheBytes: 1024 };
  f.emit(newer);
  f.reads[1].reject(new Error('obsolete failure'));
  await refresh;
  assert.equal(f.tab.loadFailure, null);
  assert.equal(f.tab.snapshot, newer);
  assert.equal(f.subscriptions.added, 1);
  f.tab.cleanup();

  f.subscriptions.fail = true;
  f.mount();
  assert.equal(f.tab.loadFailure, 'executor_unavailable');
  assert.equal(f.listeners.size, 0);
  f.subscriptions.fail = false;
  f.tab.handleAction({ dataset: { localAction: 'refresh' } });
  f.reads.at(-1).resolve(empty());
  await flush();
  assert.equal(f.listeners.size, 1);
  assert.equal(f.tab.loadFailure, null);
  f.tab.cleanup();
});

test('remove, cache and task actions use exact IPC arguments without automatic authorization or installation', async () => {
  const f = fixture();
  f.mount();
  f.reads[0].resolve(empty());
  await flush();
  const actions = [
    [{ kind: 'remove', tool: 'yt-dlp' }, 'yt-dlp'],
    [{ kind: 'cache' }, undefined],
    [{ kind: 'cancel', taskId: 'task-1' }, 'task-1'],
  ];
  for (const [action, input] of actions) {
    const operation = f.tab.mutate(action);
    assert.equal(f.mutations.at(-1).kind, action.kind);
    assert.equal(f.mutations.at(-1).input, input);
    f.mutations.at(-1).resolve({ status: 'completed' });
    await flush();
    f.reads.at(-1).resolve(empty());
    await operation;
    assert.equal(f.tab.pending, null);
  }
  assert.equal(f.mutations.length, 3);
  const source = f.tab.openSource('node', 'https://example.invalid/node?artifact=%22');
  assert.equal(f.external[0].url, 'https://example.invalid/node?artifact=%22');
  f.external[0].resolve({ success: false });
  await source;
  assert.equal(f.tab.feedback, f.t('localExecution.sourceFailed'));
  assert.equal(f.tab.feedbackError, true);
  f.tab.cleanup();
});

test('closing during a mutation cannot refresh or clear pending intent in a reopened mount', async () => {
  const f = fixture();
  f.mount();
  f.reads[0].resolve(empty());
  await flush();
  const obsolete = f.tab.mutate({ kind: 'cache' });
  f.tab.cleanup();
  f.mount();
  f.reads[1].resolve(empty());
  await flush();
  const current = f.tab.mutate({ kind: 'permission', permissionId: 'b'.repeat(64), enabled: false });
  const pending = f.tab.pending;
  f.mutations[0].resolve({ status: 'failed', reason: 'timeout' });
  await obsolete;
  assert.equal(f.reads.length, 2, 'old action must not fetch state for the new mount');
  assert.equal(f.tab.pending, pending);
  assert.equal(f.tab.feedback, f.t('localExecution.pending'));
  f.mutations[1].resolve({ status: 'completed' });
  await flush();
  f.tab.cleanup();
  f.mount();
  const before = f.renders.length;
  f.reads[2].resolve({ ...empty(), cacheBytes: 555 });
  await current;
  assert.equal(f.renders.length, before, 'late post-mutation refresh cannot paint another mount');
  assert.equal(f.tab.snapshot, null);
  f.reads[3].resolve(empty());
  await flush();
  const source = f.tab.openSource('ffmpeg', 'https://example.invalid/ffmpeg');
  f.tab.cleanup();
  const afterClose = f.renders.length;
  f.external[0].reject(new Error('late private URL error'));
  await source;
  assert.equal(f.renders.length, afterClose);
  assert.equal(f.listeners.size, 0);
});
