import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FAVORITES_STORAGE_KEY, FavoritesStore, favoritesStore, savedServerFavoriteKey, soundFavoriteKey,
} from '../src/renderer/stores/favoritesStore';
import { ConnectionStore, connectionStore, type SavedServer } from '../src/renderer/stores/connectionStore';
import { applyBackup } from '../src/renderer/utils/backup';
import { sortFavoritesFirst } from '../src/renderer/utils/favoriteOrder';
import { favoriteMotionOffset } from '../src/renderer/utils/favoriteMotion';
import { matchesSearch } from '../src/renderer/utils/search';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
  };
}

function withStorage(run: (storage: Storage) => void): void {
  const storage = memoryStorage();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
  favoritesStore.load();
  try {
    run(storage);
  } finally {
    if (original) Object.defineProperty(globalThis, 'localStorage', original);
    else Reflect.deleteProperty(globalThis, 'localStorage');
    favoritesStore.load();
    connectionStore.loadSavedServers();
    connectionStore.loadCreatedServers();
    connectionStore.loadRailLayout();
  }
}

function saved(host: string, lastConnected = 1, port = 3000): SavedServer {
  return { host, port, name: host, lastConnected };
}

test('sound favorites persist by full path, not filename, and survive folder changes', () => {
  const storage = memoryStorage();
  const store = new FavoritesStore(storage);
  store.toggleSound('C:\\Sounds\\One\\Hello.mp3');
  assert.equal(store.isSoundFavorite('c:/sounds/one/HELLO.mp3'), true);
  assert.equal(store.isSoundFavorite('C:\\Sounds\\Two\\Hello.mp3'), false);
  store.toggleSound('C:\\Sounds\\Two\\Hello.mp3');
  const reloaded = new FavoritesStore(storage);
  assert.equal(reloaded.isSoundFavorite('C:\\Sounds\\One\\Hello.mp3'), true);
  assert.equal(reloaded.isSoundFavorite('C:\\Sounds\\Two\\Hello.mp3'), true);
  reloaded.toggleSound('C:\\Sounds\\Two\\Hello.mp3');
  assert.equal(new FavoritesStore(storage).isSoundFavorite('C:\\Sounds\\Two\\Hello.mp3'), false);
  assert.equal(new FavoritesStore(storage).isSoundFavorite('C:\\Sounds\\One\\Hello.mp3'), true);
});

test('path and address identities normalize only meaningful platform differences', () => {
  assert.equal(soundFavoriteKey('\\\\HOST\\Share\\SOUND.wav'), '\\\\host\\share\\sound.wav');
  assert.notEqual(soundFavoriteKey('/sounds/One.wav'), soundFavoriteKey('/sounds/one.wav'));
  assert.equal(savedServerFavoriteKey(saved(' WSS://Example.TEST ')), savedServerFavoriteKey(saved('example.test')));
  assert.equal(savedServerFavoriteKey(saved('[::1]')), savedServerFavoriteKey(saved('::1')));
  assert.notEqual(savedServerFavoriteKey(saved('example.test', 1, 3000)), savedServerFavoriteKey(saved('example.test', 1, 3001)));
});

test('favorites validate storage, tolerate legacy/malformed data and do not touch unrelated preferences', () => {
  const storage = memoryStorage();
  storage.setItem('monky_settings', '{"soundboardShortcuts":{"Hello":{"accelerator":"Q"}}}');
  for (const raw of ['{bad', 'null', '[]', '{"version":9,"sounds":["sound"]}']) {
    storage.setItem(FAVORITES_STORAGE_KEY, raw);
    assert.equal(new FavoritesStore(storage).isSoundFavorite('sound'), false);
  }
  storage.setItem(FAVORITES_STORAGE_KEY, JSON.stringify({
    version: 1, sounds: ['C:\\Sounds\\Hello.mp3', null, 7, {}, ''], servers: null,
  }));
  const store = new FavoritesStore(storage);
  assert.equal(store.isSoundFavorite('c:\\sounds\\hello.mp3'), true);
  store.toggleServer(saved('example.test'));
  assert.equal(storage.getItem('monky_settings'), '{"soundboardShortcuts":{"Hello":{"accelerator":"Q"}}}');
  assert.equal(new FavoritesStore(storage).isServerFavorite(saved('EXAMPLE.TEST')), true);
});

