const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = path.resolve(__dirname, '..', 'src', 'renderer');

function stylesheets(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) return stylesheets(location);
    return entry.name.endsWith('.css') ? [location] : [];
  });
}

function properties(block) {
  return new Map([...block.matchAll(/(--motion-[a-z-]+)\s*:\s*([^;]+);/g)].map(match => [match[1], match[2].trim()]));
}

// A token the stylesheets use but theme.css never defines silently runs its fallback,
// so the motion keeps its duration even when the system asks for reduced motion (#490).
test('every motion token in the stylesheets is defined and stops under reduced motion', () => {
  const theme = fs.readFileSync(path.join(renderer, 'styles', 'theme.css'), 'utf8');
  const root = /:root\s*\{([^}]*)\}/.exec(theme)?.[1];
  const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(theme)?.[1];
  assert.ok(root && reduced, 'theme.css defines the motion tokens and their reduced-motion values');
  const defined = properties(root);
  const zeroed = properties(reduced);
  const used = new Map();
  for (const file of stylesheets(renderer)) {
    const css = fs.readFileSync(file, 'utf8');
    for (const match of css.matchAll(/var\((--motion-[a-z-]+)/g)) {
      const places = used.get(match[1]) ?? new Set();
      places.add(path.relative(renderer, file));
      used.set(match[1], places);
    }
  }
  assert.ok(used.size > 0, 'the stylesheets use the motion tokens');
  for (const [token, places] of used) {
    assert.ok(defined.has(token), `${token} (used in ${[...places].join(', ')}) is not defined in theme.css`);
    if (token.endsWith('-duration')) {
      assert.equal(zeroed.get(token), '0ms', `${token} must be 0ms with prefers-reduced-motion: reduce`);
    }
  }
});
