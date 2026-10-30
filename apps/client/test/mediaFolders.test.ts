import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MediaFolderAccess } from '../src/main/mediaFolders';

function workspace(t: { after: (fn: () => void) => void }): { root: string; record: string; folder: (...parts: string[]) => string } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'monky-media-folders-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = (...parts: string[]): string => {
    const target = path.join(root, ...parts);
    fs.mkdirSync(target, { recursive: true });
    return target;
  };
  return { root, record: path.join(root, 'profile', 'media-folders.json'), folder };
}

test('reads need a natively confirmed folder; configured folders are adopted once per profile', async (t) => {
  const { record, folder } = workspace(t);
  folder('profile');
  const sounds = folder('Sons');
  const stickers = folder('Figurinhas');
  const pictures = folder('Pictures');
  fs.writeFileSync(path.join(pictures, 'private.png'), 'secret');
  fs.writeFileSync(path.join(sounds, 'ding.mp3'), 'audio');
  const access = new MediaFolderAccess(record);

  assert.deepEqual(await access.checkFolder('soundboard', sounds), { status: 'unconfirmed', folder: sounds });
  assert.equal(await access.resolveFile('stickers', path.join(pictures, 'private.png')), null);

  // The first report of the profile keeps what the user had configured...
  assert.equal(await access.adoptConfigured({ soundboard: sounds, stickers }), true);
  assert.deepEqual(await access.checkFolder('soundboard', sounds), { status: 'allowed', folder: sounds });
  assert.deepEqual(await access.checkFolder('stickers', stickers), { status: 'allowed', folder: stickers });
  assert.equal(await access.resolveFile('soundboard', path.join(sounds, 'ding.mp3')), path.join(sounds, 'ding.mp3'));
  // ...each folder only for its own purpose...
  assert.deepEqual(await access.checkFolder('stickers', sounds), { status: 'unconfirmed', folder: sounds });
  // ...and a later report, which page scripts could have influenced, adopts nothing.
  assert.equal(await access.adoptConfigured({ stickers: pictures }), false);
  assert.deepEqual(await access.checkFolder('stickers', pictures), { status: 'unconfirmed', folder: pictures });

  const reopened = new MediaFolderAccess(record);
  assert.deepEqual(await reopened.checkFolder('soundboard', sounds), { status: 'allowed', folder: sounds });
  assert.equal(await reopened.adoptConfigured({ stickers: pictures }), false, 'Adoption survives a restart');
  assert.deepEqual(await reopened.checkFolder('stickers', pictures), { status: 'unconfirmed', folder: pictures });
  const saved = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.adopted, true);
  assert.deepEqual(fs.readdirSync(path.dirname(record)), ['media-folders.json'], 'No staging file is left behind');
});

test('a fresh profile closes adoption even without configured folders', async (t) => {
  const { record, folder } = workspace(t);
  folder('profile');
  const pictures = folder('Pictures');
  const access = new MediaFolderAccess(record);
  assert.equal(await access.adoptConfigured({}), true);
  assert.equal(await access.adoptConfigured({ soundboard: pictures }), false);
  assert.deepEqual(await access.checkFolder('soundboard', pictures), { status: 'unconfirmed', folder: pictures });
});

test('a folder restored after the adoption closed is confirmed natively, never in the background', async (t) => {
  const { root, record, folder } = workspace(t);
  folder('profile');
  // A fresh profile: the first document had no settings, so the adoption closed empty.
  const access = new MediaFolderAccess(record);
  assert.equal(await access.adoptConfigured({}), true);
  // Restoring a backup, or importing an identity with settings, then points the settings at real folders.
  const sounds = folder('Sons do backup');
  fs.writeFileSync(path.join(sounds, 'ding.wav'), 'audio');
  const asked: string[] = [];
  let accept = false;
  const confirm = async (target: string): Promise<boolean> => { asked.push(target); return accept; };

  assert.deepEqual(await access.requestFolder('soundboard', sounds), { status: 'unconfirmed', folder: sounds },
    'Loading in the background never raises a dialog');
  assert.deepEqual(asked, []);
  assert.deepEqual(await access.requestFolder('soundboard', sounds, confirm), { status: 'unconfirmed', folder: sounds });
  assert.equal(await access.resolveFile('soundboard', path.join(sounds, 'ding.wav')), null, '"Not now" keeps it blocked');
  accept = true;
  assert.deepEqual(await access.requestFolder('soundboard', sounds, confirm), { status: 'allowed', folder: sounds },
    'A declined folder is asked again on the next click, so Retry recovers');
  assert.deepEqual(asked, [sounds, sounds]);
  assert.equal(await access.resolveFile('soundboard', path.join(sounds, 'ding.wav')), path.join(sounds, 'ding.wav'));
  assert.deepEqual(await new MediaFolderAccess(record).checkFolder('soundboard', sounds), { status: 'allowed', folder: sounds },
    'The confirmation is remembered like a folder chosen in the dialog');

  assert.deepEqual(await access.requestFolder('soundboard', sounds, confirm), { status: 'allowed', folder: sounds });
  assert.deepEqual(await access.requestFolder('stickers', path.join(root, 'De outra máquina'), confirm), { status: 'missing' },
    'A folder that does not exist here lists nothing, as before D4');
  fs.writeFileSync(path.join(root, 'arquivo.png'), 'x');
  assert.deepEqual(await access.requestFolder('stickers', path.join(root, 'arquivo.png'), confirm), { status: 'missing' },
    'A file is never offered as a folder');
  assert.deepEqual(asked, [sounds, sounds], 'Confirmed or absent folders never ask');
});