test('failed writes leave the displayed state unchanged and do not notify subscribers', () => {
  const store = new FavoritesStore({
    getItem: () => null,
    setItem: () => { throw new Error('Storage full'); },
  });
  let changes = 0;
  const off = store.subscribe(() => { changes++; });
  assert.throws(() => store.toggleSound('sound.wav'), /Storage full/);
  assert.throws(() => store.toggleServer(saved('example.test')), /Storage full/);
  assert.equal(store.isSoundFavorite('sound.wav'), false);
  assert.equal(store.isServerFavorite(saved('example.test')), false);
  assert.equal(changes, 0);
  off();
});

test('favorite subscriptions are scoped and removable when the soundboard closes', () => {
  const store = new FavoritesStore(memoryStorage());
  const changes: string[] = [];
  const off = store.subscribe(kind => changes.push(kind));
  store.toggleSound('sound.wav');
  store.toggleServer(saved('example.test'));
  off();
  store.toggleSound('sound.wav');
  assert.deepEqual(changes, ['sounds', 'servers']);
});

test('saved server metadata and address edits preserve favorites without rewriting stored recency order', () => {
  withStorage(() => {
    const store = new ConnectionStore();
    store.addSavedServer(saved('first.test', 30));
    store.addSavedServer(saved('second.test', 20));
    store.addSavedServer(saved('third.test', 10));
    favoritesStore.toggleServer(saved('second.test'));
    assert.deepEqual(store.savedServers.map(server => server.host), ['first.test', 'second.test', 'third.test']);
    store.updateSavedServerMeta('second.test', 3000, { name: 'Renamed', iconUrl: '/new-icon.png' });
    assert.equal(favoritesStore.isServerFavorite(saved('second.test')), true);
    store.updateSavedServer('second.test', 3000, {
      ...saved('edited.test', 20, 4000), name: 'Renamed', password: 'test-only',
    });
    assert.equal(favoritesStore.isServerFavorite(saved('second.test')), false);
    assert.equal(favoritesStore.isServerFavorite(saved('edited.test', 20, 4000)), true);
    assert.deepEqual(store.savedServers.map(server => server.host), ['first.test', 'edited.test', 'third.test']);
    favoritesStore.load();
    assert.equal(new ConnectionStore().savedServers[1].host, 'edited.test');
    assert.equal(favoritesStore.isServerFavorite(saved('edited.test', 20, 4000)), true);
  });
});

test('favorite ordering groups favorites first and alphabetizes both groups in the active locale', () => {
  const items = Object.freeze([
    { favorite: false, name: 'Zulu', identity: 'plain-z' },
    { favorite: true, name: 'zebra', identity: 'favorite-z' },
    { favorite: false, name: '\u00c1lpha', identity: 'plain-a2' },
    { favorite: true, name: 'Beta', identity: 'favorite-b' },
    { favorite: false, name: 'alpha', identity: 'plain-a1' },
    { favorite: false, name: 'beta', identity: 'plain-b' },
  ].map(item => Object.freeze(item)));
  const original = items.map(item => item.identity);
  for (const locale of ['pt-BR', 'en']) {
    const ordered = sortFavoritesFirst(items, item => item, locale);
    assert.deepEqual(ordered.map(item => item.identity), [
      'favorite-b', 'favorite-z', 'plain-a1', 'plain-a2', 'plain-b', 'plain-z',
    ]);
    assert.notEqual(ordered, items);
    assert.equal(ordered[0], items[3], 'retain the original item and its shortcut/playback identity');
    assert.deepEqual(items.map(item => item.identity), original, 'never sort the source array in place');
  }
});

