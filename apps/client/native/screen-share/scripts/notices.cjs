'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { root, write, fingerprint, regularFiles } = require('./buildTools.cjs');
const { cache } = require('./fetchObs.cjs');
const { copyMonkyLicenses } = require('../../../../../scripts/legal.cjs');

function generateNotices() {
  const sources = JSON.parse(fs.readFileSync(path.join(cache, 'obs-sources.json'), 'utf8'));
  assert.equal(sources.schemaVersion, 1);
  const directory = path.join(root, 'licenses');
  const webrtc = path.join(cache, 'rtc', 'webrtc', 'src');
  const copy = (from, to) => write(path.join(directory, to), fs.readFileSync(from));
  assert.ok(fs.statSync(path.join(directory, 'webrtc', 'LICENSE.md')).size > 10_000,
    'Generate the compiled WebRTC target licenses before packaging.');
  for (const name of ['AUTHORS', 'PATENTS'])
    copy(path.join(webrtc, name), path.join('webrtc', name));
  for (const name of ['libmediasoupclient', 'libsdptransform'])
    copy(path.join(root, 'src', 'rtc', 'inputs', name, 'LICENSE'), path.join(name, 'LICENSE'));
  for (const name of ['COPYING', 'AUTHORS'])
    copy(path.join(cache, 'obs-studio', name), path.join('obs-studio', name));
  for (const relative of [
    'deps/w32-pthreads/COPYING', 'deps/w32-pthreads/COPYING.LIB',
    'deps/blake2/LICENSE.blake2', 'deps/json11/LICENSE.txt',
    'libobs/graphics/libnsgif/LICENSE.libnsgif',
  ]) copy(path.join(cache, 'obs-studio', ...relative.split('/')), path.join('obs-studio', ...relative.split('/')));
  for (const source of sources.sources) {
    const upstream = path.join(cache, 'obs-deps', 'licenses', source.name);
    assert.ok(fs.statSync(upstream).isDirectory(), `Missing dependency notices: ${source.name}`);
    for (const relative of regularFiles(upstream))
      copy(path.join(upstream, relative), path.join('obs-deps', source.name, relative));
  }
  for (const name of ['COPYING.GPLv3', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3', 'LICENSE.md'])
    copy(path.join(cache, 'obs-sources', 'FFmpeg', name), path.join('obs-deps', 'FFmpeg', name));
  copy(path.join(root, 'src', 'rtc', 'inputs', 'libsdptransform', 'include', 'json.hpp'),
    path.join('nlohmann-json', 'json.hpp'));
  copyMonkyLicenses(root);
  const record = {
    schemaVersion: 1,
    license: 'GPL-3.0-or-later',
    webrtcRevision: require('./native-rtc/pins.json').repositories.webrtc.commit,
    obsRevision: sources.obsRevision,
    recipesRevision: sources.recipesRevision,
    correspondingSources: sources.sources,
    files: regularFiles(directory).filter(relative => relative !== 'catalog.json')
      .map(relative => ({ path: path.join('licenses', relative), ...fingerprint(path.join(directory, relative)) })),
  };
  write(path.join(directory, 'catalog.json'), JSON.stringify(record, null, 2) + '\n');
  write(path.join(root, 'THIRD_PARTY_NOTICES'), [
    'Monky native screen sharing - third-party notices',
    '',
    'Monky is free software under GNU GPL version 3 or, at your option, any later version.',
    'See LICENSE. The historical Monky MIT notice is preserved in LICENSE-MIT.',
    'Third-party copyrights and licenses are not replaced by the Monky license.',
    '',
    'OBS Studio 32.1.1 (GPL-2.0-or-later), its Windows capture module and runtime are included.',
    'The capture module has Monky changes for source-bound WGC window/monitor capture and explicit Game Capture.',
    'Pinned graphics hooks, injection/offset helpers and AMF/NVENC probes are distributed in the private runtime.',
    'Game hooks require explicit game selection and local-preview or viewer demand.',
    'Compatibility updater workers and automatic compatibility downloads are disabled.',
    'The distributed FFmpeg 7.1.1 build is GPL version 3 or later; its static dependencies',
    'and original build recipes are included in the corresponding-source material.',
    'WebRTC M140, patched libmediasoupclient and libsdptransform retain their upstream notices.',
    'The WebRTC notices are generated from the dependencies of the actual compiled GN target.',
    'Monky changes to the pinned SDK are maintained in src/rtc/inputs/sdk; the upstream source is unchanged.',
    '',
    'Complete third-party legal texts, authors and patent notices are in licenses/.',
    'licenses/catalog.json records the exact source revisions and hashes of these legal files.',
    'Microsoft Visual C++ runtime DLLs are app-local release redistributables, not Monky GPL code.',
    'They retain Microsoft copyright and Visual Studio redistributable-code terms.',
    'https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution',
    'H.264 patent rights are separate from these software copyright licenses.',
    '',
    'Corresponding Source: the Monky source for the same release tag, together with the',
    'Monky-native-sources archive attached to that release. It contains the pinned SDK',
    'sources, OBS dependency sources and original build recipes/patches.',
    'https://github.com/MonkyOrg/Monky/releases',
    'See README.md for build, source archive and platform instructions.',
    '',
  ].join('\n'));
  console.log(JSON.stringify({ nativeNoticesReady: true, licenseFiles: record.files.length }));
  return record;
}

module.exports = { generateNotices };
if (require.main === module) generateNotices();