test('one confirmation at a time: the same folder shares it, nothing is stacked on it', async (t) => {
  const { record, folder } = workspace(t);
  folder('profile');
  const first = folder('Primeira');
  const second = folder('Segunda');
  const access = new MediaFolderAccess(record);
  const asked: string[] = [];
  let answer: (value: boolean) => void = () => undefined;
  const confirm = (target: string): Promise<boolean> => {
    asked.push(target);
    return new Promise(resolve => { answer = resolve; });
  };
  const clicked = access.requestFolder('stickers', first, confirm);
  const clickedAgain = access.requestFolder('stickers', first, confirm);
  for (let attempt = 0; attempt < 200 && asked.length === 0; attempt++) await new Promise(resolve => setTimeout(resolve, 5));
  const background = access.requestFolder('stickers', first);
  assert.deepEqual(await access.requestFolder('stickers', second, confirm), { status: 'unconfirmed', folder: second });
  assert.deepEqual(await access.requestFolder('soundboard', first, confirm), { status: 'unconfirmed', folder: first });
  assert.deepEqual(asked, [first], 'Only one native dialog is ever on screen');
  answer(true);
  for (const request of [clicked, clickedAgain, background]) {
    assert.deepEqual(await request, { status: 'allowed', folder: first });
  }
  assert.deepEqual(await access.checkFolder('soundboard', first), { status: 'unconfirmed', folder: first },
    'Confirming stickers does not confirm sounds');
  assert.deepEqual(await access.requestFolder('stickers', second, async () => true), { status: 'allowed', folder: second },
    'Once answered, another folder may be asked');
});

test('a failing confirmation leaves the folder blocked and the next one can still ask', async (t) => {
  const { record, folder } = workspace(t);
  folder('profile');
  const sounds = folder('Sons');
  const access = new MediaFolderAccess(record);
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args); });
  assert.deepEqual(await access.requestFolder('soundboard', sounds, async () => { throw new Error('Dialog failed'); }),
    { status: 'unconfirmed', folder: sounds });
  assert.equal(warnings.length, 1);
  assert.deepEqual(await access.requestFolder('soundboard', sounds, async () => true), { status: 'allowed', folder: sounds });
});

test('volumes where the native realpath fails (RAM disks, WinFsp) stay usable instead of looking empty', async (t) => {
  const { record, folder } = workspace(t);
  folder('profile');
  const volume = folder('Volume virtual');
  const stickers = folder('Volume virtual', 'Figurinhas');
  const sounds = folder('Volume virtual', 'Sons');
  const secrets = folder('Segredos');
  fs.writeFileSync(path.join(stickers, 'ok.png'), 'png');
  fs.writeFileSync(path.join(secrets, 'private.mp3'), 'secret');
  fs.symlinkSync(secrets, path.join(sounds, 'atalho'), 'junction');
  const onVolume = (target: string): boolean => {
    const relative = path.relative(volume, target);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };
  let failures = 0;
  // GetFinalPathNameByHandleW cannot answer there, although listing and reading work.
  const nativeRealpath = async (target: string): Promise<string> => {
    if (!onVolume(target)) return fs.promises.realpath(target);
    failures++;
    throw Object.assign(new Error(`EISDIR: illegal operation on a directory, realpath '${target}'`), { code: 'EISDIR' });
  };
  const access = new MediaFolderAccess(record, nativeRealpath);
  assert.equal(await access.adoptConfigured({ stickers }), true);
  assert.deepEqual(await access.checkFolder('stickers', stickers), { status: 'allowed', folder: stickers },
    'An adopted folder lists its stickers instead of being reported missing');
  assert.equal(await access.resolveFile('stickers', path.join(stickers, 'ok.png')), path.join(stickers, 'ok.png'));
  assert.equal(await access.allow('soundboard', sounds), sounds, 'Choosing it in the folder dialog works too');
  assert.equal(await access.resolveFile('soundboard', path.join(sounds, 'atalho', 'private.mp3')), null,
    'Links are still followed, so one leading out of the folder is refused');
  assert.deepEqual(await access.checkFolder('soundboard', path.join(volume, 'Ausente')), { status: 'missing' });
  assert.ok(failures > 0, 'The fixture exercised the failing native realpath');
});

test('reads wait for an adoption that was requested first', async (t) => {
  const { record, folder } = workspace(t);
  folder('profile');
  const sounds = folder('Sons');
  const access = new MediaFolderAccess(record);
  const adoption = access.adoptConfigured({ soundboard: sounds });
  const check = access.checkFolder('soundboard', sounds);
  assert.deepEqual(await check, { status: 'allowed', folder: sounds });
  assert.equal(await adoption, true);
});