test('equal names use stable identities, with input order preserved only for exact identity ties', () => {
  const first = { favorite: false, name: 'Echo', identity: 'path-b', label: 'first' };
  const second = { favorite: false, name: 'Echo', identity: 'path-b', label: 'second' };
  const earlier = { favorite: false, name: 'Echo', identity: 'path-a', label: 'earlier' };
  assert.deepEqual(sortFavoritesFirst([first, earlier, second], item => item, 'pt-BR'), [earlier, first, second]);
  assert.deepEqual(sortFavoritesFirst([first, earlier], item => item, 'en'), [earlier, first]);
  assert.deepEqual(sortFavoritesFirst([earlier, first], item => item, 'en'), [earlier, first]);
});

test('favorite motion translates whole items from their current visual position without mutating geometry', () => {
  const before = Object.freeze({ left: 170, top: 230 });
  const after = Object.freeze({ left: 20, top: 50 });
  assert.deepEqual(favoriteMotionOffset(before, after), { x: 150, y: 180 });
  assert.deepEqual(favoriteMotionOffset(after, before), { x: -150, y: -180 });
  assert.deepEqual(before, { left: 170, top: 230 });
  assert.deepEqual(after, { left: 20, top: 50 });
});

test('favorite motion clamps the focused control inside the visible scroll viewport in both axes', () => {
  const focus = {
    rect: { left: 40, top: 50, right: 60, bottom: 70 },
    clip: { left: 10, top: 20, right: 120, bottom: 130 },
  };
  assert.deepEqual(favoriteMotionOffset({ left: 500, top: 500 }, { left: 0, top: 0 }, focus), { x: 60, y: 60 });
  assert.deepEqual(favoriteMotionOffset({ left: -500, top: -500 }, { left: 0, top: 0 }, focus), { x: -30, y: -30 });
  assert.deepEqual(favoriteMotionOffset({ left: 5, top: 10 }, { left: 0, top: 0 }, focus), { x: 5, y: 10 });
});

test('sound ordering updates on favorite changes and composes with search without merging equal basenames', () => {
  const store = new FavoritesStore(memoryStorage());
  const echoB = { name: 'Echo', filePath: 'C:\\Sounds\\B\\Echo.mp3' };
  const zulu = { name: 'Zulu', filePath: 'C:\\Sounds\\Zulu.mp3' };
  const alpha = { name: 'Alpha', filePath: 'C:\\Sounds\\Alpha.mp3' };
  const echoA = { name: 'Echo', filePath: 'C:\\Sounds\\A\\Echo.mp3' };
  const beta = { name: 'Beta', filePath: 'C:\\Sounds\\Beta.mp3' };
  const sounds = [echoB, zulu, alpha, echoA, beta];
  const original = sounds.map(sound => sound.filePath);
  const order = (query = '', favoritesOnly = false) => sortFavoritesFirst(
    sounds.filter(sound => matchesSearch(sound.name, query) && (!favoritesOnly || store.isSoundFavorite(sound.filePath))),
    sound => ({
      favorite: store.isSoundFavorite(sound.filePath), name: sound.name, identity: soundFavoriteKey(sound.filePath),
    }),
    'pt-BR'
  );
  assert.deepEqual(order(), [alpha, beta, echoA, echoB, zulu]);
  store.toggleSound(zulu.filePath);
  assert.deepEqual(order(), [zulu, alpha, beta, echoA, echoB]);
  store.toggleSound(echoB.filePath);
  assert.deepEqual(order(), [echoB, zulu, alpha, beta, echoA]);
  assert.equal(store.isSoundFavorite(echoA.filePath), false);
  assert.deepEqual(order('ECHO'), [echoB, echoA]);
  assert.deepEqual(order('', true), [echoB, zulu]);
  store.toggleSound(echoB.filePath);
  assert.deepEqual(order(), [zulu, alpha, beta, echoA, echoB]);
  assert.deepEqual(order('echo'), [echoA, echoB]);
  assert.deepEqual(order('missing', true), []);
  assert.deepEqual(sounds.map(sound => sound.filePath), original);
});

