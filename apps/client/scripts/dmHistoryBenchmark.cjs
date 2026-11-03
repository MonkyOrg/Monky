'use strict';

/**
 * Benchmark of a long DM history (#823): one conversation with 50 thousand
 * messages over two years, written in the single file of versions before
 * #823, then opened, greeted (digest), written to and backed up through the
 * public DmService API only, so the same script measures any version.
 *
 *   node --expose-gc scripts/dmHistoryBenchmark.cjs [--dist dist-test] [--messages 50000]
 *
 * `--dist` is the folder the client tests compile to (it holds
 * `src/main/dm/dmService.js`); point it at a build of another revision to
 * compare.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { generateKeyPairSync } = require('node:crypto');
const { performance } = require('node:perf_hooks');

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dist = path.resolve(option('--dist', path.join(__dirname, '..', 'dist-test')));
const total = Number(option('--messages', '50000'));
const dm = (name) => require(path.join(dist, 'src', 'main', 'dm', `${name}.js`));
const { DmService } = dm('dmService');
const { DmKeyring, newDmId } = dm('dmCrypto');
const { DmPersistence } = dm('dmPersistence');

const DAY_MS = 86_400_000;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'monky-dm-bench-'));
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }));

function identity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('hex'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

function device(id, dir) {
  const service = new DmService({ keyring: new DmKeyring(id.publicKey, id.privateKey), dir });
  service.setSelfNickname('bench');
  return { id, dir, service };
}

/** Delivers everything between two devices until nothing is left, acks included. */
function relay(devices, from, dispatch) {
  const queue = [];
  const push = (sender, result) => {
    for (const items of [...Object.values(result.peers ?? {}), ...Object.values(result.everywhere ?? {})]) {
      for (const item of items) queue.push({ sender, item });
    }
    for (const item of [...(result.broadcast ?? []), ...(result.reply ?? [])]) queue.push({ sender, item });
  };
  push(from, dispatch);
  for (let guard = 0; queue.length > 0 && guard < 10_000; guard += 1) {
    const { sender, item } = queue.shift();
    for (const target of devices) {
      if (target === sender || target.id.publicKey !== item.to) continue;
      push(target, target.service.ingest({ from: sender.id.publicKey, kind: item.kind, data: item.data }));
    }
  }
}

function time(run) {
  const start = performance.now();
  const value = run();
  return { ms: performance.now() - start, value };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function heapMb() {
  global.gc?.();
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

const aliceId = identity();
const bobId = identity();
const aliceDir = path.join(root, 'alice');
const alice = device(aliceId, aliceDir);
const bob = device(bobId, path.join(root, 'bob'));
relay([alice, bob], alice, alice.service.sendFriendRequest(bobId.publicKey, 'bob'));
relay([alice, bob], bob, bob.service.acceptFriend(aliceId.publicKey));
alice.service.openConversation(bobId.publicKey);
alice.service.flush();

// The history, as versions before #823 saved it: every message in one sealed file.
const end = Date.now() - DAY_MS;
const span = 730 * DAY_MS;
const messages = [];
for (let index = 0; index < total; index += 1) {
  const mine = index % 2 === 0;
  messages.push({
    id: newDmId(),
    author: mine ? aliceId.publicKey : bobId.publicKey,
    content: `Mensagem ${index}: um texto do tamanho de uma conversa comum entre amigos.`,
    createdAt: end - span + Math.floor((index * span) / total),
    editedAt: null,
    deleted: false,
    replyTo: null,
    reactions: index % 25 === 0 ? { '👍': { [bobId.publicKey]: { on: true, ts: end - span } } } : {},
    attachments: [],
    delivery: mine ? 'delivered' : null,
    forwarded: null,
  });
}
const store = new DmPersistence(aliceDir, new DmKeyring(aliceId.publicKey, aliceId.privateKey).storageKey());
store.writeJsonNow(DmPersistence.peerFileName(bobId.publicKey), { version: 1, peer: bobId.publicKey, messages });
const legacyBytes = fs.statSync(path.join(aliceDir, DmPersistence.peerFileName(bobId.publicKey))).size;

const results = [];
const record = (label, ms) => results.push({ label, ms: Math.round(ms * 10) / 10 });

// First open after the update (versions with months move the old file here).
const firstOpen = device(aliceId, aliceDir);
record('Primeira abertura da conversa (80 mensagens)', time(() => firstOpen.service.getConversation(bobId.publicKey)).ms);
firstOpen.service.flush();

// A later session: open the conversation, greet own devices (digest).
const heapBefore = heapMb();
const session = device(aliceId, aliceDir);
record('Sessão nova: abrir a conversa (80 mensagens)', time(() => session.service.getConversation(bobId.publicKey)).ms);
record('Sessão nova: memória após abrir (MB de heap)', heapMb() - heapBefore);
const digestSession = device(aliceId, aliceDir);
record('Sessão nova: hello com digest do histórico', time(() => digestSession.service.hello(false)).ms);
record('Paginar 10 páginas para trás', time(() => {
  let before = null;
  for (let page = 0; page < 10; page += 1) {
    const result = session.service.getConversation(bobId.publicKey, before);
    before = result.messages[0]?.id ?? null;
  }
}).ms);

// Writing: each message is handled and saved on its own, as in a live conversation.
const sends = [];
const saves = [];
for (let round = 0; round < 20; round += 1) {
  sends.push(time(() => session.service.sendMessage({ peer: bobId.publicKey, content: `nova ${round}` })).ms);
  saves.push(time(() => session.service.flush()).ms);
}
record('Enviar uma mensagem (mediana, sem gravar)', median(sends));
record('Gravar após uma mensagem (mediana)', median(saves));

// Backup and restore with the history.
const exported = time(() => session.service.exportData(true));
record('Exportar identidade com histórico', exported.ms);
const backup = JSON.parse(JSON.stringify(exported.value));
const restoredDir = path.join(root, 'restored');
const restored = device(aliceId, restoredDir);
record('Importar identidade com histórico', time(() => restored.service.importData(backup)).ms);
const restoredCount = restored.service.getConversation(bobId.publicKey, null, 500).messages.length;

console.log(`DM history benchmark: ${total} messages, legacy file ${(legacyBytes / 1024 / 1024).toFixed(1)} MB, ${dist}`);
for (const { label, ms } of results) console.log(`  ${label.padEnd(48)} ${String(ms).padStart(10)}`);
if (restoredCount === 0) {
  console.error('The restored identity has no history.');
  process.exitCode = 1;
}
