const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = path.resolve(__dirname, '..', 'src', 'renderer');

function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) return sources(location);
    return /\.(css|ts)$/.test(entry.name) ? [location] : [];
  });
}

/** The declarations around `index`: its CSS block or its style attribute. */
function declarations(text, index) {
  const start = Math.max(text.lastIndexOf('{', index), text.lastIndexOf('"', index));
  const ends = [text.indexOf('}', index), text.indexOf('"', index)].filter(end => end >= 0);
  return text.slice(start + 1, Math.min(...ends));
}

// iOS Safari reads only -webkit-user-select: there, the app's global `* { user-select: none }` never
// applied, and dragging a channel on a phone selected the whole list's text.
test('every user-select has the WebKit twin iOS Safari reads', () => {
  const missing = [];
  let checked = 0;
  for (const file of sources(renderer)) {
    // Comments only talk about the rule; blanking them keeps every line number.
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, ' '));
    for (const match of text.matchAll(/(?<![-\w])user-select\s*:\s*([a-z]+)/g)) {
      checked++;
      const twin = new RegExp(`-webkit-user-select\\s*:\\s*${match[1]}\\b`);
      if (!twin.test(declarations(text, match.index))) {
        missing.push(`${path.relative(renderer, file)}:${text.slice(0, match.index).split('\n').length} user-select: ${match[1]}`);
      }
    }
  }
  assert.ok(checked > 0, 'the renderer declares user-select');
  assert.deepEqual(missing, [], 'declarations without -webkit-user-select');
});

// WebKit edits nothing under -webkit-user-select: none, so what is typed into stays selectable.
test('the global no-selection rule leaves fields and editors selectable in WebKit', () => {
  const base = fs.readFileSync(path.join(renderer, 'styles', 'base.css'), 'utf8');
  const rule = selector => new RegExp(`${selector.replace(/[[\]().*"]/g, '\\$&')}[^{]*\\{[^}]*-webkit-user-select:\\s*text`);
  assert.match(base, /\*\s*\{[^}]*-webkit-user-select:\s*none/, 'the global rule reaches WebKit');
  assert.match(base, rule('input:not([type="range"]):not([type="checkbox"]), textarea, select'), 'fields are selectable');
  assert.match(base, rule('[contenteditable]:not([contenteditable="false"]) *'), 'editors and their lines are selectable');
});