test('saved-server ordering breaks equal-name ties by address without changing saved or rail order', () => {
  withStorage(() => {
    const store = new ConnectionStore();
    const laterPort = { ...saved('same.test', 50, 4000), name: 'Echo' };
    const zulu = { ...saved('z.test', 40), name: 'Zulu' };
    const alpha = { ...saved('a.test', 30), name: 'Alpha' };
    const earlierPort = { ...saved('same.test', 20, 3000), name: 'Echo' };
    const beta = { ...saved('b.test', 10), name: 'Beta' };
    for (const server of [laterPort, zulu, alpha, earlierPort, beta]) store.addSavedServer(server);
    const savedBefore = JSON.stringify(store.savedServers);
    const railBefore = JSON.stringify(store.railLayout);
    const order = () => sortFavoritesFirst(store.savedServers, server => ({
      favorite: favoritesStore.isServerFavorite(server), name: server.name, identity: savedServerFavoriteKey(server),
    }), 'en');
    assert.deepEqual(order(), [alpha, beta, earlierPort, laterPort, zulu]);
    favoritesStore.toggleServer(zulu);
    favoritesStore.toggleServer(laterPort);
    assert.deepEqual(order(), [laterPort, zulu, alpha, beta, earlierPort]);
    assert.equal(favoritesStore.isServerFavorite(earlierPort), false);
    favoritesStore.toggleServer(alpha);
    assert.deepEqual(order(), [alpha, laterPort, zulu, beta, earlierPort]);
    favoritesStore.toggleServer(laterPort);
    assert.deepEqual(order(), [alpha, zulu, beta, earlierPort, laterPort]);
    assert.equal(JSON.stringify(store.savedServers), savedBefore);
    assert.equal(JSON.stringify(store.railLayout), railBefore);
  });
});

test('deleted and capped saved servers lose their favorite while remaining favorites survive', () => {
  withStorage(() => {
    const store = new ConnectionStore();
    store.addSavedServer(saved('old.test', 1));
    favoritesStore.toggleServer(saved('old.test'));
    for (let index = 0; index < 15; index++) store.addSavedServer(saved(`new-${index}.test`, index + 2));
    assert.equal(store.savedServers.length, 15);
    assert.equal(favoritesStore.isServerFavorite(saved('old.test')), false);
    favoritesStore.toggleServer(saved('new-14.test'));
    favoritesStore.toggleServer(saved('new-13.test'));
    store.removeSavedServer('new-14.test', 3000);
    assert.equal(favoritesStore.isServerFavorite(saved('new-14.test')), false);
    assert.equal(favoritesStore.isServerFavorite(saved('new-13.test')), true);
    store.addSavedServer(saved('new-14.test', 100));
    assert.equal(favoritesStore.isServerFavorite(saved('new-14.test')), false);
  });
});

test('server import retains favorites for matching addresses, prunes removed entries and leaves sounds intact', () => {
  withStorage(() => {
    connectionStore.addSavedServer(saved('keep.test', 30));
    connectionStore.addSavedServer(saved('removed.test', 20));
    favoritesStore.toggleServer(saved('keep.test'));
    favoritesStore.toggleServer(saved('removed.test'));
    favoritesStore.toggleSound('C:\\Sounds\\Hello.wav');
    assert.deepEqual(applyBackup({
      kind: 'monky-backup', version: 1, createdAt: 1,
      servers: {
        saved: [{ ...saved('keep.test', 1), name: 'Imported name' }, saved('new.test', 2)],
        created: [], railLayout: [],
      },
    }, ['servers']), ['servers']);
    assert.equal(favoritesStore.isServerFavorite(saved('keep.test')), true);
    assert.equal(favoritesStore.isServerFavorite(saved('removed.test')), false);
    assert.equal(favoritesStore.isServerFavorite(saved('new.test')), false);
    assert.equal(favoritesStore.isSoundFavorite('C:\\Sounds\\Hello.wav'), true);
    assert.deepEqual(connectionStore.savedServers.map(server => server.host), ['new.test', 'keep.test']);
  });
});