test('dialog confirmations are canonical, bounded and only reach direct children', async (t) => {
  const { root, record, folder } = workspace(t);
  folder('profile');
  const chosen = folder('Escolhida');
  const nested = folder('Escolhida', 'Sub');
  fs.writeFileSync(path.join(chosen, 'a.png'), 'a');
  fs.writeFileSync(path.join(nested, 'b.png'), 'b');
  fs.writeFileSync(path.join(root, 'outside.png'), 'x');
  const access = new MediaFolderAccess(record);
  assert.equal(await access.allow('stickers', chosen), chosen);
  assert.equal(await access.resolveFile('stickers', path.join(chosen, 'a.png')), path.join(chosen, 'a.png'));
  assert.equal(await access.resolveFile('stickers', path.join(nested, 'b.png')), null, 'Subfolders are not listed, so not read');
  assert.equal(await access.resolveFile('stickers', path.join(chosen, '..', 'outside.png')), null);
  assert.equal(await access.resolveFile('stickers', path.join(chosen, 'missing.png')), null);
  for (const invalid of ['relative/a.png', `${chosen}\u0000.png`, 42, null, '']) {
    assert.equal(await access.resolveFile('stickers', invalid), null);
    assert.deepEqual(await access.checkFolder('stickers', invalid), { status: 'denied' });
  }
  await assert.rejects(access.allow('stickers', path.join(root, 'nowhere')));
  await assert.rejects(access.allow('stickers', path.join(chosen, 'a.png')), /directory/);
  if (process.platform === 'win32') {
    const differentCase = chosen.toUpperCase();
    assert.deepEqual(await access.checkFolder('stickers', differentCase), { status: 'allowed', folder: chosen });
    assert.equal(await access.resolveFile('stickers', path.join(differentCase, 'A.PNG')), path.join(chosen, 'a.png'));
  }
  const others = Array.from({ length: 20 }, (_, index) => folder(`Outra${index}`));
  for (const other of others) await access.allow('stickers', other);
  const saved = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.ok(saved.stickers.length <= 16, 'The record never grows without bound');
  assert.deepEqual(await access.checkFolder('stickers', others.at(-1)), { status: 'allowed', folder: others.at(-1) });
  assert.deepEqual(await access.checkFolder('stickers', chosen), { status: 'unconfirmed', folder: chosen },
    'The oldest confirmation is dropped');
});

test('links that lead out of an allowed folder are refused', async (t) => {
  const { root, record, folder } = workspace(t);
  folder('profile');
  const chosen = folder('Sons');
  const secrets = folder('Segredos');
  fs.writeFileSync(path.join(secrets, 'private.mp3'), 'secret');
  fs.symlinkSync(secrets, path.join(chosen, 'atalho'), 'junction');
  const access = new MediaFolderAccess(record);
  await access.allow('soundboard', chosen);
  assert.deepEqual(await access.checkFolder('soundboard', path.join(chosen, 'atalho')), { status: 'unconfirmed', folder: secrets },
    'A link to another folder is that folder, which this profile never confirmed');
  assert.equal(await access.resolveFile('soundboard', path.join(chosen, 'atalho', 'private.mp3')), null);
  try {
    fs.symlinkSync(path.join(secrets, 'private.mp3'), path.join(chosen, 'link.mp3'), 'file');
  } catch (error) {
    // Windows only creates file symlinks with Developer Mode or elevation.
    if (process.platform === 'win32') { t.diagnostic(`file symlink skipped: ${String(error)}`); return; }
    throw error;
  }
  assert.equal(await access.resolveFile('soundboard', path.join(chosen, 'link.mp3')), null);
  assert.ok(fs.existsSync(path.join(root, 'Segredos', 'private.mp3')));
});

test('a configured folder that is missing during adoption works once it is back', async (t) => {
  const { root, record, folder } = workspace(t);
  folder('profile');
  const later = path.join(root, 'Unidade', 'Sons');
  const access = new MediaFolderAccess(record);
  assert.equal(await access.adoptConfigured({ soundboard: later }), true);
  assert.deepEqual(await access.checkFolder('soundboard', later), { status: 'missing' });
  assert.deepEqual(await access.checkFolder('soundboard', path.join(root, 'Outra')), { status: 'missing' },
    'Nothing on disk lists nothing, whether or not it was confirmed');
  folder('Unidade', 'Sons');
  fs.writeFileSync(path.join(later, 'ding.wav'), 'audio');
  assert.deepEqual(await access.checkFolder('soundboard', later), { status: 'allowed', folder: later });
  assert.equal(await access.resolveFile('soundboard', path.join(later, 'ding.wav')), path.join(later, 'ding.wav'));
});

test('an unreadable record lets the preload adopt again instead of losing every folder', async (t) => {
  const { record, folder } = workspace(t);
  folder('profile');
  const sounds = folder('Sons');
  fs.writeFileSync(record, '{not json');
  const access = new MediaFolderAccess(record);
  assert.equal(await access.adoptConfigured({ soundboard: sounds }), true);
  assert.deepEqual(await access.checkFolder('soundboard', sounds), { status: 'allowed', folder: sounds });
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).adopted, true);
});
