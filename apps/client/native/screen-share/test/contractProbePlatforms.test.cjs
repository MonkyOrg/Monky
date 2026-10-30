'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { MAC_CONTRACT_GROUPS } = require('../scripts/buildMacRtc.cjs');

const rtc = path.join(__dirname, '..', 'src', 'rtc');

/** Probe groups and includes, split by whether they sit in a Windows-only preprocessor block. */
function probeRegions() {
  const regions = { portable: { groups: ['signalingAndResources'], includes: [] }, windows: { groups: [], includes: [] } };
  let windows = false;
  for (const line of fs.readFileSync(path.join(rtc, 'inputs', 'engine', 'contract_probe.cc'), 'utf8').split(/\r?\n/u)) {
    if (/^#\s*if\b/u.test(line)) assert.equal(windows, false, 'Windows-only blocks are not nested');
    if (/^#\s*if defined\(_WIN32\)\s*$/u.test(line)) windows = true;
    else if (/^#\s*endif\b/u.test(line)) windows = false;
    const region = regions[windows ? 'windows' : 'portable'];
    const group = /\bgroup\("(\w+)"/u.exec(line)?.[1];
    if (group) region.groups.push(group);
    const include = /^#\s*include "([^"]+)"/u.exec(line)?.[1];
    if (include) region.includes.push(include);
  }
  return regions;
}

test('macOS runs every device-free engine contract group outside the Windows-only blocks', () => {
  const { portable, windows } = probeRegions();
  assert.deepEqual(MAC_CONTRACT_GROUPS, portable.groups);
  assert.ok(windows.groups.includes('adapterPolicies') && windows.groups.includes('decoderMapping'));
  assert.ok(portable.groups.includes('captureClock') && portable.groups.includes('externalH264')
    && portable.groups.includes('softwareAV1') && portable.groups.includes('audioFoundations'));
});

test('Media Foundation checks and sources stay out of the macOS contract probe', () => {
  const { portable, windows } = probeRegions();
  const mediaFoundation = name => /^mf_rtc_|^decoder_diagnostics_checks\.h$|^adapter_policy_probe\.h$/u.test(name);
  assert.deepEqual(portable.includes.filter(mediaFoundation), []);
  assert.equal(windows.includes.length, windows.includes.filter(mediaFoundation).length);
  const target = /rtc_executable\("monky_rtc_engine_contract_probe"\) \{([\s\S]*?)\n\}/u
    .exec(fs.readFileSync(path.join(rtc, 'BUILD.gn'), 'utf8'))?.[1] ?? '';
  const windowsSources = /if \(is_win\) \{\s*sources \+= \[([^\]]*)\]\s*\}/u.exec(target)?.[1] ?? '';
  assert.deepEqual([...windowsSources.matchAll(/"([^"]+)"/gu)].map(match => match[1]),
    ['inputs/abi/adapter_policy_probe.cc', 'inputs/adapters/mf_rtc_decoder_checks.cc']);
  assert.match(target, /if \(is_win\) \{\s*ldflags = \[\s*"\/DELAYLOAD:mfplat\.dll",\s*"\/threads:4",\s*\]\s*\} else \{[\s\S]*?@executable_path/u);
});
