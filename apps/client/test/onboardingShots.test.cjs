const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { renderShotSizes, target } = require('../scripts/onboarding-shot-sizes.cjs');

const renderer = path.join(__dirname, '..', 'src', 'renderer');
const shotsDir = path.join(renderer, 'assets', 'onboarding');

test('onboarding picture sizes match the PNG files', () => {
  assert.equal(fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n'), renderShotSizes(),
    'run node scripts/onboarding-shot-sizes.cjs after changing the onboarding pictures');
});

test('every picture the guide and tutorials show exists in both languages', () => {
  const sources = [
    path.join(renderer, 'views', 'OnboardingWizard.ts'),
    ...fs.readdirSync(path.join(renderer, 'tutorials'), { recursive: true })
      .filter((file) => file.endsWith('.ts'))
      .map((file) => path.join(renderer, 'tutorials', file)),
  ];
  const shots = new Set();
  for (const file of sources) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/shot: '([\w-]+)'|renderOnboardingShot\('([\w-]+)'/g)) shots.add(match[1] ?? match[2]);
  }
  assert.ok(shots.size > 10, 'the test should find the tutorial pictures');
  for (const shot of shots) {
    for (const language of ['pt-BR', 'en']) {
      const found = [`${shot}-${language}.png`, `${shot}.png`].some((name) => fs.existsSync(path.join(shotsDir, name)));
      assert.ok(found, `missing ${shot} for ${language}`);
    }
  }
});
