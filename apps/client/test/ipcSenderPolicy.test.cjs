const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const ts = require('typescript');

const main = path.join(__dirname, '..', 'src', 'main');

const shared = require('@monky/shared');

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') ? [full] : [];
  });
}

const unwrap = node => ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)
  ? unwrap(node.expression) : node;

/** The channel a registration names: a literal, a shared constant or a `const` of the same file. */
function channelOf(node, declarations) {
  node = unwrap(node);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) {
    if (typeof shared[node.text] === 'string') return shared[node.text];
    const value = declarations.get(node.text);
    return value && ts.isStringLiteralLike(unwrap(value)) ? unwrap(value).text : undefined;
  }
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const group = shared[node.expression.text];
    return group && typeof group[node.name.text] === 'string' ? group[node.name.text] : undefined;
  }
  return undefined;
}

/** The windows a registry policy admits: 'main', a list, `{ from, refused }` or a `const` of the same file. */
function sendersOf(node, declarations, source) {
  node = unwrap(node);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isArrayLiteralExpression(node)) return node.elements.flatMap(element => sendersOf(element, declarations, source));
  if (ts.isObjectLiteralExpression(node)) {
    const from = node.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'from');
    assert.ok(from, `A policy object names its senders: ${node.getText(source)}`);
    return sendersOf(from.initializer, declarations, source);
  }
  if (ts.isIdentifier(node) && declarations.has(node.text)) return sendersOf(declarations.get(node.text), declarations, source);
  assert.fail(`A sender policy must be readable in its file: ${node.getText(source)}`);
}

/** Every handler Main registers: through an IPC registry, with its policy, or straight on ipcMain. */
function registrations() {
  const found = [];
  for (const filename of sourceFiles(main)) {
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const file = path.relative(main, filename).replace(/\\/g, '/');
    const declarations = new Map();
    const declare = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) declarations.set(node.name.text, node.initializer);
      ts.forEachChild(node, declare);
    };
    declare(source);
    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const [channelNode, second] = node.arguments;
        const channel = channelNode && channelOf(channelNode, declarations);
        if (channel && ts.isPropertyAccessExpression(callee) && callee.name.text === 'handle') {
          found.push(node.arguments.length === 3
            ? { file, channel, via: 'registry', senders: sendersOf(second, declarations, source) }
            : { file, channel, via: callee.getText(source) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

test('every channel names who may call it, and only three of them admit the overlay', () => {
  const found = registrations();
  const channels = found.map(entry => entry.channel);
  assert.deepEqual(channels.filter((channel, index) => channels.indexOf(channel) !== index), [],
    'Each channel is registered once');
  const admitsOverlay = found.filter(entry => entry.senders?.includes('overlay'));
  assert.deepEqual(admitsOverlay.map(entry => entry.channel).sort(), ['overlay:close', 'overlay:layout-cards', 'overlay:send-signal'],
    'The overlay page reaches only what its preload offers (E-MAIN-1)');
  assert.deepEqual(found.find(entry => entry.channel === 'overlay:layout-cards').senders, ['overlay'],
    'Only the overlay sizes its own cards');
  for (const entry of found.filter(entry => entry.senders)) {
    assert.ok(entry.senders.length > 0 && entry.senders.every(sender => sender === 'main' || sender === 'overlay'),
      `${entry.channel} admits known senders only: ${entry.senders}`);
  }
  // Modules that still check their senders themselves: the crash recovery and local preparation windows have
  // pages of their own, miniapp documents and storage outlive any one window, and QA drives its own window.
  const ownChecks = new Set([
    'botScreenDocuments.ts', 'botStorage/ipc.ts', 'crashRecovery.ts', 'developmentQa.ts',
    'localExecution/ipc.ts', 'localExecution/preparationWindow.ts',
  ]);
  assert.deepEqual(found.filter(entry => !entry.senders && !ownChecks.has(entry.file)).map(entry => `${entry.file}: ${entry.channel}`), [],
    'New channels go through an IPC registry, which checks the sender before the handler runs');
});

test('identity, backup, hosting, media files, downloads, auto-start and global input answer only the main window', () => {
  const found = new Map(registrations().map(entry => [entry.channel, entry]));
  const sensitive = [
    'identity:status', 'identity:create', 'identity:get', 'identity:get-client-id', 'identity:sign-challenge',
    'identity:export', 'identity:import', 'identity:logout',
    'backup:encrypt', 'backup:decrypt', 'backup:save-file', 'backup:open-file',
    'server-host:start', 'server-host:stop', 'server-host:status', 'server-host:logs',
    'server-host:clear-logs', 'server-host:stats', 'server-host:delete-data', 'lan:start', 'lan:stop',
    'soundboard:list-sounds', 'soundboard:read-sound', 'dialog:select-sound-file',
    'stickers:list', 'stickers:read', 'stickers:save', 'dialog:select-stickers-folder',
    'app:download-file', 'app:save-csv-file', 'app:get-auto-start', 'app:set-auto-start',
    shared.MEDIA_FOLDERS_IPC.adopt,
    // Shortcuts and push-to-talk: the overlay or a frame must not replace the main window's global input (R-MEDIA-3).
    ...Object.values(shared.SHORTCUT_IPC),
  ];
  for (const channel of sensitive) {
    assert.deepEqual(found.get(channel)?.senders, ['main'], `${channel} must only answer the main window`);
  }
});

test('no IPC channel, preload method or contract reaches the retired system-audio loopback', () => {
  // Since #689 screen audio is captured per shared source by native screen sharing, behind its own
  // confirmation. The old loopback answered any renderer frame, the overlay included, without checks.
  const sources = {
    main: path.join(main, 'ipcHandlers.ts'),
    ...Object.fromEntries(sourceFiles(path.join(main, 'ipc')).map(filename => [path.relative(main, filename), filename])),
    preload: path.join(main, '..', 'preload', 'preload.ts'),
    overlay: path.join(main, '..', 'preload', 'overlayPreload.ts'),
    contract: path.join(__dirname, '..', '..', '..', 'packages', 'shared', 'src', 'ipc.ts'),
  };
  for (const [label, filename] of Object.entries(sources)) {
    const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
    const exposed = [];
    const visit = (node) => {
      if (ts.isStringLiteralLike(node) && node.text.startsWith('screen-audio:')) exposed.push(node.text);
      if ((ts.isPropertyAssignment(node) || ts.isPropertySignature(node) || ts.isMethodDeclaration(node))
        && /^(?:on|remove)?ScreenAudio|^screenAudio/u.test(node.name.getText(source))) exposed.push(node.name.getText(source));
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.deepEqual(exposed, [], `${label} must not expose the legacy screen audio capture`);
  }
  const addon = require(path.join(__dirname, '..', 'native', 'screen-audio', 'index.js'));
  assert.deepEqual(['start', 'stop', 'getLastError', 'getStatus'].filter(name => name in addon), [],
    'The audio addon only captures through packet sessions');
});
