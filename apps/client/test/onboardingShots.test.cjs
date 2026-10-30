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

test('fixtures that run the real startup answer the identity calls it makes', () => {
  // Startup reads the identity before anything else; a fixture that misses one of these lands on the identity
  // onboarding instead of Home, as the screenshot script did after identity:has became identity:status.
  const main = fs.readFileSync(path.join(renderer, 'main.ts'), 'utf8');
  const calls = new Set([...main.matchAll(/window\.api\??\.(\w*Identity\w*)/g)].map((match) => match[1]));
  assert.ok(calls.has('getIdentityStatus'), 'startup asks for the identity status');
  const clientRoot = path.join(__dirname, '..');
  const fixtures = ['test', 'scripts']
    .flatMap((folder) => fs.readdirSync(path.join(clientRoot, folder), { recursive: true })
      .filter((file) => /\.(c|m)?js$/.test(file))
      .map((file) => path.join(clientRoot, folder, file)))
    .filter((file) => file !== __filename)
    .map((file) => ({ file, source: fs.readFileSync(file, 'utf8') }))
    // Fixtures that replace App.init skip the startup on purpose.
    .filter(({ source }) => source.includes("import('/main.ts')") && !/\.prototype\.init\s*=/.test(source));
  const names = fixtures.map(({ file }) => path.relative(clientRoot, file).replace(/\\/g, '/'));
  assert.ok(names.includes('scripts/capture-onboarding-screenshots.cjs') && names.includes('test/homeDiscordSmoke.cjs'),
    `the fixtures that run the startup were not found: ${names.join(', ')}`);
  for (const { file, source } of fixtures) {
    for (const call of calls) {
      assert.match(source, new RegExp(`\\b${call}\\s*:`), `${path.basename(file)} must answer window.api.${call}`);
    }
  }
});